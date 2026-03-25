import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Deployment = {
  id: string;
  service_id: string;
  commit_hash: string;
  status: string;
  build_log: string;
  created_at: string;
};

type Service = { id: string; name: string };

export function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [form, setForm] = useState({ serviceId: "", repoUrl: "" });

  async function load(): Promise<void> {
    const [d, s] = await Promise.all([api<Deployment[]>("/deployments"), api<Service[]>("/services")]);
    setDeployments(d);
    setServices(s);
    if (!form.serviceId && s.length > 0) {
      setForm((prev) => ({ ...prev, serviceId: s[0].id }));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function deploy(): Promise<void> {
    await api("/deployments/from-git", {
      method: "POST",
      body: JSON.stringify(form)
    });
    await load();
  }

  async function rollback(deploymentId: string, serviceId: string): Promise<void> {
    await api("/deployments/rollback", {
      method: "POST",
      body: JSON.stringify({ deploymentId, serviceId })
    });
    await load();
  }

  return (
    <section>
      <h2>Deployments</h2>
      <div className="card form">
        <h3>Deploy from git</h3>
        <select value={form.serviceId} onChange={(event) => setForm((prev) => ({ ...prev, serviceId: event.target.value }))}>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
        <input
          value={form.repoUrl}
          onChange={(event) => setForm((prev) => ({ ...prev, repoUrl: event.target.value }))}
          placeholder="https://github.com/org/repo.git"
        />
        <button onClick={() => void deploy()}>Deploy</button>
      </div>

      <div className="grid">
        {deployments.map((deployment) => (
          <div key={deployment.id} className="card">
            <h3>{deployment.status}</h3>
            <p>Service: {services.find((service) => service.id === deployment.service_id)?.name ?? deployment.service_id}</p>
            <p>Commit: {deployment.commit_hash || "-"}</p>
            <pre>{deployment.build_log}</pre>
            <button onClick={() => void rollback(deployment.id, deployment.service_id)}>Rollback to this deploy</button>
          </div>
        ))}
      </div>
    </section>
  );
}
