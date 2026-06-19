import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  ExternalLink,
  FileCode2,
  KeyRound,
  Link2,
  Loader2,
  Play,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
  UserPlus
} from "lucide-react";
import { confirmDialog } from "../lib/confirm";
import { toast } from "../lib/toast";
import { connectLogs } from "../lib/ws";
import { StatusBadge } from "./StatusBadge";
import { InfoHint } from "./ui/InfoHint";
import { ResourceBootstrapModal } from "./ResourceProvisionModal";
import {
  getResourceEnvRequirements,
  getResourceLogs,
  listResources,
  removeResource,
  resourceAction,
  resourceConfigString,
  updateResourceSecrets,
  type EnvRequirementsResponse,
  type ManagedResourceDetail
} from "../lib/resources";

type ServiceRef = { id: string; name: string };

type Props = {
  services: ServiceRef[];
  /** Bumped by the parent to force a reload (e.g. after a provision). */
  reloadKey?: number;
};

type ConsoleTab = "functions" | "secrets" | "logs";
type LogSource = "all" | "containers" | "functions";

/**
 * "Stacks" section for the Databases page: rich resources (local Supabase)
 * with status, URLs, linked services, Edge Function health, secrets manager,
 * logs and bootstrap — deliberately NOT rendered as plain databases.
 */
