import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setAuthToken } from "../lib/api";
import { toast } from "../lib/toast";
import { motion, AnimatePresence } from "framer-motion";
import { 
  ShieldCheck, 
  UserPlus, 
  Lock, 
  Info, 
  Loader2, 
  ChevronRight,
  ShieldAlert
} from "lucide-react";

export function OnboardingPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
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
      toast.success("System root initialized. Secure bootstrap complete.");
      navigate("/dashboard");
    } catch (err) {
      toast.error("Initialization failed: Internal bootstrap error");
    } finally {
      setLoading(false);
    }
  }

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
          <h1 className="font-bold">Initialize Node</h1>
          <p className="muted small">Configure your primary administrative identity</p>
        </div>

        <div className="onboarding-steps-container">
           {[
             { id: 1, label: "Identity", active: true },
             { id: 2, label: "Services", active: false }
           ].map((s, i, arr) => (
             <div key={s.id} className="row step-wrapper">
                <div className={`step-circle ${s.active ? "active" : ""}`}>
                   {s.id}
                </div>
                <span className={`tiny uppercase font-bold ${s.active ? "text-accent" : "muted"}`}>{s.label}</span>
                {i < arr.length - 1 && <div className="step-connector" />}
             </div>
           ))}
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
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
            <p className="tiny muted">This account holds root credentials for the entire cluster. Multi-factor authentication can be enabled in settings after bootstrap.</p>
          </div>

          <button type="submit" className="primary large" disabled={loading} style={{ marginTop: "2.5rem", width: "100%", justifyContent: "center" }}>
            {loading ? <Loader2 className="animate-spin" size={24} /> : <><ChevronRight size={20} /> Finalize Bootstrap</>}
          </button>
        </form>
      </motion.div>

      <style dangerouslySetInnerHTML={{ __html: `
        .onboarding-page .auth-gradient { background: radial-gradient(circle at 10% 10%, #0f172a 0%, #020617 100%); }
        .onboarding-steps-container { display: flex; align-items: center; justify-content: center; gap: 1.5rem; margin-bottom: 3.5rem; }
        .step-wrapper { gap: 0.75rem; }
        .step-circle { width: 32px; height: 32px; border-radius: 50%; border: 2.5px solid var(--border-default); display: flex; align-items: center; justify-content: center; font-size: 0.85rem; font-weight: 800; color: var(--text-muted); }
        .step-circle.active { border-color: var(--accent); color: var(--accent-light); box-shadow: 0 0 15px rgba(59,130,246,0.3); }
        .step-connector { width: 40px; height: 2.5px; background: var(--border-default); }
        .info-box-premium { padding: 1.25rem; background: var(--warning-soft); border-radius: var(--radius-md); border-left: 4px solid var(--warning); gap: 1rem; }
        .info-box-premium p { margin: 0; line-height: 1.4; }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.1em; }
        .tiny { font-size: 0.7rem; }
        .text-accent { color: var(--accent-light); }
        .large { height: 56px; font-size: 1.15rem; }
      `}} />
    </div>
  );
}
