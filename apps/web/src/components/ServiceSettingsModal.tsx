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
  const [databases, setDatabases] = useState<Database[]>([]);
  const [otherServices, setOtherServices] = useState<AllService[]>([]);

  useEffect(() => {
    void Promise.all([
      api<AllService[]>("/services", { silent: true }),
      api<Database[]>("/databases", { silent: true })
    ])
      .then(([svcs, dbs]) => {
        setOtherServices(svcs.filter((s) => s.id !== service.id && s.project_id === service.project_id));
        setDatabases(dbs);
      })
      .catch(() => undefined);
  }, [service.id, service.project_id]);

  async function save() {
    setLoading(true);
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
      toast.success("Settings updated");
      onUpdated();
      onClose();
    } catch {
      /* toasted */
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: "600px" }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Service Settings</h3>
          <p className="hint">
            Configuring <span style={{ color: "var(--accent-light)" }}>{service.name}</span>
          </p>
        </header>

        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label>Service Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Runtime Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="process">Binary Process</option>
                <option value="docker">Docker Image</option>
                <option value="static">Static Web</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Environment</label>
              <select
                value={form.environment}
                onChange={(e) => setForm({ ...form, environment: e.target.value as any })}
              >
                <option value="production">Production</option>
                <option value="staging">Staging</option>
                <option value="development">Development</option>
              </select>
            </div>
            <div className="form-group">
              <label>Internal Port</label>
              <input
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                placeholder="3000"
              />
            </div>
          </div>

          <div className="form-group">
            <label>Custom Domain</label>
            <input
              value={form.domain}
              onChange={(e) => setForm({ ...form, domain: e.target.value })}
              placeholder="app.myserver.com"
            />
          </div>

          <div className="form-group">
            <label>Start Command</label>
            <input
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
              placeholder="npm run start"
            />
          </div>

          <div className="form-group">
            <label>Database Link</label>
            <select
              value={form.linkedDatabaseId}
              onChange={(e) => setForm({ ...form, linkedDatabaseId: e.target.value })}
            >
              <option value="">— No active link —</option>
              {databases.map((db) => (
                <option key={db.id} value={db.id}>
                  {db.name} ({db.engine})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Dependencies (Start Priority)</label>
            <div className="row wrap" style={{ gap: "0.5rem", marginTop: "0.25rem" }}>
              {otherServices.length === 0 && (
                <span className="muted tiny">No other project services found.</span>
              )}
              {otherServices.map((s) => (
                <button
                  key={s.id}
                  className={`ghost xsmall ${form.dependsOn.includes(s.id) ? "active-chip" : ""}`}
                  onClick={() => toggleDep(s.id)}
                  style={{
                    borderRadius: "var(--radius-full)",
                    padding: "0.3rem 0.8rem",
                    border: "1px solid var(--border-default)"
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={loading}>
            Discard
          </button>
          <button className="primary" onClick={save} disabled={loading}>
            {loading ? "Saving..." : "Save Settings"}
          </button>
        </footer>

        <style
          dangerouslySetInnerHTML={{
            __html: `
          .active-chip { background: var(--accent-gradient) !important; color: white !important; border-color: transparent !important; }
        `
          }}
        />
      </div>
    </div>
  );
}
