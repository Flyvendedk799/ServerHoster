import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound, Loader2, RotateCw, Share2, Server, FileText } from "lucide-react";
import { toast } from "../lib/toast";
import { useModalA11y } from "../lib/useModalA11y";
import {
  upsertServiceSecret,
  upsertSharedSecret,
  bulkUpsertServiceEnv,
  type SecretMutationResponse,
  type SecretScope
} from "../lib/resources";

type ServiceLike = {
  id: string;
  name: string;
  project_id?: string | null;
};

type Props = {
  service: ServiceLike;
  initialKey?: string;
  onClose: () => void;
  onSaved?: (result: SecretMutationResponse) => void;
};

type Mode = "single" | "bulk";

export function ServiceSecretModal({ service, initialKey = "", onClose, onSaved }: Props) {
  const [mode, setMode] = useState<Mode>("single");
  const [scope, setScope] = useState<SecretScope>(service.project_id ? "shared" : "service");
  const [key, setKey] = useState(initialKey);
  const [value, setValue] = useState("");
  const [bulk, setBulk] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, { onClose, onSubmit: () => void save() });

  useEffect(() => {
    setKey(initialKey);
  }, [initialKey]);

  useEffect(() => {
    setScope(service.project_id ? "shared" : "service");
  }, [service.id, service.project_id]);

  async function save(event?: FormEvent): Promise<void> {
    event?.preventDefault();

    if (mode === "bulk") {
      if (!bulk.trim()) {
        toast.error("Paste your .env contents first");
        return;
      }
      setBusy(true);
      try {
        const result = await bulkUpsertServiceEnv(service.id, bulk);
        toast.success(
          `Imported ${result.created + result.updated} env var(s)` +
            (result.skipped ? `, skipped ${result.skipped} platform-managed` : "")
        );
        toast.warning(result.message);
        // Callers use onSaved only to refresh the list; the payload is ignored.
        onSaved?.(result as unknown as SecretMutationResponse);
        onClose();
      } catch {
        /* toasted */
      } finally {
        setBusy(false);
      }
      return;
    }

    const trimmedKey = key.trim();
    if (!trimmedKey) {
      toast.error("Secret key is required");
      return;
    }
    if (!value) {
      toast.error("Secret value is required");
      return;
    }
    if (scope === "shared" && !service.project_id) {
      toast.error("This service is not attached to a project");
      return;
    }

    setBusy(true);
    try {
      const result =
        scope === "shared"
          ? await upsertSharedSecret({
              projectId: service.project_id ?? "",
              key: trimmedKey,
              value
            })
          : await upsertServiceSecret({
              serviceId: service.id,
              key: trimmedKey,
              value
            });
      toast.success(scope === "shared" ? "Shared secret saved" : "Service secret saved");
      toast.warning(result.message);
      onSaved?.(result);
      onClose();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  }

  const sharedDisabled = !service.project_id;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal-content service-secret-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="service-secret-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="row" style={{ gap: "0.65rem", alignItems: "center" }}>
            <KeyRound size={18} />
            <div>
              <h3 id="service-secret-modal-title">Add Secret</h3>
              <p className="muted small" style={{ margin: "0.25rem 0 0" }}>
                {service.name}
              </p>
            </div>
          </div>
        </header>

        <form onSubmit={(event) => void save(event)}>
          <div className="modal-body">
            <div className="alert alert-amber" role="status">
              <RotateCw size={16} />
              <div>
                <div className="alert-title">Redeploy required after saving</div>
                <div className="small muted">
                  New or changed secrets are stored immediately, but running services keep their old
                  environment until they restart or redeploy.
                </div>
              </div>
            </div>

            <label className="field">
              <span>Mode</span>
              <div className="secret-scope-toggle">
                <button
                  type="button"
                  className={`ghost ${mode === "single" ? "active" : ""}`}
                  onClick={() => setMode("single")}
                >
                  <KeyRound size={14} />
                  Single
                </button>
                <button
                  type="button"
                  className={`ghost ${mode === "bulk" ? "active" : ""}`}
                  onClick={() => setMode("bulk")}
                >
                  <FileText size={14} />
                  Paste .env
                </button>
              </div>
            </label>

            {mode === "single" ? (
              <>
                <label className="field">
                  <span>Scope</span>
                  <div className="secret-scope-toggle">
                    <button
                      type="button"
                      className={`ghost ${scope === "service" ? "active" : ""}`}
                      onClick={() => setScope("service")}
                    >
                      <Server size={14} />
                      Service
                    </button>
                    <button
                      type="button"
                      className={`ghost ${scope === "shared" ? "active" : ""}`}
                      disabled={sharedDisabled}
                      title={sharedDisabled ? "This service has no project for shared secrets" : undefined}
                      onClick={() => setScope("shared")}
                    >
                      <Share2 size={14} />
                      Shared
                    </button>
                  </div>
                </label>

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

                <p className="muted small" style={{ margin: 0 }}>
                  {scope === "shared"
                    ? "Shared secrets are available to every service in this project unless a service-level env var overrides them."
                    : "Service secrets only apply to this service and override shared project values with the same key."}
                </p>
              </>
            ) : (
              <>
                <label className="field">
                  <span>.env contents</span>
                  <textarea
                    className="bulk-env-input"
                    value={bulk}
                    onChange={(event) => setBulk(event.target.value)}
                    placeholder={"KEY=value\nANOTHER_KEY=another value\n# comments and blank lines are ignored"}
                    spellCheck={false}
                    rows={10}
                    autoComplete="off"
                  />
                </label>
                <p className="muted small" style={{ margin: 0 }}>
                  Paste a whole <code>.env</code> file — every <code>KEY=VALUE</code> line is imported as a
                  service secret at once. Comments (<code>#</code>), blank lines, and surrounding quotes are
                  handled. Existing keys are updated; ServerHoster-managed keys are skipped.
                </p>
              </>
            )}
          </div>

          <footer className="modal-footer">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
              {mode === "bulk" ? "Import .env" : "Save Secret"}
            </button>
          </footer>
        </form>

        <style>{`
          .service-secret-modal .alert {
            display: flex;
            gap: 0.75rem;
            align-items: flex-start;
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
          .bulk-env-input {
            width: 100%;
            resize: vertical;
            font-family: var(--font-mono, ui-monospace, monospace);
            font-size: 0.85rem;
            line-height: 1.4;
          }
        `}</style>
      </div>
    </div>
  );
}
