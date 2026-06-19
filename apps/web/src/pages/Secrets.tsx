import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Share2,
  Trash2
} from "lucide-react";
import { api } from "../lib/api";
import { confirmDialog } from "../lib/confirm";
import {
  deleteServiceSecret,
  deleteSharedSecret,
  listSecrets,
  promoteServiceSecret,
  upsertServiceSecret,
  upsertSharedSecret,
  type SecretInventoryItem,
  type SecretLinkedService,
  type SecretScope
} from "../lib/resources";
import { toast } from "../lib/toast";
import { Skeleton } from "../components/ui/Skeleton";

type Project = { id: string; name: string };
type Service = { id: string; name: string; status: string; project_id: string | null };

type RedeployNotice = {
  message: string;
  services: SecretLinkedService[];
};

function scopeLabel(scope: SecretScope): string {
  return scope === "shared" ? "Shared" : "Service";
}

function scopeIcon(scope: SecretScope) {
  return scope === "shared" ? <Share2 size={14} /> : <Server size={14} />;
}

function summarizeServices(services: SecretLinkedService[]): string {
  if (services.length === 0) return "No linked services";
  const names = services.slice(0, 3).map((service) => service.name);
  const extra = services.length - names.length;
  return `${names.join(", ")}${extra > 0 ? ` +${extra} more` : ""}`;
}

