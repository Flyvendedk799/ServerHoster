import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  FileCode2,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  Terminal,
  UserPlus,
  XCircle,
  Zap
} from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { connectLogs } from "../lib/ws";
import { useModalA11y } from "../lib/useModalA11y";
import { InfoHint } from "./ui/InfoHint";
import {
  getBootstrapPlan,
  getResourceRecognition,
  getResourceDetail,
  getResourceLogs,
  isNonLocalUrl,
  provisionResource,
  resourceConfigString,
  runBootstrap,
  runResourceScan,
  type BootstrapPlanResponse,
  type BootstrapResult,
  type DatabaseRecognition,
  type DependencyScanRunResult,
  type DetectionSignal,
  type ManagedResourceDetail,
  type ProvisionMode,
  type ProvisionPlan,
  type RecognitionAction,
  type ResourceProfileId
} from "../lib/resources";

type WizardStep = "detect" | "mode" | "secrets" | "functions" | "bootstrap" | "confirm";
type Phase = "wizard" | "running" | "failed" | "bootstrap-exec" | "done";

const WIZARD_STEPS: Array<{ id: WizardStep; label: string }> = [
  { id: "detect", label: "Detection" },
  { id: "mode", label: "Mode" },
  { id: "secrets", label: "Secrets" },
  { id: "functions", label: "Functions" },
  { id: "bootstrap", label: "Bootstrap" },
  { id: "confirm", label: "Confirm" }
];

/** Ordered provisioning steps the server emits over the websocket. */
const PROGRESS_STEPS: Array<{ id: string; label: string }> = [
  { id: "preflight", label: "Preflight checks (Docker + Supabase CLI)" },
  { id: "init", label: "Initialize supabase config" },
  { id: "start", label: "Start local stack" },
  { id: "status", label: "Read stack status and keys" },
  { id: "migrate", label: "Apply migrations" },
  { id: "functions", label: "Edge Functions" },
  { id: "restart", label: "Restart / redeploy service" },
  { id: "done", label: "Ready" }
];

const SIGNAL_KIND_LABEL: Record<DetectionSignal["kind"], string> = {
  package: "Packages",
  file: "Files",
  env: "Environment keys",
  migration: "Migrations",
  function: "Edge Functions",
  code: "Code references"
};

type ServiceEnvRow = { id: string; key: string; value: string; is_secret: number; system: boolean };

type ProgressEvent = { step: string; message: string };

type Props = {
  serviceId: string;
  serviceName: string;
  /** Profile to provision; defaults to the scan's recommendation. */
  profile?: ResourceProfileId;
  onClose: () => void;
  /** Called after a successful provision (and again after bootstrap). */
  onProvisioned: () => void;
};

