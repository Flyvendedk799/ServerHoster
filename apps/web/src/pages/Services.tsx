import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { connectLogs } from "../lib/ws";

type Service = {
  id: string;
  name: string;
  type: string;
  status: string;
  project_id: string;
};

type Project = {
  id: string;
  name: string;
};

type LogEntry = {
  id?: string;
  service_id?: string;
  serviceId?: string;
  level?: string;
  message: string;
  timestamp?: string;
};

type EnvRow = { id: string; key: string; value: string; is_secret: number };

export function ServicesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [form, setForm] = useState({
    projectId: "",
    name: "",
    type: "process",
    command: "",
    workingDir: "",
    dockerImage: "",
    port: ""
  });
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [serviceEnv, setServiceEnv] = useState<EnvRow[]>([]);
  const [envForm, setEnvForm] = useState({ key: "", value: "", isSecret: false });
  const [composeContent, setComposeContent] = useState("");
  const [template, setTemplate] = useState("node-api");
  const [githubDeploy, setGithubDeploy] = useState({
    projectId: "",
    name: "",
    repoUrl: "",
    port: "",
    startAfterDeploy: true
  });
  const [deployStatus, setDeployStatus] = useState("");

  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);

  async function load(): Promise<void> {
    const [projectData, serviceData] = await Promise.all([api<Project[]>("/projects"), api<Service[]>("/services")]);
    setProjects(projectData);
    setServices(serviceData);
    if (!form.projectId && projectData.length > 0) {
      setForm((prev) => ({ ...prev, projectId: projectData[0].id }));
    }
    if (!githubDeploy.projectId && projectData.length > 0) {
      setGithubDeploy((prev) => ({ ...prev, projectId: projectData[0].id }));
    }
  }

  useEffect(() => {
    void load();
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) {
        return;
      }
      const typed = payload as { type?: string; message?: string };
      if (typed.type === "log") {
        setLogs((prev) => [payload as LogEntry, ...prev].slice(0, 300));
      }
      if (typed.type === "service_status") {
        void load();
      }
    });
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!selectedServiceId && services.length > 0) {
      setSelectedServiceId(services[0].id);
    }
  }, [services, selectedServiceId]);

  useEffect(() => {
    if (!selectedServiceId) return;
    void api<EnvRow[]>(`/services/${selectedServiceId}/env`).then(setServiceEnv);
  }, [selectedServiceId, services]);

  async function createProjectIfMissing(): Promise<void> {
    if (projects.length > 0) {
      return;
    }
    await api("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Default Project", description: "Auto-created project" })
    });
    await load();
  }

  async function createService(): Promise<void> {
    await createProjectIfMissing();
    await api("/services", {
      method: "POST",
      body: JSON.stringify({
        projectId: form.projectId || projects[0]?.id,
        name: form.name,
        type: form.type,
        command: form.command || undefined,
        workingDir: form.workingDir || undefined,
        dockerImage: form.dockerImage || undefined,
        port: form.port ? Number(form.port) : undefined
      })
    });
    setForm((prev) => ({ ...prev, name: "", command: "", workingDir: "", dockerImage: "", port: "" }));
    await load();
  }

  async function serviceAction(serviceId: string, action: "start" | "stop" | "restart"): Promise<void> {
    await api(`/services/${serviceId}/${action}`, { method: "POST" });
    await load();
  }

  async function importCompose(): Promise<void> {
    await api("/services/import-compose", {
      method: "POST",
      body: JSON.stringify({
        projectId: form.projectId || projects[0]?.id,
        composeContent
      })
    });
    await load();
  }

  async function createFromTemplate(): Promise<void> {
    await api("/projects/from-template", {
      method: "POST",
      body: JSON.stringify({
        template,
        name: `${template}-service`
      })
    });
    await load();
  }

  async function deployFromGithubLink(): Promise<void> {
    setDeployStatus("Deploying...");
    try {
      await api("/services/deploy-from-github", {
        method: "POST",
        body: JSON.stringify({
          projectId: githubDeploy.projectId || projects[0]?.id,
          name: githubDeploy.name,
          repoUrl: githubDeploy.repoUrl,
          port: githubDeploy.port ? Number(githubDeploy.port) : undefined,
          startAfterDeploy: githubDeploy.startAfterDeploy
        })
      });
      setDeployStatus("Deployment completed");
      setGithubDeploy((prev) => ({ ...prev, name: "", repoUrl: "", port: "" }));
      await load();
    } catch {
      setDeployStatus("Deployment failed");
    }
  }

  return (
    <section>
      <h2>Services</h2>
      <div className="card form">
        <h3>Create service</h3>
        <input
          placeholder="Service name"
          value={form.name}
          onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
        />
        <select value={form.type} onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value }))}>
          <option value="process">process</option>
          <option value="docker">docker</option>
          <option value="static">static</option>
        </select>
        <select value={form.projectId} onChange={(event) => setForm((prev) => ({ ...prev, projectId: event.target.value }))}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Command (process/static)"
          value={form.command}
          onChange={(event) => setForm((prev) => ({ ...prev, command: event.target.value }))}
        />
        <input
          placeholder="Working directory"
          value={form.workingDir}
          onChange={(event) => setForm((prev) => ({ ...prev, workingDir: event.target.value }))}
        />
        <input
          placeholder="Docker image"
          value={form.dockerImage}
          onChange={(event) => setForm((prev) => ({ ...prev, dockerImage: event.target.value }))}
        />
        <input
          placeholder="Port"
          value={form.port}
          onChange={(event) => setForm((prev) => ({ ...prev, port: event.target.value }))}
        />
        <button onClick={() => void createService()}>Create service</button>
      </div>
      <div className="card form">
        <h3>Deploy directly from GitHub repo</h3>
        <select value={githubDeploy.projectId} onChange={(event) => setGithubDeploy((prev) => ({ ...prev, projectId: event.target.value }))}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Service name"
          value={githubDeploy.name}
          onChange={(event) => setGithubDeploy((prev) => ({ ...prev, name: event.target.value }))}
        />
        <input
          placeholder="GitHub repo URL (https://github.com/org/repo.git)"
          value={githubDeploy.repoUrl}
          onChange={(event) => setGithubDeploy((prev) => ({ ...prev, repoUrl: event.target.value }))}
        />
        <input
          placeholder="Port (optional)"
          value={githubDeploy.port}
          onChange={(event) => setGithubDeploy((prev) => ({ ...prev, port: event.target.value }))}
        />
        <label>
          <input
            type="checkbox"
            checked={githubDeploy.startAfterDeploy}
            onChange={(event) => setGithubDeploy((prev) => ({ ...prev, startAfterDeploy: event.target.checked }))}
          />
          Start service after successful deploy
        </label>
        <button onClick={() => void deployFromGithubLink()}>Deploy from GitHub</button>
        <p>{deployStatus}</p>
      </div>
      <div className="card form">
        <h3>Quick project template</h3>
        <select value={template} onChange={(event) => setTemplate(event.target.value)}>
          <option value="node-api">node-api</option>
          <option value="python-api">python-api</option>
          <option value="static-site">static-site</option>
        </select>
        <button onClick={() => void createFromTemplate()}>Create from template</button>
      </div>
      <div className="card form">
        <h3>Import docker compose</h3>
        <textarea
          placeholder="Paste docker-compose.yml content"
          value={composeContent}
          onChange={(event) => setComposeContent(event.target.value)}
          rows={10}
        />
        <button onClick={() => void importCompose()}>Import compose services</button>
      </div>
      <div className="card form">
        <h3>Service env vars</h3>
        <select value={selectedServiceId} onChange={(event) => setSelectedServiceId(event.target.value)}>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
        <input placeholder="Key" value={envForm.key} onChange={(event) => setEnvForm((prev) => ({ ...prev, key: event.target.value }))} />
        <input placeholder="Value" value={envForm.value} onChange={(event) => setEnvForm((prev) => ({ ...prev, value: event.target.value }))} />
        <label>
          <input
            type="checkbox"
            checked={envForm.isSecret}
            onChange={(event) => setEnvForm((prev) => ({ ...prev, isSecret: event.target.checked }))}
          />
          Secret
        </label>
        <button
          onClick={() =>
            void (async () => {
              if (!selectedServiceId) return;
              await api(`/services/${selectedServiceId}/env`, {
                method: "POST",
                body: JSON.stringify(envForm)
              });
              setEnvForm({ key: "", value: "", isSecret: false });
              const rows = await api<EnvRow[]>(`/services/${selectedServiceId}/env`);
              setServiceEnv(rows);
            })()
          }
        >
          Add env var
        </button>
        <div>
          {serviceEnv.map((row) => (
            <div key={row.id} className="row">
              <span>
                {row.key}={row.value}
              </span>
              <button
                onClick={() =>
                  void (async () => {
                    await api(`/services/${selectedServiceId}/env/${row.id}`, { method: "DELETE" });
                    const rows = await api<EnvRow[]>(`/services/${selectedServiceId}/env`);
                    setServiceEnv(rows);
                  })()
                }
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="grid">
        {services.map((service) => (
          <div key={service.id} className="card">
            <h3>{service.name}</h3>
            <p>Type: <span className="chip">{service.type}</span></p>
            <p>Status: <span className={`chip status-${service.status}`}>{service.status}</span></p>
            <p>Project: {projectMap.get(service.project_id) ?? "Unknown"}</p>
            <div className="row">
              <button onClick={() => void serviceAction(service.id, "start")}>Start</button>
              <button onClick={() => void serviceAction(service.id, "stop")}>Stop</button>
              <button onClick={() => void serviceAction(service.id, "restart")}>Restart</button>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Live logs</h3>
        <div className="logs">
          {logs.map((log, index) => (
            <p key={`${log.timestamp ?? "ts"}-${index}`}>
              [{log.level ?? "info"}] {log.message}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
