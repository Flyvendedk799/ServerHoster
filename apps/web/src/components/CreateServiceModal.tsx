import { useRef, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { useModalA11y } from "../lib/useModalA11y";

type Props = {
  projects: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: () => void;
};

export function CreateServiceModal({ projects, onClose, onCreated }: Props) {
  const [form, setForm] = useState({
    projectId: "",
    name: "",
    type: "process" as "process" | "docker" | "static",
    command: "",
    workingDir: "",
    image: "",
    port: "",
    enableQuickTunnel: false
  });
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const imageRequired = form.type === "docker";
  const commandRequired = form.type !== "docker";
  const imageMissing = imageRequired && !form.image.trim();
  const commandMissing = commandRequired && !form.command.trim();
  const canSubmit = !!form.name.trim() && !imageMissing && !commandMissing;

  useModalA11y(ref, { onClose, onSubmit: handleSubmit });

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Service name is required");
      return;
    }
    if (imageMissing) {
      toast.error("Image reference is required");
      return;
    }
    if (commandMissing) {
      toast.error("Start command is required");
      return;
    }
    setLoading(true);
    try {
      await api("/services", {
        method: "POST",
        body: JSON.stringify({
          projectId: form.projectId,
          name: form.name,
          type: form.type,
          command: form.command || undefined,
          workingDir: form.workingDir || undefined,
          image: form.image || undefined,
          port: form.port ? Number(form.port) : undefined,
          quickTunnelEnabled: form.enableQuickTunnel ? 1 : 0
        })
      });
      toast.success(`Service "${form.name}" created`);
      onCreated();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-service-title"
        style={{ maxWidth: "540px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3 id="create-service-title">Create New Service</h3>
          <p className="hint">Manually configure or deploy a custom runtime.</p>
        </header>

        <div className="modal-body">
          <div className="form-group">
            <label>Target Project</label>
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">Auto: create or reuse app project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>
                Service Name <span className="required">*</span>
              </label>
              <input
                placeholder="e.g. my-api"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="form-group" style={{ maxWidth: "120px" }}>
              <label>
                Port <span className="optional">(opt)</span>
              </label>
              <input
                placeholder="8080"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
              />
            </div>
          </div>

          <div className="form-group">
            <label>Deployment Type</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as any })}>
              <option value="process">Binary / Script Process</option>
              <option value="docker">Docker Image</option>
              <option value="static">Static Web Folder</option>
            </select>
          </div>

          {form.type === "docker" ? (
            <div className="form-group">
              <label>
                Image Reference <span className="required">*</span>
              </label>
              <input
                placeholder="e.g. nginx:latest"
                value={form.image}
                aria-invalid={imageMissing || undefined}
                onChange={(e) => setForm({ ...form, image: e.target.value })}
              />
              {imageMissing && <span className="field-hint error">Image reference is required.</span>}
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>
                  Start Command <span className="required">*</span>
                </label>
                <input
                  placeholder={form.type === "static" ? "e.g. serve -s dist" : "e.g. node index.js"}
                  value={form.command}
                  aria-invalid={commandMissing || undefined}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                />
                {commandMissing && <span className="field-hint error">Start command is required.</span>}
              </div>
              <div className="form-group">
                <label>
                  Working Dir <span className="optional">(opt)</span>
                </label>
                <input
                  placeholder="/var/www/app"
                  value={form.workingDir}
                  onChange={(e) => setForm({ ...form, workingDir: e.target.value })}
                />
              </div>
            </>
          )}

          <label className="toggle-group">
            <input
              type="checkbox"
              checked={form.enableQuickTunnel}
              onChange={(e) => setForm({ ...form, enableQuickTunnel: e.target.checked })}
            />
            <div className="toggle-info">
              <span className="toggle-title">Enable public tunnel</span>
              <span className="toggle-desc">Generate an external Cloudflare URL instantly</span>
            </div>
          </label>
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button className="primary" onClick={handleSubmit} disabled={loading || !canSubmit}>
            {loading ? "Creating..." : "Launch Service"}
          </button>
        </footer>
      </div>
    </div>
  );
}
