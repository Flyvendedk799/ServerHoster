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
  Check
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
  const [loading, setLoading] = useState(false);
  const [adapters, setAdapters] = useState<Adapter[] | null>(null);
  const [pickedAdapter, setPickedAdapter] = useState<string | null>(null);
  const navigate = useNavigate();

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
      toast.error("Security mismatch: Passwords do not match");
      return;
    }
    if (password.length < 8) {
      toast.error("Policy error: Password must be at least 8 characters");
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
      toast.success("System root initialized.");
      setStep(2);
    } catch {
      toast.error("Initialization failed: Internal bootstrap error");
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
    { id: 1, label: "Identity" },
    { id: 2, label: "Exposure" }
  ];

  return (
    <div className="auth-page onboarding-page">
      <div className="auth-gradient" />

      <motion.div
        className="auth-card large glass-card"
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6 }}
        style={{ maxWidth: "560px" }}
      >
        <div className="auth-header">
          <div className="auth-logo">◈</div>
          <h1 className="font-bold">{step === 1 ? "Initialize Node" : "Pick a Public Door"}</h1>
          <p className="muted small">
            {step === 1
              ? "Configure your primary administrative identity"
              : "How should outside traffic reach this box?"}
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
              <label className="tiny uppercase font-bold muted">Root Username</label>
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
                />
              </div>
            </div>

            <div className="form-row" style={{ marginTop: "1.5rem" }}>
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Master Password</label>
                <div className="pr-overlap">
                  <Lock size={18} className="icon-overlay muted" />
                  <input
                    className="with-icon"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 chars"
                    required
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="tiny uppercase font-bold muted">Verification</label>
                <div className="pr-overlap">
                  <ShieldCheck size={18} className="icon-overlay muted" />
                  <input
                    className="with-icon"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm pass"
                    required
                  />
                </div>
              </div>
            </div>

            <div className="info-box-premium row" style={{ marginTop: "2rem" }}>
              <ShieldAlert size={24} className="text-warning" style={{ flexShrink: 0 }} />
              <p className="tiny muted">
                This account holds root credentials for the entire cluster. Multi-factor authentication can be
                enabled in settings after bootstrap.
              </p>
            </div>

            <button
              type="submit"
              className="primary large"
              disabled={loading}
              style={{ marginTop: "2.5rem", width: "100%", justifyContent: "center" }}
            >
              {loading ? (
                <Loader2 className="animate-spin" size={24} />
              ) : (
                <>
                  Continue <ChevronRight size={20} />
                </>
              )}
            </button>
          </form>
        ) : (
          <div className="auth-form">
            <p className="tiny muted" style={{ marginBottom: "1rem" }}>
              Pick the default tunnel provider for one-click public exposure. You can change this per-service
              later from Settings.
            </p>

            {adapters === null ? (
              <div className="row center" style={{ padding: "2rem 0" }}>
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

            <div className="row" style={{ marginTop: "2rem", gap: "0.75rem" }}>
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
        .onboarding-page .auth-gradient { background: radial-gradient(circle at 10% 10%, #0f172a 0%, #020617 100%); }
        .onboarding-steps-container { display: flex; align-items: center; justify-content: center; gap: 1.5rem; margin-bottom: 3.5rem; }
        .step-wrapper { gap: 0.75rem; }
        .step-circle { width: 32px; height: 32px; border-radius: 50%; border: 2.5px solid var(--border-default); display: flex; align-items: center; justify-content: center; font-size: 0.85rem; font-weight: 800; color: var(--text-muted); }
        .step-circle.active { border-color: var(--accent); color: var(--accent-light); box-shadow: 0 0 15px rgba(59,130,246,0.3); }
        .step-circle.done { border-color: var(--success); color: var(--success); background: rgba(34,197,94,0.08); }
        .step-connector { width: 40px; height: 2.5px; background: var(--border-default); }
        .info-box-premium { padding: 1.25rem; background: var(--warning-soft); border-radius: var(--radius-md); border-left: 4px solid var(--warning); gap: 1rem; }
        .info-box-premium p { margin: 0; line-height: 1.4; }
        .adapter-grid { display: flex; flex-direction: column; gap: 0.75rem; }
        .adapter-card { display: flex; gap: 1rem; align-items: center; padding: 1rem; background: var(--bg-elevated); border: 2px solid var(--border-subtle); border-radius: var(--radius-md); cursor: pointer; text-align: left; transition: border-color .15s ease, background .15s ease; }
        .adapter-card:hover { border-color: var(--border-default); }
        .adapter-card.checked { border-color: var(--accent); background: rgba(59,130,246,0.08); }
        .adapter-card.unavailable { opacity: 0.6; }
        .adapter-card-icon { flex: 0 0 auto; color: var(--accent-light); }
        .adapter-card-body { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.1em; }
        .tiny { font-size: 0.7rem; }
        .xsmall { font-size: 0.75rem; }
        .text-accent { color: var(--accent-light); }
        .text-success { color: var(--success); }
        .large { height: 56px; font-size: 1.15rem; }
      `
        }}
      />
    </div>
  );
}