export function ResourceStacks({ services, reloadKey = 0 }: Props) {
  const [resources, setResources] = useState<ManagedResourceDetail[]>([]);
  const [requirements, setRequirements] = useState<Record<string, EnvRequirementsResponse>>({});
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<ConsoleTab>("functions");
  const [logSource, setLogSource] = useState<LogSource>("all");
  const [logs, setLogs] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [secretDraft, setSecretDraft] = useState({ key: "", value: "" });
  const [secretBusy, setSecretBusy] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [bootstrapTarget, setBootstrapTarget] = useState<ManagedResourceDetail | null>(null);

  async function load(): Promise<void> {
    try {
      const rows = await listResources({ silent: true });
      const stacks = rows.filter((r) => r.profile === "supabase");
      setResources(stacks);
      const pairs = await Promise.all(
        stacks.map(async (r) => {
          const req = await getResourceEnvRequirements(r.id, { silent: true }).catch(() => null);
          return [r.id, req] as const;
        })
      );
      setRequirements(
        Object.fromEntries(pairs.filter(([, req]) => req !== null)) as Record<string, EnvRequirementsResponse>
      );
    } catch {
      /* silent — section simply stays empty */
    }
  }

  useEffect(() => {
    void load();
    const intv = setInterval(() => void load(), 15000);
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const event = payload as { type?: string };
      if (event.type === "resource_status") void load();
    });
    return () => {
      clearInterval(intv);
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  useEffect(() => {
    if (!selectedId || tab !== "logs") return;
    let cancelled = false;
    setLogsLoading(true);
    getResourceLogs(selectedId, logSource, { silent: true })
      .then((res) => {
        if (!cancelled) setLogs(res.logs);
      })
      .catch(() => {
        if (!cancelled) setLogs("Could not load logs.");
      })
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, tab, logSource]);

  async function act(resource: ManagedResourceDetail, action: "start" | "stop" | "restart"): Promise<void> {
    setActionBusyId(resource.id);
    try {
      await resourceAction(resource.id, action);
      toast.success(`${resource.name}: ${action} completed`);
      await load();
    } catch {
      /* toasted */
    } finally {
      setActionBusyId(null);
    }
  }

  async function remove(resource: ManagedResourceDetail): Promise<void> {
    const linked = resource.links
      .filter((l) => l.active)
      .map((l) => services.find((s) => s.id === l.service_id)?.name ?? l.service_id);
    const ok = await confirmDialog({
      title: `Remove stack "${resource.name}"?`,
      message:
        "Stops and removes the local Supabase stack. All generated local data (database, auth users, storage) will be lost. Hosted Supabase is not touched.",
      details:
        linked.length > 0 ? [`Linked services lose their injected env: ${linked.join(", ")}`] : undefined,
      danger: true,
      confirmLabel: "Remove stack"
    });
    if (!ok) return;
    try {
      const res = await removeResource(resource.id);
      toast.success(
        res.strandedServices > 0
          ? `Removed ${resource.name} — ${res.strandedServices} linked service${res.strandedServices === 1 ? "" : "s"} now need re-provisioning`
          : `Removed ${resource.name}`
      );
      if (selectedId === resource.id) setSelectedId("");
      await load();
    } catch {
      /* toasted */
    }
  }

  async function provideSecret(resourceId: string, key: string, value: string): Promise<void> {
    if (!key.trim() || !value.trim()) {
      toast.error("Secret key and value are required");
      return;
    }
    setSecretBusy(true);
    try {
      const res = await updateResourceSecrets(resourceId, { secrets: { [key.trim()]: value.trim() } });
      setRequirements((prev) => ({ ...prev, [resourceId]: res.requirements }));
      setSecretDraft({ key: "", value: "" });
      toast.success(`Secret ${key.trim()} saved`);
      await load();
    } catch {
      /* toasted */
    } finally {
      setSecretBusy(false);
    }
  }

  async function toggleSecret(resourceId: string, key: string, disable: boolean): Promise<void> {
    try {
      const res = await updateResourceSecrets(resourceId, disable ? { disable: [key] } : { enable: [key] });
      setRequirements((prev) => ({ ...prev, [resourceId]: res.requirements }));
      toast.success(disable ? `${key} disabled locally` : `${key} re-enabled`);
    } catch {
      /* toasted */
    }
  }

  function linkedServiceNames(resource: ManagedResourceDetail): string[] {
    return resource.links
      .filter((l) => l.active)
      .map((l) => services.find((s) => s.id === l.service_id)?.name ?? l.service_id);
  }

  function secretSummary(req: EnvRequirementsResponse | undefined): {
    missingRequired: number;
    missingOptional: number;
    disabled: number;
  } {
    const agg = req?.aggregate ?? [];
    return {
      missingRequired: agg.filter((s) => s.state === "missing-required").length,
      missingOptional: agg.filter((s) => s.state === "missing-optional").length,
      disabled: agg.filter((s) => s.state === "disabled").length
    };
  }

  const selected = resources.find((r) => r.id === selectedId) ?? null;
  const selectedReq = selected ? requirements[selected.id] : undefined;

  if (resources.length === 0) return null;

  return (
    <section className="res-stacks-section">
      <header className="res-stacks-header">
        <div className="row">
          <Boxes size={16} />
          <h3>Stacks</h3>
          <InfoHint title="Local Supabase stacks" side="right">
            <p>
              A full copy of Supabase running on your own machine — its database, user logins (auth),
              file storage, and edge functions — built straight from the app's code.
            </p>
            <p>
              Your tables come from the app's migration files. None of your hosted/cloud Supabase data
              is ever copied here.
            </p>
            <p>
              <strong>API</strong> is the address your app talks to. <strong>Studio</strong> is
              Supabase's built-in web dashboard for browsing the data.
            </p>
          </InfoHint>
          <span className="chip xsmall">{resources.length} local Supabase</span>
        </div>
        <p className="muted tiny">
          Rich backend stacks provisioned from app repositories. Schema comes from migrations — no hosted data
          is ever copied.
        </p>
      </header>

      <div className="grid res-stacks-grid">
        {resources.map((resource) => {
          const req = requirements[resource.id];
          const summary = secretSummary(req);
          const apiUrl = resourceConfigString(resource, "api_url");
          const studioUrl = resourceConfigString(resource, "studio_url");
          const mode = resourceConfigString(resource, "mode");
          const busy = actionBusyId === resource.id;
          return (
            <div
              key={resource.id}
              className={`card res-stack-card ${selectedId === resource.id ? "active-border" : ""}`}
              onClick={() => setSelectedId(resource.id)}
            >
              <div className="env-tag">supabase</div>
              <div className="service-header">
                <div className="service-title-group">
                  <h3>{resource.name}</h3>
                  <div className="service-meta muted tiny">
                    {mode ? `Migrations: ${mode}` : "Local stack"}
                  </div>
                </div>
                <StatusBadge status={resource.status} />
              </div>

              <div className="service-body">
                {apiUrl && (
                  <div className="res-stack-url">
                    <span>API</span>
                    <a href={apiUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      {apiUrl} <ExternalLink size={10} />
                    </a>
                  </div>
                )}
                {studioUrl && (
                  <div className="res-stack-url">
                    <span>Studio</span>
                    <a href={studioUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                      {studioUrl} <ExternalLink size={10} />
                    </a>
                  </div>
                )}

                <div className="database-linked-services" style={{ marginTop: "0.4rem" }}>
                  {linkedServiceNames(resource).length === 0 ? (
                    <span className="muted tiny">No services linked</span>
                  ) : (
                    linkedServiceNames(resource).map((name) => (
                      <span key={name} className="stack-service-pill">
                        <Link2 size={11} /> {name}
                      </span>
                    ))
                  )}
                </div>

                {req && req.functions.length > 0 && (
                  <div className="res-fn-chip-row">
                    {req.functions.map((fn) => (
                      <span
                        key={fn.name}
                        className={`res-fn-chip ${fn.status === "serving" ? "ok" : fn.status === "degraded" ? "warn" : "off"}`}
                        title={
                          fn.missing_secrets.length > 0
                            ? `${fn.name}: missing ${fn.missing_secrets.join(", ")}`
                            : `${fn.name}: ${fn.status}`
                        }
                      >
                        <FileCode2 size={10} /> {fn.name} · {fn.status}
                      </span>
                    ))}
                  </div>
                )}

                {(summary.missingRequired > 0 || summary.missingOptional > 0 || summary.disabled > 0) && (
                  <div className="res-secret-summary">
                    <KeyRound size={11} />
                    {summary.missingRequired > 0 && (
                      <span className="res-fn-chip danger">{summary.missingRequired} required missing</span>
                    )}
                    {summary.missingOptional > 0 && (
                      <span className="res-fn-chip warn">{summary.missingOptional} optional missing</span>
                    )}
                    {summary.disabled > 0 && (
                      <span className="res-fn-chip off">{summary.disabled} disabled locally</span>
                    )}
                  </div>
                )}
              </div>

              <div className="service-footer">
                <button
                  className="ghost xsmall"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void act(resource, "start");
                  }}
                  data-tooltip="Start stack"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                </button>
                <button
                  className="ghost xsmall"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void act(resource, "stop");
                  }}
                  data-tooltip="Stop stack"
                >
                  <Square size={14} />
                </button>
                <button
                  className="ghost xsmall"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void act(resource, "restart");
                  }}
                  data-tooltip="Restart stack"
                >
                  <RotateCw size={14} />
                </button>
                <button
                  className="ghost xsmall"
                  onClick={(e) => {
                    e.stopPropagation();
                    setBootstrapTarget(resource);
                  }}
                  data-tooltip="Create first local user / admin / org"
                >
                  <UserPlus size={14} />
                </button>
                <button
                  className="ghost logout xsmall"
                  style={{ marginLeft: "auto" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(resource);
                  }}
                  data-tooltip="Remove stack (generated data is lost)"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="card res-stack-console">
          <header className="section-title">
            <div className="row">
              <Boxes size={16} />
              <h3>Stack Console: {selected.name}</h3>
              <StatusBadge status={selected.status} />
              {selectedReq && (
                <span className="chip xsmall">
                  functions {selectedReq.serving ? "serving" : "not serving"}
                </span>
              )}
            </div>
            <div className="row" style={{ gap: "0.35rem" }}>
              <button className="ghost xsmall" onClick={() => setBootstrapTarget(selected)}>
                <UserPlus size={13} /> Bootstrap user
              </button>
              <InfoHint title="Bootstrap a first user" side="left">
                <p>
                  A brand-new local Supabase starts empty — no accounts at all. Bootstrapping creates
                  your first login so you can actually sign in.
                </p>
                <p>
                  If the app supports it, you can also make that user a platform admin and set up a
                  starting organization in the same step.
                </p>
              </InfoHint>
            </div>
          </header>

          <div className="db-console-tabs" role="tablist">
            {(
              [
                {
                  id: "functions",
                  label: `Functions${selectedReq ? ` (${selectedReq.functions.length})` : ""}`
                },
                { id: "secrets", label: `Secrets (${selected.secrets.length})` },
                { id: "logs", label: "Logs" }
              ] as Array<{ id: ConsoleTab; label: string }>
            ).map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`db-console-tab ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "functions" && (
            <div className="res-fn-table">
              <div className="res-panel-heading">
                <span>Edge Functions</span>
                <InfoHint title="Edge Functions" side="right">
                  <p>
                    Small serverless functions that ship with the app (in its{" "}
                    <code>supabase/functions</code> folder). ServerHoster runs them locally for you.
                  </p>
                  <p>
                    <strong>Serving</strong> — running fine. <strong>Degraded</strong> — running, but
                    missing an optional setting so some features may not work. <strong>Off</strong> —
                    not running.
                  </p>
                </InfoHint>
              </div>
              {!selectedReq || selectedReq.functions.length === 0 ? (
                <p className="muted small italic">No Edge Functions detected for this stack.</p>
              ) : (
                selectedReq.functions.map((fn) => (
                  <div key={fn.name} className="res-fn-detail-row">
                    <div className="row">
                      <FileCode2 size={14} />
                      <strong>{fn.name}</strong>
                      <span
                        className={`res-fn-chip ${fn.status === "serving" ? "ok" : fn.status === "degraded" ? "warn" : "off"}`}
                      >
                        {fn.status}
                      </span>
                    </div>
                    {fn.missing_secrets.length > 0 && (
                      <p className="tiny text-warning">
                        <AlertTriangle size={11} /> Missing: {fn.missing_secrets.join(", ")}
                      </p>
                    )}
                    {fn.secrets.length > 0 && (
                      <div className="res-key-chips">
                        {fn.secrets.map((s) => (
                          <span
                            key={s.key}
                            className={`res-key-chip ${s.state}`}
                            title={`${s.state} — referenced in ${s.source_files.join(", ")}`}
                          >
                            {s.key}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {tab === "secrets" && (
            <div className="res-secrets-panel">
              <div className="res-panel-heading">
                <span>Function secrets</span>
                <InfoHint title="Function secrets" side="right">
                  <p>
                    Settings your functions need — usually API keys. ServerHoster fills in the Supabase
                    ones for you; you provide any extras (like a third-party service's key).
                  </p>
                  <p>
                    <strong>Generated</strong> — created for you. <strong>Provided</strong> — you
                    entered it. <strong>Required missing</strong> — a function won't work until you add
                    it. <strong>Optional missing</strong> — only some features need it.{" "}
                    <strong>Disabled locally</strong> — you've chosen to skip it for local use.
                  </p>
                </InfoHint>
              </div>
              <div className="list">
                {selected.secrets.map((secret) => (
                  <div key={secret.key} className="list-item row between small">
                    <div className="row" style={{ gap: "0.5rem" }}>
                      <code>{secret.key}</code>
                      <span className={`res-key-chip ${secret.is_generated ? "generated" : "provided"}`}>
                        {secret.is_generated ? "generated" : "provided"}
                      </span>
                    </div>
                    <span className="muted tiny font-mono">{secret.value_preview}</span>
                  </div>
                ))}
                {(selectedReq?.aggregate ?? [])
                  .filter(
                    (s) =>
                      s.state === "missing-optional" ||
                      s.state === "disabled" ||
                      s.state === "missing-required"
                  )
                  .map((s) => (
                    <div key={`agg-${s.key}`} className="list-item row between small">
                      <div className="row" style={{ gap: "0.5rem" }}>
                        <code>{s.key}</code>
                        <span className={`res-key-chip ${s.state}`}>{s.state}</span>
                      </div>
                      <div className="row" style={{ gap: "0.25rem" }}>
                        {s.state !== "missing-required" && (
                          <button
                            className="ghost tiny"
                            onClick={() => void toggleSecret(selected.id, s.key, s.state !== "disabled")}
                          >
                            {s.state === "disabled" ? "Enable" : "Disable locally"}
                          </button>
                        )}
                        <button
                          className="ghost tiny"
                          onClick={() => setSecretDraft((d) => ({ ...d, key: s.key }))}
                        >
                          Provide
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
              <div className="res-secret-form">
                <input
                  placeholder="KEY"
                  value={secretDraft.key}
                  onChange={(e) => setSecretDraft((d) => ({ ...d, key: e.target.value }))}
                />
                <input
                  placeholder="Value"
                  type="password"
                  value={secretDraft.value}
                  onChange={(e) => setSecretDraft((d) => ({ ...d, value: e.target.value }))}
                />
                <button
                  className="primary small"
                  disabled={secretBusy}
                  onClick={() => void provideSecret(selected.id, secretDraft.key, secretDraft.value)}
                >
                  {secretBusy ? <Loader2 size={13} className="animate-spin" /> : "Save secret"}
                </button>
              </div>
              <p className="muted tiny">
                Values are stored encrypted; only previews are ever shown. Functions pick up changes on the
                next serve restart.
              </p>
            </div>
          )}

          {tab === "logs" && (
            <div className="res-logs-panel">
              <div className="row" style={{ gap: "0.25rem", marginBottom: "0.5rem" }}>
                {(["all", "containers", "functions"] as LogSource[]).map((src) => (
                  <button
                    key={src}
                    className={`ghost xsmall ${logSource === src ? "active-chip" : ""}`}
                    onClick={() => setLogSource(src)}
                  >
                    <ScrollText size={12} /> {src}
                  </button>
                ))}
              </div>
              <div className="logs-viewer" style={{ height: "260px" }}>
                {logsLoading ? (
                  <span className="muted small">
                    <Loader2 size={12} className="animate-spin" /> Loading…
                  </span>
                ) : (
                  logs || <span className="muted small">No logs yet.</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {bootstrapTarget && (
        <ResourceBootstrapModal
          resource={bootstrapTarget}
          onClose={() => setBootstrapTarget(null)}
          onDone={() => void load()}
        />
      )}
    </section>
  );
}