export function SecretsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [secrets, setSecrets] = useState<SecretInventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [scope, setScope] = useState<SecretScope>("shared");
  const [projectId, setProjectId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<RedeployNotice | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [secretData, projectData, serviceData] = await Promise.all([
        listSecrets({ silent: true }),
        api<Project[]>("/projects", { silent: true }),
        api<Service[]>("/services", { silent: true })
      ]);
      setSecrets(secretData.secrets);
      setProjects(projectData);
      setServices(serviceData);
      setProjectId((current) => current || projectData[0]?.id || "");
      setServiceId((current) => current || serviceData[0]?.id || "");
    } catch {
      /* toasted by foreground actions; this load is silent */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const grouped = useMemo(() => {
    const shared = secrets.filter((secret) => secret.scope === "shared");
    const service = secrets.filter((secret) => secret.scope === "service");
    return { shared, service };
  }, [secrets]);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      toast.error("Secret key is required");
      return;
    }
    if (!value) {
      toast.error("Secret value is required");
      return;
    }
    if (scope === "shared" && !projectId) {
      toast.error("Choose a project for the shared secret");
      return;
    }
    if (scope === "service" && !serviceId) {
      toast.error("Choose a service for the secret");
      return;
    }

    setBusyKey("save");
    try {
      const result =
        scope === "shared"
          ? await upsertSharedSecret({ projectId, key: trimmedKey, value })
          : await upsertServiceSecret({ serviceId, key: trimmedKey, value });
      toast.success(scope === "shared" ? "Shared secret saved" : "Service secret saved");
      toast.warning(result.message);
      setNotice({ message: result.message, services: result.affected_services });
      setKey("");
      setValue("");
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function promote(secret: SecretInventoryItem): Promise<void> {
    if (secret.scope !== "service") return;
    setBusyKey(`promote:${secret.id}`);
    try {
      const result = await promoteServiceSecret({
        serviceEnvId: secret.id,
        projectId: secret.project_id ?? undefined
      });
      toast.success(`${secret.key} copied to shared secrets`);
      toast.warning(result.message);
      setNotice({ message: result.message, services: result.affected_services });
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(secret: SecretInventoryItem): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete ${secret.key}?`,
      message:
        secret.scope === "shared"
          ? `Removes this shared secret from ${secret.project_name ?? "the project"}. Linked services need a redeploy before the deletion is live.`
          : `Removes this secret from ${secret.service_name ?? "the service"}. The service needs a redeploy before the deletion is live.`,
      danger: true,
      confirmLabel: "Delete"
    });
    if (!ok) return;

    setBusyKey(`delete:${secret.id}`);
    try {
      const result =
        secret.scope === "shared"
          ? await deleteSharedSecret(secret.id)
          : await deleteServiceSecret(secret.id);
      toast.warning(result.message);
      setNotice({ message: result.message, services: result.affected_services });
      await load();
    } catch {
      /* toasted */
    } finally {
      setBusyKey(null);
    }
  }

  function renderSecret(secret: SecretInventoryItem) {
    const busy = busyKey?.endsWith(secret.id) ?? false;
    return (
      <article key={secret.id} className="secret-row">
        <div className="secret-main">
          <div className="secret-key-row">
            <code>{secret.key}</code>
            <span className={`chip xsmall ${secret.scope === "shared" ? "shared-secret-chip" : ""}`}>
              {scopeIcon(secret.scope)}
              {scopeLabel(secret.scope)}
            </span>
            {secret.system && <span className="chip xsmall">System</span>}
          </div>
          <div className="muted small">
            {secret.scope === "shared"
              ? secret.project_name ?? "Project secret"
              : `${secret.service_name ?? "Service secret"}${secret.project_name ? ` in ${secret.project_name}` : ""}`}
          </div>
          <div className="secret-preview">{secret.value_preview}</div>
        </div>

        <div className="secret-links">
          <span className="tiny uppercase font-bold">Linked services</span>
          <span className="small">{summarizeServices(secret.linked_services)}</span>
          {secret.linked_services.length > 0 && (
            <div className="secret-linked-list">
              {secret.linked_services.slice(0, 4).map((service) => (
                <span key={service.id} className="chip xsmall warn-chip">
                  <RotateCw size={12} />
                  {service.name}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="secret-actions">
          {secret.scope === "service" && !secret.system && secret.project_id && (
            <button
              className="ghost xsmall"
              onClick={() => void promote(secret)}
              disabled={busy}
              data-tooltip="Copy this secret into shared project secrets"
            >
              {busyKey === `promote:${secret.id}` ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Share2 size={14} />
              )}
              Add to shared
            </button>
          )}
          <button
            className="ghost xsmall text-danger"
            onClick={() => void remove(secret)}
            disabled={busy || secret.system}
            data-tooltip={secret.system ? "System-managed secrets cannot be deleted here" : "Delete secret"}
          >
            {busyKey === `delete:${secret.id}` ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
            Delete
          </button>
        </div>
      </article>
    );
  }

  return (
    <div className="secrets-page">
      <header className="page-header">
        <div>
          <div className="page-title">Secrets</div>
          <p className="muted">Manage service and shared project secrets from one place.</p>
        </div>
        <button className="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </header>

      {notice && (
        <section className="alert alert-amber secrets-redeploy-alert" role="status">
          <AlertTriangle size={18} />
          <div>
            <div className="alert-title">Redeploy required</div>
            <p className="small muted">{notice.message}</p>
            <p className="small">
              {notice.services.length > 0
                ? `Affected: ${summarizeServices(notice.services)}`
                : "No running service link was found for this change."}
            </p>
          </div>
        </section>
      )}

      <section className="secrets-shell">
        <form className="secret-add-panel" onSubmit={(event) => void save(event)}>
          <div className="section-title">
            <div className="row">
              <Plus size={17} />
              <h3>Add Secret</h3>
            </div>
          </div>

          <label className="field">
            <span>Scope</span>
            <div className="secret-scope-toggle">
              <button
                type="button"
                className={`ghost ${scope === "shared" ? "active" : ""}`}
                onClick={() => setScope("shared")}
              >
                <Share2 size={14} />
                Shared
              </button>
              <button
                type="button"
                className={`ghost ${scope === "service" ? "active" : ""}`}
                onClick={() => setScope("service")}
              >
                <Server size={14} />
                Service
              </button>
            </div>
          </label>

          {scope === "shared" ? (
            <label className="field">
              <span>Project</span>
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span>Service</span>
              <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>Key</span>
            <input
              value={key}
              onChange={(event) => setKey(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
              placeholder="PLATFORM_API_KEY"
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span>Value</span>
            <input
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Paste secret value"
              autoComplete="off"
            />
          </label>

          <button className="primary" type="submit" disabled={busyKey === "save"}>
            {busyKey === "save" ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
            Save Secret
          </button>
        </form>

        <section className="secret-inventory">
          {loading ? (
            <div className="secret-loading">
              <Skeleton style={{ height: "1.2rem", width: "55%", marginBottom: "0.75rem" }} />
              <Skeleton style={{ height: "4rem", width: "100%", marginBottom: "0.75rem" }} />
              <Skeleton style={{ height: "4rem", width: "100%" }} />
            </div>
          ) : (
            <>
              <div className="secret-group">
                <div className="secret-group-head">
                  <div>
                    <h3>Shared Secrets</h3>
                    <p className="muted small">Project-level secrets linked into services at runtime.</p>
                  </div>
                  <span className="chip xsmall">{grouped.shared.length}</span>
                </div>
                {grouped.shared.length === 0 ? (
                  <div className="secret-empty">No shared secrets yet.</div>
                ) : (
                  grouped.shared.map(renderSecret)
                )}
              </div>

              <div className="secret-group">
                <div className="secret-group-head">
                  <div>
                    <h3>Service Secrets</h3>
                    <p className="muted small">Overrides that apply to one service only.</p>
                  </div>
                  <span className="chip xsmall">{grouped.service.length}</span>
                </div>
                {grouped.service.length === 0 ? (
                  <div className="secret-empty">No service secrets yet.</div>
                ) : (
                  grouped.service.map(renderSecret)
                )}
              </div>
            </>
          )}
        </section>
      </section>

      <style>{`
        .secrets-page {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .secrets-redeploy-alert {
          display: flex;
          align-items: flex-start;
          gap: 0.75rem;
        }
        .secrets-redeploy-alert p {
          margin: 0.2rem 0 0;
        }
        .secrets-shell {
          display: grid;
          grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
          gap: 1rem;
          align-items: start;
        }
        .secret-add-panel {
          display: flex;
          flex-direction: column;
          gap: 0.9rem;
          padding: 1rem;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          background: var(--bg-card);
        }
        .secret-scope-toggle {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 0.5rem;
        }
        .secret-scope-toggle button {
          justify-content: center;
          border: 1px solid var(--border-subtle);
          background: var(--bg-card);
        }
        .secret-scope-toggle button.active {
          border-color: var(--accent);
          color: var(--text-primary);
          background: color-mix(in srgb, var(--accent) 12%, transparent);
        }
        .secret-inventory,
        .secret-group {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .secret-group {
          padding: 1rem;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          background: var(--bg-card);
        }
        .secret-group-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
        }
        .secret-group-head h3 {
          margin: 0;
        }
        .secret-group-head p {
          margin: 0.25rem 0 0;
        }
        .secret-row {
          display: grid;
          grid-template-columns: minmax(180px, 1.2fr) minmax(180px, 1fr) auto;
          gap: 1rem;
          align-items: center;
          padding: 0.85rem;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          background: var(--bg-elevated);
        }
        .secret-main,
        .secret-links,
        .secret-actions {
          min-width: 0;
        }
        .secret-key-row,
        .secret-linked-list,
        .secret-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.4rem;
          align-items: center;
        }
        .secret-key-row code {
          overflow-wrap: anywhere;
        }
        .secret-preview {
          margin-top: 0.45rem;
          color: var(--text-muted);
          font-family: var(--font-mono, monospace);
          font-size: 0.78rem;
        }
        .secret-links {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
        }
        .secret-actions {
          justify-content: flex-end;
        }
        .secret-empty,
        .secret-loading {
          padding: 1rem;
          border: 1px dashed var(--border-subtle);
          border-radius: var(--radius-sm);
          color: var(--text-muted);
        }
        .shared-secret-chip {
          color: var(--accent);
        }
        @media (max-width: 980px) {
          .secrets-shell,
          .secret-row {
            grid-template-columns: 1fr;
          }
          .secret-actions {
            justify-content: flex-start;
          }
        }
      `}</style>
    </div>
  );
}