export function ResourceProvisionModal({ serviceId, serviceName, profile, onClose, onProvisioned }: Props) {
  const [step, setStep] = useState<WizardStep>("detect");
  const [phase, setPhase] = useState<Phase>("wizard");
  const [scan, setScan] = useState<DependencyScanRunResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [recognition, setRecognition] = useState<DatabaseRecognition | null>(null);

  const [mode, setMode] = useState<ProvisionMode>("schema-only");
  const [restart, setRestart] = useState(true);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [disabledKeys, setDisabledKeys] = useState<Set<string>>(new Set());
  const [serveFunctions, setServeFunctions] = useState(true);

  const [bootstrapOptIn, setBootstrapOptIn] = useState(false);
  const [bootstrapDefaults, setBootstrapDefaults] = useState({ email: "", password: "", fullName: "" });
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);

  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [failureLogs, setFailureLogs] = useState<string | null>(null);
  const [resource, setResource] = useState<ManagedResourceDetail | null>(null);
  const [overrideEnvKeys, setOverrideEnvKeys] = useState<string[]>([]);
  const resourceIdRef = useRef<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y(ref, { onClose, noAutoFocus: true });

  const plan: ProvisionPlan | null = useMemo(() => {
    if (!scan) return null;
    if (profile) return scan.plans.find((p) => p.profile === profile) ?? scan.recommended;
    return scan.recommended ?? scan.plans[0] ?? null;
  }, [scan, profile]);

  const targetProfile: ResourceProfileId = plan?.profile ?? profile ?? "supabase";
  const isSupabase = targetProfile === "supabase";

  // Run a fresh dependency scan on mount so the wizard shows live signals.
  useEffect(() => {
    let cancelled = false;
    getResourceRecognition(serviceId, { silent: true })
      .then((result) => {
        if (!cancelled) setRecognition(result);
      })
      .catch(() => undefined);
    runResourceScan(serviceId, { silent: true })
      .then((result) => {
        if (cancelled) return;
        setScan(result);
        const planForProfile = profile
          ? (result.plans.find((p) => p.profile === profile) ?? result.recommended)
          : (result.recommended ?? result.plans[0] ?? null);
        const serveAction = planForProfile?.actions.find((a) => a.id === "serve-functions");
        if (serveAction) setServeFunctions(serveAction.default_enabled);
      })
      .catch((err) => {
        if (!cancelled) setScanError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId, profile]);

  // Risk Register: service-level Supabase env overrides resource env. Surface it.
  useEffect(() => {
    let cancelled = false;
    api<ServiceEnvRow[]>(`/services/${serviceId}/env`, { silent: true })
      .then((rows) => {
        if (cancelled) return;
        const keys = rows
          .filter(
            (row) =>
              [
                "SUPABASE_URL",
                "VITE_SUPABASE_URL",
                "SUPABASE_ANON_KEY",
                "VITE_SUPABASE_PUBLISHABLE_KEY"
              ].includes(row.key) &&
              (row.is_secret ? true : !row.value || isNonLocalUrl(row.value) || !row.value.startsWith("http"))
          )
          .map((row) => row.key);
        setOverrideEnvKeys(keys);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  // Stream provisioning progress. The resource id is unknown until the awaited
  // provision call returns, so during `running` we adopt the first
  // resource_provisioning event's id and stick to it.
  useEffect(() => {
    if (phase !== "running") return;
    const ws = connectLogs((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const event = payload as { type?: string; resourceId?: string; step?: string; message?: string };
      if (event.type !== "resource_provisioning" || !event.resourceId) return;
      if (!resourceIdRef.current) resourceIdRef.current = event.resourceId;
      if (event.resourceId !== resourceIdRef.current) return;
      setEvents((prev) => [...prev, { step: event.step ?? "", message: event.message ?? "" }]);
    });
    return () => ws.close();
  }, [phase]);

  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === step);

  function next(): void {
    const target = WIZARD_STEPS[stepIndex + 1];
    if (target) setStep(target.id);
  }
  function back(): void {
    const target = WIZARD_STEPS[stepIndex - 1];
    if (target) setStep(target.id);
  }

  async function run(): Promise<void> {
    if (!plan) return;
    setPhase("running");
    setEvents([]);
    setFailure(null);
    resourceIdRef.current = null;
    try {
      const secrets: Record<string, string> = {};
      for (const [key, value] of Object.entries(secretValues)) {
        if (value.trim()) secrets[key] = value.trim();
      }
      const created = await provisionResource({
        serviceId,
        profile: targetProfile,
        mode,
        restart,
        serveFunctions: isSupabase ? serveFunctions : undefined,
        secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
        disabledSecrets: disabledKeys.size > 0 ? Array.from(disabledKeys) : undefined
      });
      setResource(created);
      resourceIdRef.current = created.id;
      onProvisioned();
      if (bootstrapOptIn && isSupabase) {
        setPhase("bootstrap-exec");
      } else {
        setPhase("done");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFailure(message);
      setPhase("failed");
      toast.error(`Provisioning failed: ${message}`);
    }
  }

  async function loadFailureLogs(): Promise<void> {
    const id = resourceIdRef.current;
    if (!id) {
      toast.error("No resource was created — check the server logs.");
      return;
    }
    try {
      const res = await getResourceLogs(id, "all", { silent: true });
      setFailureLogs(res.logs || "No logs captured.");
    } catch (err) {
      setFailureLogs(err instanceof Error ? err.message : String(err));
    }
  }

  const progressState = useMemo(() => {
    const failed = events.some((e) => e.step === "failed") || phase === "failed";
    let maxIndex = -1;
    for (const event of events) {
      const idx = PROGRESS_STEPS.findIndex((s) => s.id === event.step);
      if (idx > maxIndex) maxIndex = idx;
    }
    const doneSeen = events.some((e) => e.step === "done");
    return { failed, maxIndex, doneSeen, last: events[events.length - 1] ?? null };
  }, [events, phase]);

  function renderSignals(signals: DetectionSignal[]) {
    const groups = new Map<DetectionSignal["kind"], DetectionSignal[]>();
    for (const signal of signals) {
      const list = groups.get(signal.kind) ?? [];
      list.push(signal);
      groups.set(signal.kind, list);
    }
    return (
      <div className="res-signal-groups">
        {Array.from(groups.entries()).map(([kind, list]) => (
          <div key={kind} className="res-signal-group">
            <strong>{SIGNAL_KIND_LABEL[kind]}</strong>
            <ul>
              {list.slice(0, 6).map((signal, i) => (
                <li key={`${signal.value}-${i}`} title={signal.source_file}>
                  <code>{signal.value}</code>
                  <span className={`res-confidence ${signal.confidence}`}>{signal.confidence}</span>
                </li>
              ))}
              {list.length > 6 && <li className="muted tiny">+{list.length - 6} more</li>}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  async function runRecognitionAction(action: RecognitionAction): Promise<void> {
    if (action.id === "link-existing" && action.resource_id) {
      await api(`/resources/${action.resource_id}/link`, {
        method: "POST",
        body: JSON.stringify({ serviceId })
      });
      toast.success("Existing resource linked");
      onProvisioned();
      onClose();
      return;
    }
    if (action.id === "adopt-legacy" && action.database_id) {
      await api("/resources/adopt-database", {
        method: "POST",
        body: JSON.stringify({ databaseId: action.database_id, serviceId })
      });
      toast.success("Existing database adopted");
      onProvisioned();
      onClose();
    }
  }

  /** Group scanned function env keys by the function dir referencing them. */
  const functionGroups = useMemo(() => {
    const groups = new Map<string, Array<{ key: string; classification: string }>>();
    for (const req of scan?.scan.env_requirements ?? []) {
      for (const file of req.source_files) {
        const match = file.replace(/\\/g, "/").match(/(?:^|\/)supabase\/functions\/([^/]+)\//);
        if (!match) continue;
        const list = groups.get(match[1]) ?? [];
        if (!list.some((e) => e.key === req.key)) {
          list.push({ key: req.key, classification: req.classification });
        }
        groups.set(match[1], list);
      }
    }
    // Functions detected via signals but with no env requirements still count.
    for (const signal of plan?.signals ?? []) {
      if (signal.kind === "function" && !groups.has(signal.value)) groups.set(signal.value, []);
    }
    return groups;
  }, [scan, plan]);

  const optionalKeys = plan?.env.optional_user_input ?? [];
  const requiredKeys = plan?.env.required_user_input ?? [];
  const seedAction = plan?.actions.find((a) => a.id.includes("seed"));

  const title = targetProfile === "supabase" ? "Add Local Supabase" : `Provision ${targetProfile} resource`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content res-provision-modal"
        style={{ maxWidth: "720px" }}
        onClick={(e) => e.stopPropagation()}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-provision-title"
      >
        <header className="modal-header">
          <div className="row">
            <Zap size={20} className="text-accent" />
            <h3 id="resource-provision-title">{title}</h3>
          </div>
          <p className="hint">
            For <span style={{ color: "var(--accent-light)" }}>{serviceName}</span> — runs a local stack from
            this repo. <strong>No hosted data will be copied.</strong>
          </p>
        </header>

        {phase === "wizard" && (
          <div className="res-wizard-steps" role="tablist" aria-label="Provisioning steps">
            {WIZARD_STEPS.map((s, i) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={step === s.id}
                className={`res-wizard-step ${step === s.id ? "active" : ""} ${i < stepIndex ? "complete" : ""}`}
                onClick={() => i <= stepIndex && setStep(s.id)}
              >
                <span className="res-wizard-step-num">{i + 1}</span>
                {s.label}
              </button>
            ))}
          </div>
        )}

        <div className="modal-body">
          {phase === "wizard" && step === "detect" && (
            <div className="res-step-panel">
              {!scan && !scanError && (
                <p className="muted small">
                  <Loader2 size={14} className="animate-spin" /> Scanning repository for backend dependencies…
                </p>
              )}
              {scanError && (
                <div className="res-warning-banner">
                  <AlertTriangle size={15} />
                  <span>Scan failed: {scanError}</span>
                </div>
              )}
              {scan && plan && (
                <>
                  <div className="res-detect-headline">
                    <Database size={16} className="text-accent" />
                    <div>
                      <strong>
                        {isSupabase ? "Supabase app detected" : `${plan.profile} dependency detected`}
                      </strong>
                      <span className="muted small">
                        {isSupabase
                          ? "Run a local Supabase stack from this repo's migrations. No hosted data will be copied."
                          : "Provision a managed local resource and inject its connection env."}
                      </span>
                    </div>
                    <span className={`res-confidence badge-size ${plan.confidence}`}>
                      {plan.confidence} confidence
                    </span>
                    <InfoHint title="How this was detected" side="left">
                      <p>
                        ServerHoster scanned the app's code for clues — its packages, config files,
                        database migrations, functions, and settings — to work out what backend it
                        needs.
                      </p>
                      <p>
                        <strong>Confidence</strong> is how sure it is: high means several strong clues
                        lined up, low means just a hint. You can always override the choice.
                      </p>
                    </InfoHint>
                  </div>
                  {overrideEnvKeys.length > 0 && (
                    <div className="res-warning-banner">
                      <AlertTriangle size={15} />
                      <span>
                        This service already has service-level env ({overrideEnvKeys.join(", ")}), likely
                        pointing at hosted Supabase. Service-level env <strong>overrides</strong> the local
                        resource env — remove or update those keys after provisioning to actually use the
                        local stack.
                      </span>
                    </div>
                  )}
                  {recognition && recognition.current_provider.kind !== "none" && (
                    <div className={`res-warning-banner ${recognition.state === "conflict" ? "danger" : ""}`}>
                      <Database size={15} />
                      <span>
                        Recognition: <strong>{recognition.state}</strong> via{" "}
                        {recognition.current_provider.label}
                        {recognition.current_provider.env_key
                          ? ` (${recognition.current_provider.env_key})`
                          : ""}
                        .
                      </span>
                    </div>
                  )}
                  {recognition &&
                    recognition.actions
                      .filter((action) => action.id === "link-existing" || action.id === "adopt-legacy")
                      .slice(0, 2)
                      .map((action) => (
                        <div key={`${action.id}-${action.resource_id ?? action.database_id}`} className="res-no-copy-banner">
                          <ShieldCheck size={15} />
                          <span>{action.label} before creating a new local resource.</span>
                          <button className="ghost tiny" onClick={() => void runRecognitionAction(action)}>
                            {action.id === "link-existing" ? "Link" : "Adopt"}
                          </button>
                        </div>
                      ))}
                  {renderSignals(plan.signals)}
                </>
              )}
              {scan && !plan && (
                <p className="muted small">
                  No provisioning profile matched this service. Run a rescan after adding backend code, or use
                  the Databases page to provision manually.
                </p>
              )}
            </div>
          )}

          {phase === "wizard" && step === "mode" && (
            <div className="res-step-panel">
              <h4 className="res-step-title">
                How should the local schema be created?
                <InfoHint title="Schema, migrations & seed" side="right">
                  <p>
                    Migrations are the app's step-by-step recipe for building its database tables (they
                    live in the repo). "Schema" just means those tables and their structure.
                  </p>
                  <p>
                    <strong>Schema only</strong> builds the tables (recommended).{" "}
                    <strong>Schema + seed</strong> also loads the example/starter rows the repo
                    provides. <strong>Empty</strong> skips all of it.
                  </p>
                  <p>Either way, none of your real hosted data is copied.</p>
                </InfoHint>
              </h4>
              <div className="res-mode-options">
                <label className={`res-mode-option ${mode === "schema-only" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="res-mode"
                    checked={mode === "schema-only"}
                    onChange={() => setMode("schema-only")}
                  />
                  <div>
                    <strong>Schema only (recommended)</strong>
                    <span>
                      Applies the repo's migrations. Note: migrations themselves may include reference or
                      bootstrap rows — those are part of the schema contract.
                    </span>
                  </div>
                </label>
                <label className={`res-mode-option ${mode === "schema-and-seed" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="res-mode"
                    checked={mode === "schema-and-seed"}
                    onChange={() => setMode("schema-and-seed")}
                  />
                  <div>
                    <strong>
                      Schema + seed{" "}
                      {seedAction?.risk === "destructive" && <span className="res-risk-chip">seed data</span>}
                    </strong>
                    <span>
                      Also runs seed files (supabase db reset). Local data only — never hosted data.
                    </span>
                  </div>
                </label>
                <label className={`res-mode-option ${mode === "empty" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="res-mode"
                    checked={mode === "empty"}
                    onChange={() => setMode("empty")}
                  />
                  <div>
                    <strong>Empty stack (advanced)</strong>
                    <span>Starts the stack without applying any migrations.</span>
                  </div>
                </label>
              </div>
              <label className="checkbox-row" style={{ marginTop: "0.75rem" }}>
                <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
                <span>Restart / redeploy the service afterwards so the injected env takes effect</span>
              </label>
            </div>
          )}

          {phase === "wizard" && step === "secrets" && (
            <div className="res-step-panel">
              <h4 className="res-step-title">
                Local secrets
                <InfoHint title="Local secrets" side="right">
                  <p>Secrets are settings the stack and its functions need — mostly keys and passwords.</p>
                  <p>
                    <strong>Generated</strong> ones are created for you. <strong>Required</strong> ones
                    must be filled in or setup can't finish. <strong>Optional</strong> ones power extra
                    features — skip them and those features just run in a limited mode until you add
                    them.
                  </p>
                </InfoHint>
              </h4>
              {(plan?.env.generated.length ?? 0) > 0 && (
                <div className="res-secret-block">
                  <strong className="res-secret-block-title">
                    <ShieldCheck size={13} /> Generated locally
                  </strong>
                  <div className="res-key-chips">
                    {plan!.env.generated.map((key) => (
                      <span key={key} className="res-key-chip generated">
                        {key}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {requiredKeys.length > 0 && (
                <div className="res-secret-block">
                  <strong className="res-secret-block-title">
                    <KeyRound size={13} /> Required
                  </strong>
                  {requiredKeys.map((key) => (
                    <div className="form-group" key={key}>
                      <label>{key}</label>
                      <input
                        type="password"
                        placeholder="Paste value"
                        value={secretValues[key] ?? ""}
                        onChange={(e) => setSecretValues((p) => ({ ...p, [key]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>
              )}
              {optionalKeys.length > 0 ? (
                <div className="res-secret-block">
                  <strong className="res-secret-block-title">
                    <KeyRound size={13} /> Optional external providers
                  </strong>
                  <p className="muted tiny">
                    Leave empty to skip — affected Edge Functions run degraded. Or disable a key locally to
                    mark the feature as intentionally off.
                  </p>
                  {optionalKeys.map((key) => {
                    const disabled = disabledKeys.has(key);
                    return (
                      <div className="res-optional-secret" key={key}>
                        <code>{key}</code>
                        <input
                          type="password"
                          placeholder={disabled ? "Disabled locally" : "Paste value (optional)"}
                          disabled={disabled}
                          value={disabled ? "" : (secretValues[key] ?? "")}
                          onChange={(e) => setSecretValues((p) => ({ ...p, [key]: e.target.value }))}
                        />
                        <button
                          type="button"
                          className={`ghost xsmall ${disabled ? "res-disabled-toggle on" : "res-disabled-toggle"}`}
                          onClick={() =>
                            setDisabledKeys((prev) => {
                              const nextSet = new Set(prev);
                              if (nextSet.has(key)) nextSet.delete(key);
                              else nextSet.add(key);
                              return nextSet;
                            })
                          }
                        >
                          {disabled ? "Disabled" : "Disable locally"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                requiredKeys.length === 0 && (
                  <p className="muted small">No user-provided secrets needed — everything is generated.</p>
                )
              )}
            </div>
          )}

          {phase === "wizard" && step === "functions" && (
            <div className="res-step-panel">
              <h4 className="res-step-title">
                Edge Functions
                <InfoHint title="Edge Functions" side="right">
                  <p>
                    Small serverless functions bundled with the app. ServerHoster can run them on your
                    machine alongside the database.
                  </p>
                  <p>
                    A function marked "missing secrets" still runs, but the parts that need those keys
                    won't work until you provide them.
                  </p>
                </InfoHint>
              </h4>
              {functionGroups.size === 0 ? (
                <p className="muted small">No Edge Functions detected in this repository.</p>
              ) : (
                <>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={serveFunctions}
                      onChange={(e) => setServeFunctions(e.target.checked)}
                    />
                    <span>Serve Edge Functions locally (skip to run the stack without functions)</span>
                  </label>
                  <div className="res-function-list">
                    {Array.from(functionGroups.entries()).map(([name, keys]) => {
                      const missing = keys.filter(
                        (k) => k.classification !== "auto-generated" && !secretValues[k.key]?.trim()
                      );
                      return (
                        <div key={name} className="res-function-row">
                          <FileCode2 size={14} />
                          <code>{name}</code>
                          {missing.length === 0 ? (
                            <span className="res-fn-chip ok">ready</span>
                          ) : (
                            <span
                              className="res-fn-chip warn"
                              title={`Missing: ${missing.map((k) => k.key).join(", ")}`}
                            >
                              {missing.filter((k) => disabledKeys.has(k.key)).length === missing.length
                                ? "disabled keys"
                                : `${missing.length} missing secret${missing.length === 1 ? "" : "s"}`}
                            </span>
                          )}
                          {missing.length > 0 && (
                            <span className="muted tiny res-fn-missing">
                              {missing.map((k) => k.key).join(", ")}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {phase === "wizard" && step === "bootstrap" && (
            <div className="res-step-panel">
              <h4 className="res-step-title">
                First local user (optional)
                <InfoHint title="First local user" side="right">
                  <p>
                    A fresh local stack has no accounts at all, so you couldn't log in. This optionally
                    creates your first one right after setup.
                  </p>
                  <p>
                    A "role" is the user's permission level, "platform admin" is a super-user, and an
                    "organization" is a workspace/company — ServerHoster only offers the ones this app
                    actually uses.
                  </p>
                </InfoHint>
              </h4>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={bootstrapOptIn}
                  onChange={(e) => setBootstrapOptIn(e.target.checked)}
                />
                <span>Create a first local user / admin / organization after provisioning</span>
              </label>
              <p className="muted tiny">
                Auth starts empty in the local stack. After the stack is up, ServerHoster introspects the
                actual schema and offers detected roles, platform-admin and organization options before
                anything is written. You can also skip this and run it later from the Databases page.
              </p>
              {bootstrapOptIn && (
                <div className="res-bootstrap-fields">
                  <div className="form-row">
                    <div className="form-group">
                      <label>Email</label>
                      <input
                        type="email"
                        placeholder="admin@local.test"
                        value={bootstrapDefaults.email}
                        onChange={(e) => setBootstrapDefaults((p) => ({ ...p, email: e.target.value }))}
                      />
                    </div>
                    <div className="form-group">
                      <label>Password (min 6 chars)</label>
                      <input
                        type="password"
                        placeholder="••••••••"
                        value={bootstrapDefaults.password}
                        onChange={(e) => setBootstrapDefaults((p) => ({ ...p, password: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>
                      Full name <span className="optional">(optional)</span>
                    </label>
                    <input
                      value={bootstrapDefaults.fullName}
                      onChange={(e) => setBootstrapDefaults((p) => ({ ...p, fullName: e.target.value }))}
                    />
                  </div>
                  <p className="muted tiny">
                    Role / admin / organization choices appear after provisioning, based on the real local
                    schema.
                  </p>
                </div>
              )}
            </div>
          )}

          {phase === "wizard" && step === "confirm" && plan && (
            <div className="res-step-panel">
              <h4 className="res-step-title">Summary</h4>
              <ul className="res-summary-list">
                <li>
                  <strong>Profile</strong> Local {targetProfile} stack for {serviceName}
                </li>
                <li>
                  <strong>Migrations</strong>{" "}
                  {mode === "schema-only"
                    ? "Schema only"
                    : mode === "schema-and-seed"
                      ? "Schema + seed files"
                      : "Empty stack — no migrations"}
                </li>
                <li>
                  <strong>Edge Functions</strong>{" "}
                  {functionGroups.size === 0
                    ? "none detected"
                    : serveFunctions
                      ? `serve ${functionGroups.size} locally`
                      : "skipped"}
                </li>
                <li>
                  <strong>Secrets</strong> {plan.env.generated.length} generated
                  {Object.values(secretValues).filter((v) => v.trim()).length > 0 &&
                    `, ${Object.values(secretValues).filter((v) => v.trim()).length} provided`}
                  {disabledKeys.size > 0 && `, ${disabledKeys.size} disabled locally`}
                </li>
                <li>
                  <strong>Injected env</strong>{" "}
                  {plan.env.injected.length > 0 ? plan.env.injected.join(", ") : "—"}
                </li>
                <li>
                  <strong>Bootstrap</strong>{" "}
                  {bootstrapOptIn ? "first local user after provisioning" : "skipped"}
                </li>
                <li>
                  <strong>Service restart</strong> {restart ? "yes" : "no"}
                </li>
              </ul>
              <div className="res-no-copy-banner">
                <ShieldCheck size={15} />
                <span>
                  No hosted data will be copied. Auth users, storage files, and hosted secrets stay where they
                  are.
                </span>
              </div>
              {overrideEnvKeys.length > 0 && (
                <div className="res-warning-banner">
                  <AlertTriangle size={15} />
                  <span>
                    Service-level env ({overrideEnvKeys.join(", ")}) will still override the injected local
                    values until removed.
                  </span>
                </div>
              )}
            </div>
          )}

          {(phase === "running" || phase === "failed") && (
            <div className="res-step-panel">
              <h4 className="res-step-title">
                {phase === "failed" ? "Provisioning failed" : "Provisioning local stack…"}
              </h4>
              <ul className="res-progress-list">
                {PROGRESS_STEPS.map((s, i) => {
                  const complete = i < progressState.maxIndex || progressState.doneSeen;
                  const active =
                    !progressState.doneSeen &&
                    i === Math.max(progressState.maxIndex, 0) &&
                    phase === "running";
                  const failedHere = progressState.failed && i === Math.max(progressState.maxIndex, 0);
                  return (
                    <li
                      key={s.id}
                      className={`res-progress-step ${complete ? "complete" : ""} ${active ? "active" : ""} ${failedHere ? "failed" : ""}`}
                    >
                      {failedHere ? (
                        <XCircle size={14} />
                      ) : complete ? (
                        <CheckCircle2 size={14} />
                      ) : active ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <span className="res-progress-dot" />
                      )}
                      <span>{s.label}</span>
                    </li>
                  );
                })}
              </ul>
              {progressState.last && phase === "running" && (
                <p className="muted small res-progress-message">{progressState.last.message}</p>
              )}
              {phase === "failed" && (
                <>
                  <div className="res-warning-banner danger">
                    <XCircle size={15} />
                    <span>{failure ?? "Provisioning failed — see logs."}</span>
                  </div>
                  <button className="ghost small" onClick={() => void loadFailureLogs()}>
                    <Terminal size={14} /> View resource logs
                  </button>
                  {failureLogs && <pre className="res-log-pre">{failureLogs}</pre>}
                </>
              )}
            </div>
          )}

          {phase === "bootstrap-exec" && resource && (
            <BootstrapForm
              resourceId={resource.id}
              defaults={bootstrapDefaults}
              onDone={(result) => {
                setBootstrapResult(result);
                setPhase("done");
                onProvisioned();
              }}
              onSkip={() => setPhase("done")}
            />
          )}

          {phase === "done" && (
            <div className="res-step-panel">
              <div className="res-done-banner">
                <CheckCircle2 size={18} />
                <strong>Local {targetProfile} stack is ready</strong>
              </div>
              {resource && (
                <ul className="res-summary-list">
                  {resourceConfigString(resource, "api_url") && (
                    <li>
                      <strong>API URL</strong>{" "}
                      <a href={resourceConfigString(resource, "api_url")!} target="_blank" rel="noreferrer">
                        {resourceConfigString(resource, "api_url")} <ExternalLink size={11} />
                      </a>
                    </li>
                  )}
                  {resourceConfigString(resource, "studio_url") && (
                    <li>
                      <strong>Studio</strong>{" "}
                      <a
                        href={resourceConfigString(resource, "studio_url")!}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {resourceConfigString(resource, "studio_url")} <ExternalLink size={11} />
                      </a>
                    </li>
                  )}
                  <li>
                    <strong>Status</strong> {resource.status}
                  </li>
                </ul>
              )}
              {bootstrapResult && (
                <div className="res-secret-block">
                  <strong className="res-secret-block-title">
                    <UserPlus size={13} /> Bootstrap result
                  </strong>
                  <ul className="res-summary-list">
                    <li>
                      <strong>User</strong>{" "}
                      {bootstrapResult.user_existed ? "existing user promoted" : "created"} (
                      {bootstrapResult.user_id.slice(0, 8)}…)
                    </li>
                    <li>
                      <strong>Profile</strong> {bootstrapResult.profile}
                    </li>
                    {bootstrapResult.platform_admin && (
                      <li>
                        <strong>Platform admin</strong> yes
                      </li>
                    )}
                    {bootstrapResult.organization && (
                      <li>
                        <strong>Organization</strong> {bootstrapResult.organization.slug}{" "}
                        {bootstrapResult.organization.created ? "(created)" : "(existing)"}
                      </li>
                    )}
                    {bootstrapResult.warnings.map((w, i) => (
                      <li key={i} className="text-warning">
                        <AlertTriangle size={11} /> {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="muted tiny">
                Manage this stack — logs, secrets, functions, bootstrap — from the Databases page.
              </p>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          {phase === "wizard" && (
            <>
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <div className="row" style={{ gap: "0.5rem", marginLeft: "auto" }}>
                {stepIndex > 0 && (
                  <button className="ghost" onClick={back}>
                    <ChevronLeft size={15} /> Back
                  </button>
                )}
                {step !== "confirm" ? (
                  <button className="primary" disabled={!plan} onClick={next}>
                    Next <ChevronRight size={15} />
                  </button>
                ) : (
                  <button className="primary" disabled={!plan} onClick={() => void run()}>
                    <Sparkles size={15} /> Provision local stack
                  </button>
                )}
              </div>
            </>
          )}
          {phase === "running" && (
            <span className="muted small">
              <Loader2 size={13} className="animate-spin" /> Working — this can take a few minutes on first
              run (Docker images are pulled).
            </span>
          )}
          {phase === "failed" && (
            <>
              <button className="ghost" onClick={onClose}>
                Close
              </button>
              <button className="primary" onClick={() => void run()}>
                Retry
              </button>
            </>
          )}
          {phase === "done" && (
            <button className="primary" onClick={onClose} style={{ marginLeft: "auto" }}>
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bootstrap form — shared by the wizard (post-provision) and the standalone
// modal used from the Databases page for existing resources.
// ---------------------------------------------------------------------------

type BootstrapFormProps = {
  resourceId: string;
  defaults?: { email: string; password: string; fullName: string };
  onDone: (result: BootstrapResult) => void;
  onSkip?: () => void;
};

export function BootstrapForm({ resourceId, defaults, onDone, onSkip }: BootstrapFormProps) {
  const [plan, setPlan] = useState<BootstrapPlanResponse | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [email, setEmail] = useState(defaults?.email ?? "");
  const [password, setPassword] = useState(defaults?.password ?? "");
  const [fullName, setFullName] = useState(defaults?.fullName ?? "");
  const [role, setRole] = useState("");
  const [makePlatformAdmin, setMakePlatformAdmin] = useState(false);
  const [createOrg, setCreateOrg] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getBootstrapPlan(resourceId, { silent: true })
      .then((p) => {
        if (cancelled) return;
        setPlan(p);
        if (p.plan.roles.length > 0) setRole(p.plan.roles[0]);
      })
      .catch((err) => {
        if (!cancelled) setPlanError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  async function execute(): Promise<void> {
    if (!email.trim() || password.length < 6) {
      toast.error("Email and a password of at least 6 characters are required.");
      return;
    }
    if (createOrg && (!orgName.trim() || !orgSlug.trim())) {
      toast.error("Organization name and slug are required.");
      return;
    }
    setBusy(true);
    try {
      const result = await runBootstrap(resourceId, {
        email: email.trim(),
        password,
        fullName: fullName.trim() || undefined,
        role: role || undefined,
        makePlatformAdmin: makePlatformAdmin || undefined,
        organization: createOrg ? { create: true, name: orgName.trim(), slug: orgSlug.trim() } : undefined
      });
      toast.success(result.user_existed ? "Existing user promoted" : "First local user created");
      onDone(result);
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="res-step-panel">
      <h4 className="res-step-title">
        <UserPlus size={15} /> Bootstrap first local user
      </h4>
      {!plan && !planError && (
        <p className="muted small">
          <Loader2 size={14} className="animate-spin" /> Introspecting local schema…
        </p>
      )}
      {planError && (
        <div className="res-warning-banner danger">
          <AlertTriangle size={15} />
          <span>Could not build a bootstrap plan: {planError}</span>
        </div>
      )}
      {plan && (
        <>
          <p className="muted tiny">
            Target: <strong>{plan.resource_name}</strong> at <code>{plan.api_url}</code> (local stack only).
          </p>
          <div className="form-row">
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                value={email}
                placeholder="admin@local.test"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>Password (min 6 chars)</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>
                Full name <span className="optional">(optional)</span>
              </label>
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            {plan.plan.roles.length > 0 && (
              <div className="form-group">
                <label className="label-with-hint">
                  Role
                  <InfoHint side="left">
                    <p>
                      The user's permission level in the app (for example admin vs member). This list
                      comes from what this app's own database defines.
                    </p>
                  </InfoHint>
                </label>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {plan.plan.roles.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {plan.plan.has_platform_admins && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={makePlatformAdmin}
                onChange={(e) => setMakePlatformAdmin(e.target.checked)}
              />
              <span>Make platform admin</span>
              <InfoHint side="right">
                <p>
                  Gives this user top-level super-admin access across the whole app. Only offered
                  because this app has an admin table.
                </p>
              </InfoHint>
            </label>
          )}
          {plan.plan.org_support.organizations && (
            <>
              <label className="checkbox-row">
                <input type="checkbox" checked={createOrg} onChange={(e) => setCreateOrg(e.target.checked)} />
                <span>Create organization</span>
                <InfoHint side="right">
                  <p>
                    Also create a workspace/company and make this user its owner. Only offered because
                    this app uses organizations.
                  </p>
                </InfoHint>
              </label>
              {createOrg && (
                <div className="form-row">
                  <div className="form-group">
                    <label>Organization name</label>
                    <input value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Slug</label>
                    <input
                      value={orgSlug}
                      placeholder="my-org"
                      onChange={(e) => setOrgSlug(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </>
          )}
          <div className="res-secret-block">
            <strong className="res-secret-block-title res-title-with-hint">
              Operations preview
              <InfoHint side="right">
                <p>
                  Exactly what will be written to the local database when you click Create — shown up
                  front so there are no surprises.
                </p>
              </InfoHint>
            </strong>
            <ul className="res-ops-list">
              {plan.plan.operations.map((op, i) => (
                <li key={i} className={op.optional ? "optional" : ""}>
                  <code>{op.step}</code> {op.detail}
                  {op.optional ? <span className="muted tiny"> (optional)</span> : null}
                </li>
              ))}
            </ul>
            {plan.plan.warnings.map((w, i) => (
              <p key={i} className="text-warning tiny">
                <AlertTriangle size={11} /> {w}
              </p>
            ))}
          </div>
        </>
      )}
      <div className="row" style={{ gap: "0.5rem", marginTop: "0.75rem" }}>
        {onSkip && (
          <button className="ghost" onClick={onSkip} disabled={busy}>
            Skip bootstrap
          </button>
        )}
        <button className="primary" onClick={() => void execute()} disabled={busy || !plan}>
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Creating…
            </>
          ) : (
            "Create first user"
          )}
        </button>
      </div>
    </div>
  );
}

/** Standalone bootstrap modal for an existing resource (Databases page). */
export function ResourceBootstrapModal({
  resource,
  onClose,
  onDone
}: {
  resource: ManagedResourceDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y(ref, { onClose });
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: "640px" }}
        onClick={(e) => e.stopPropagation()}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-bootstrap-title"
      >
        <header className="modal-header">
          <h3 id="resource-bootstrap-title">Bootstrap — {resource.name}</h3>
          <p className="hint">
            Create the first local user, admin, or organization from schema introspection.
          </p>
        </header>
        <div className="modal-body">
          <BootstrapForm
            resourceId={resource.id}
            onDone={() => {
              onDone();
              onClose();
            }}
          />
        </div>
        <footer className="modal-footer">
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
