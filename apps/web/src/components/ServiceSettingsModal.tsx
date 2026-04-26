import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";

type Service = {
  id: string;
  name: string;
  type: string;
  status: string;
  project_id: string;
  domain?: string;
  port?: number;
  command?: string;
  working_dir?: string;
  environment?: string;
  depends_on?: string | null;
  linked_database_id?: string | null;
};

type Database = { id: string; name: string; engine: string };
type AllService = { id: string; name: string; project_id: string };

type Props = {
  service: Service;
  onClose: () => void;
  onUpdated: () => void;
};

function parseDependsOn(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function ServiceSettingsModal({ service, onClose, onUpdated }: Props) {
  const [form, setForm] = useState({
    name: service.name,
    domain: service.domain || "",
    port: String(service.port || ""),
    command: service.command || "",
    workingDir: service.working_dir || "",
    type: service.type,
    environment: (service.environment as "production" | "staging" | "development") ?? "production",
    dependsOn: parseDependsOn(service.depends_on ?? null),
    linkedDatabaseId: service.linked_database_id ?? ""
  });
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [otherServices, setOtherServices] = useState<AllService[]>([]);
  const [databases, setDatabases] = useState<Database[]>([]);

  useEffect(() => {
    void Promise.all([
      api<AllService[]>("/services", { silent: true }),
      api<Database[]>("/databases", { silent: true })
    ]).then(([svcs, dbs]) => {
      setOtherServices(svcs.filter((s) => s.id !== service.id && s.project_id === service.project_id));
      setDatabases(dbs);
    }).catch(() => undefined);
  }, [service.id, service.project_id]);

  async function save() {
    setLoading(true);
    setFieldErrors({});
    try {
      await api(`/services/${service.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          command: form.command,
          workingDir: form.workingDir,
          port: form.port ? Number(form.port) : undefined,
          domain: form.domain || undefined,
          environment: form.environment,
          dependsOn: form.dependsOn,
          linkedDatabaseId: form.linkedDatabaseId || null
        })
      });
      toast.success("Service settings saved");
      onUpdated();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Attempt to parse the validation error fields bag
      try {
        const parsed = JSON.parse(msg) as { fields?: Record<string, string> };
        if (parsed.fields) setFieldErrors(parsed.fields);
      } catch {
        /* non-JSON error, already toasted by api() */
      }
    } finally {
      setLoading(false);
    }
  }

  function toggleDep(id: string): void {
    setForm((prev) => ({
      ...prev,
      dependsOn: prev.dependsOn.includes(id)
        ? prev.dependsOn.filter((x) => x !== id)
        : [...prev.dependsOn, id]
    }));
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings: {service.name}</h3>
        <div className="form">
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />

          <label>Type</label>
          <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
            <option value="process">process</option>
            <option value="docker">docker</option>
            <option value="static">static</option>
          </select>

          <label>Environment</label>
          <select
            value={form.environment}
            onChange={(e) => setForm((f) => ({ ...f, environment: e.target.value as "production" | "staging" | "development" }))}
          >
            <option value="production">production</option>
            <option value="staging">staging</option>
            <option value="development">development</option>
          </select>

          <label>Domain (Optional)</label>
          <input value={form.domain} onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))} placeholder="myapp.com" />
          {fieldErrors.domain && <div style={{ color: "var(--danger)", fontSize: "0.8rem" }}>{fieldErrors.domain}</div>}

          <label>Internal Port</label>
          <input value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} placeholder="3000" />
          {fieldErrors.port && <div style={{ color: "var(--danger)", fontSize: "0.8rem" }}>{fieldErrors.port}</div>}

          <label>Command</label>
          <input value={form.command} onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))} placeholder="npm start" />

          <label>Working Directory</label>
          <input value={form.workingDir} onChange={(e) => setForm((f) => ({ ...f, workingDir: e.target.value }))} />
          {fieldErrors.workingDir && <div style={{ color: "var(--danger)", fontSize: "0.8rem" }}>{fieldErrors.workingDir}</div>}

          <label>Linked database</label>
          <select
            value={form.linkedDatabaseId}
            onChange={(e) => setForm((f) => ({ ...f, linkedDatabaseId: e.target.value }))}
          >
            <option value="">— none —</option>
            {databases.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.engine})
              </option>
            ))}
          </select>

          <label>Depends on (starts these first)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
            {otherServices.length === 0 && (
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                No other services in this project.
              </span>
            )}
            {otherServices.map((s) => (
              <label
                key={s.id}
                style={{
                  fontSize: "0.8rem",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.25rem 0.5rem",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "999px",
                  cursor: "pointer",
                  background: form.dependsOn.includes(s.id) ? "var(--accent-soft)" : "transparent"
                }}
              >
                <input
                  type="checkbox"
                  checked={form.dependsOn.includes(s.id)}
                  onChange={() => toggleDep(s.id)}
                  style={{ width: "auto" }}
                />
                {s.name}
              </label>
            ))}
          </div>

          <div className="row" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
            <button className="btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
            <button onClick={() => void save()} disabled={loading}>
              {loading ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
