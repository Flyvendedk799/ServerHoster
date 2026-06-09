import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setAuthToken } from "../lib/api";
import { toast } from "../lib/toast";
import { motion } from "framer-motion";
import {
  ShieldCheck,
  UserPlus,
  Lock,
  Loader2,
  ChevronRight,
  ShieldAlert,
  Cloud,
  Globe,
  Network,
  Check,
  LogIn,
  Eye,
  EyeOff
} from "lucide-react";

type Adapter = { id: string; label: string; available: boolean };

const ADAPTER_ICONS: Record<string, React.ReactNode> = {
  cloudflare: <Cloud size={20} />,
  ngrok: <Globe size={20} />,
  tailscale: <Network size={20} />
};

export function OnboardingPage() {
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [loading, setLoading] = useState(false);
  const [adapters, setAdapters] = useState<Adapter[] | null>(null);
  const [pickedAdapter, setPickedAdapter] = useState<string | null>(null);
  const navigate = useNavigate();

  // Live validation for step 1. Hints only surface once the user has typed.
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const canContinue = username.trim().length > 0 && password.length >= 8 && confirmPassword === password;

  // Once the bootstrap+login succeeds we advance to step 2 and start fetching
  // the available tunnel adapters in the background. We never block step 2 on
  // the fetch — the user can skip without picking anything.
  useEffect(() => {
    if (step !== 2) return;
    void api<{ adapters: Adapter[] }>("/tunnels/adapters", { silent: true })
      .then((res) => {
        setAdapters(res.adapters);
        const firstAvailable = res.adapters.find((a) => a.available)?.id ?? res.adapters[0]?.id ?? null;
        setPickedAdapter(firstAvailable);
      })
      .catch(() => setAdapters([]));
  }, [step]);

  async function handleStep1(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      await api("/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      const loginRes = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setAuthToken(loginRes.token);
      toast.success("Admin account created");
      setStep(2);
    } catch {
      toast.error("Could not create the admin account. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function finalize(saveAdapter: boolean): Promise<void> {
    setLoading(true);
    try {
      if (saveAdapter && pickedAdapter) {
        await api("/settings", {
          method: "PUT",
          body: JSON.stringify({ key: "default_tunnel_adapter", value: pickedAdapter }),
          silent: true
        });
      }
      navigate("/dashboard");
    } catch {
      // Saving the preference is best-effort. Continue to the dashboard so
      // the user isn't stranded if the settings call fails for some reason.
      navigate("/dashboard");
    } finally {
      setLoading(false);
    }
  }

  const stepDefs: Array<{ id: 1 | 2; label: string }> = [
    { id: 1, label: "Account" },
    { id: 2, label: "Networking" }
  ];

  return (
    <div className="auth-screen onboarding-page animate-up">
      <motion.div
        className="auth-card onboarding-card"
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18 }}
        style={{ maxWidth: "560px" }}
      >
        <div className="auth-header">
          <div className="auth-logo">LS</div>
          <h1 className="font-bold">
            {step === 1 ? "Create your admin account" : "Choose how to expose services"}
          </h1>
          <p className="muted small">
            {step === 1
              ? "Set up the administrator login for this server"
              : "Pick a default way for outside traffic to reach this server"}
          </p>
        </div>

        <div className="onboarding-steps-container">
          {stepDefs.map((s, i, arr) => {
            const active = step === s.id;
            const done = step > s.id;
            return (
              <div key={s.id} className="row step-wrapper">
                <div className={`step-circle ${active ? "active" : ""} ${done ? "done" : ""}`}>
                  {done ? <Check size={16} /> : s.id}
                </div>
                <span className={`tiny uppercase font-bold ${active ? "text-accent" : "muted"}`}>
                  {s.label}
                </span>
                {i < arr.length - 1 && <div className="step-connector" />}
              </div>
            );
          })}
        </div>

        {step === 1 ? (
          <form className="auth-form" onSubmit={handleStep1}>
            <div className="form-group">
              <label className="tiny uppercase font-bold muted">Username</label>
              <div className="pr-overlap">
                <UserPlus size={18} className="icon-overlay muted" />
                <input
                  className="with-icon"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. admin"
                  required
                  autoFocus
                  autoComplete="username"
                />
              </div>
            </div>

            <div className="form-row" style={{ marginTop: "1.5rem" }}>
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Password</label>
                <div className="pr-overlap input-wrap">
                  <Lock size={18} className="icon-overlay muted" />
                  <input
                    className="with-icon has-action"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
                    placeholder="At least 8 characters"
                    required
                    autoComplete="new-password"
                    aria-invalid={tooShort || undefined}
                  />
                  <button
                    type="button"
                    className="input-action"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {tooShort && (
                  <span className="field-hint error">Password must be at least 8 characters.</span>
                )}
                {capsLock && !tooShort && <span className="field-hint">Caps Lock is on.</span>}
              </div>
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Confirm password</label>
                <div className="pr-overlap input-wrap">
                  <ShieldCheck size={18} className="icon-overlay muted" />
                  <input
                    className="with-icon has-action"
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
                    placeholder="Re-enter password"
                    required
                    autoComplete="new-password"
                    aria-invalid={mismatch || undefined}
                  />
                  <button
                    type="button"
                    className="input-action"
                    onClick={() => setShowConfirm((v) => !v)}
                    aria-label={showConfirm ? "Hide password" : "Show password"}
                  >
                    {showConfirm ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {mismatch && <span className="field-hint error">Passwords do not match.</span>}
              </div>
            </div>

            <div className="info-box-premium row" style={{ marginTop: "1rem" }}>
              <ShieldAlert size={24} className="text-warning" style={{ flexShrink: 0 }} />
              <p className="tiny muted">
                This is the administrator account for the server. You can enable multi-factor authentication
                in Settings later.
              </p>
            </div>

            <button
              type="submit"
              className="primary large"
              disabled={loading || !canContinue}
              style={{ marginTop: "1.25rem", width: "100%", justifyContent: "center" }}
            >
              {loading ? (
                <Loader2 className="animate-spin" size={24} />
              ) : (
                <>
                  Continue <ChevronRight size={20} />
                </>
              )}
            </button>

            <div className="auth-alt-action">
              <span className="tiny muted">Already have an admin account?</span>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  // Override the auto-onboarding: record the intent so App's
                  // bootstrap-redirect doesn't bounce us straight back here.
                  sessionStorage.setItem("survhub_prefer_login", "1");
                  navigate("/login");
                }}
              >
                <LogIn size={14} /> Log in instead
              </button>
            </div>
          </form>
        ) : (
          <div className="auth-form">
            <p className="tiny muted" style={{ marginBottom: "1rem" }}>
              Pick the default tunnel provider for exposing a service publicly. You can change this
              per-service later from Settings.
            </p>

            {adapters === null ? (
              <div className="row center" style={{ padding: "1rem 0" }}>
                <Loader2 className="animate-spin" size={20} />
              </div>
            ) : adapters.length === 0 ? (
              <p className="small muted">No tunnel adapters detected.</p>
            ) : (
              <div className="adapter-grid">
                {adapters.map((a) => {
                  const checked = pickedAdapter === a.id;
                  return (
                    <button
                      type="button"
                      key={a.id}
                      className={`adapter-card ${checked ? "checked" : ""} ${a.available ? "" : "unavailable"}`}
                      onClick={() => setPickedAdapter(a.id)}
                    >
                      <div className="adapter-card-icon">{ADAPTER_ICONS[a.id] ?? <Globe size={20} />}</div>
                      <div className="adapter-card-body">
                        <div className="row" style={{ justifyContent: "space-between" }}>
                          <span className="font-bold small">{a.label}</span>
                          {checked && <Check size={16} className="text-accent" />}
                        </div>
                        <span className={`xsmall ${a.available ? "text-success" : "muted"}`}>
                          {a.available ? "Detected on this host" : "Not installed (instructions in Settings)"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="row" style={{ marginTop: "1rem", gap: "0.5rem" }}>
              <button
                type="button"
                className="ghost large"
                onClick={() => void finalize(false)}
                disabled={loading}
                style={{ flex: "0 0 auto" }}
              >
                Skip
              </button>
              <button
                type="button"
                className="primary large"
                onClick={() => void finalize(true)}
                disabled={loading || !pickedAdapter}
                style={{ flex: 1, justifyContent: "center" }}
              >
                {loading ? (
                  <Loader2 className="animate-spin" size={24} />
                ) : (
                  <>
                    Save & Open Dashboard <ChevronRight size={20} />
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </motion.div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .onboarding-page .auth-gradient { background: var(--bg); }
        .onboarding-steps-container { display: flex; align-items: center; justify-content: center; gap: 1rem; margin: 1.5rem 0 1.75rem; }
        .step-wrapper { gap: 0.5rem; }
        .step-circle { width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--border-default); display: flex; align-items: center; justify-content: center; font-size: 0.78rem; font-weight: 700; color: var(--text-muted); }
        .step-circle.active { border-color: var(--accent); color: var(--accent-light); box-shadow: none; }
        .step-circle.done { border-color: var(--success); color: var(--success); background: var(--success-soft); }
        .step-connector { width: 34px; height: 1px; background: var(--border-default); }
        .info-box-premium { padding: 0.9rem; background: var(--warning-soft); border-radius: var(--radius-md); border: 1px solid var(--warning-soft); gap: 0.75rem; }
        .info-box-premium p { margin: 0; line-height: 1.4; }
        .adapter-grid { display: flex; flex-direction: column; gap: 0.75rem; }
        .adapter-card { display: flex; gap: 0.75rem; align-items: center; padding: 0.75rem; background: var(--bg-sunken); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); cursor: pointer; text-align: left; transition: border-color .15s ease, background .15s ease; }
        .adapter-card:hover { border-color: var(--border-default); }
        .adapter-card.checked { border-color: var(--accent); background: var(--accent-soft); }
        .adapter-card.unavailable { opacity: 0.6; }
        .adapter-card-icon { flex: 0 0 auto; color: var(--accent-light); }
        .adapter-card-body { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.1em; }
        .tiny { font-size: 0.7rem; }
        .xsmall { font-size: 0.75rem; }
        .text-accent { color: var(--accent-light); }
        .text-success { color: var(--success); }
        .large { height: 38px; font-size: 0.9rem; }
        .auth-alt-action { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap; }
        .link-button { display: inline-flex; align-items: center; gap: 0.35rem; background: none; border: none; padding: 0; color: var(--accent-light); font-size: 0.8rem; font-weight: 600; cursor: pointer; }
        .link-button:hover { text-decoration: underline; }
      `
        }}
      />
    </div>
  );
}
