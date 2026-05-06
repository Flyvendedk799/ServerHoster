import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setAuthToken } from "../lib/api";
import { toast } from "../lib/toast";
import { motion } from "framer-motion";
import { Lock, User, LogIn, Loader2, ShieldCheck, UserPlus } from "lucide-react";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void api<{ hasUsers?: boolean }>("/auth/status", { silent: true })
      .then((res) => setHasUsers(Boolean(res.hasUsers)))
      .catch(() => setHasUsers(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const body: Record<string, string> = { password };
      // Empty username falls back to the legacy passphrase path on the server.
      if (username.trim()) body.username = username.trim();
      const res = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(body)
      });
      setAuthToken(res.token);
      toast.success("Identity verified. Access granted.");
      navigate("/dashboard");
    } catch (err) {
      toast.error("Access Denied: Invalid credentials");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-gradient" />

      <motion.div
        className="auth-card glass-card"
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <div className="auth-header">
          <motion.div
            className="auth-logo"
            animate={{ rotate: [0, 10, -10, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
          >
            ◈
          </motion.div>
          <h1 className="font-bold">Welcome Back</h1>
          <p className="muted small">Sign in to manage your local infrastructure node</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="tiny uppercase font-bold muted">
              Security Identity (Username) <span className="optional">— optional</span>
            </label>
            <div className="pr-overlap">
              <User size={18} className="icon-overlay muted" />
              <input
                className="with-icon"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={
                  hasUsers ? "Username for your admin account" : "Leave blank to use admin passphrase"
                }
                autoFocus
              />
            </div>
            <p className="hint tiny" style={{ marginTop: "0.4rem" }}>
              {hasUsers === false
                ? "No admin accounts created yet — leave this blank to use the legacy passphrase."
                : "Leave blank to log in with the legacy passphrase."}
            </p>
          </div>

          <div className="form-group" style={{ marginTop: "1rem" }}>
            <label className="tiny uppercase font-bold muted">Access Phrase (Password)</label>
            <div className="pr-overlap">
              <Lock size={18} className="icon-overlay muted" />
              <input
                className="with-icon"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            className="primary large"
            disabled={loading}
            style={{ marginTop: "2rem", width: "100%", justifyContent: "center" }}
          >
            {loading ? (
              <Loader2 className="animate-spin" size={20} />
            ) : (
              <>
                <LogIn size={20} /> Sign In
              </>
            )}
          </button>
        </form>

        <div
          className="auth-footer"
          style={{ marginTop: "2rem", borderTop: "1px solid var(--border-subtle)", paddingTop: "1.5rem" }}
        >
          <div className="row center muted xsmall">
            <ShieldCheck size={14} className="text-success" />
            <span>Secure Session Management Active</span>
          </div>
          {hasUsers === false && (
            <button
              type="button"
              className="ghost xsmall create-admin-link"
              onClick={() => navigate("/onboarding")}
            >
              <UserPlus size={14} /> Create an admin account
            </button>
          )}
        </div>
      </motion.div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .auth-page { 
          min-height: 100vh; display: flex; align-items: center; justify-content: center; 
          padding: 2rem; position: relative; overflow: hidden; background: #020617;
        }
        .auth-gradient {
           position: absolute; inset: 0;
           background: radial-gradient(circle at 50% 50%, #1e293b 0%, #020617 100%);
           opacity: 0.6;
        }
        .auth-card { 
          width: 100%; max-width: 440px; padding: 3rem; background: var(--bg-card); 
          border-radius: var(--radius-lg); border: 1px solid var(--border-glow); 
          box-shadow: 0 25px 50px -12px rgba(0,0,0,0.8); z-index: 10;
          backdrop-filter: blur(24px);
        }
        .auth-header { text-align: center; margin-bottom: 2.5rem; }
        .auth-logo { width: 64px; height: 64px; background: var(--accent-gradient); border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem; color: white; font-size: 2.5rem; box-shadow: 0 10px 20px rgba(59,130,246,0.3); }
        .auth-form { display: flex; flex-direction: column; gap: 0.5rem; }
        .large { height: 52px; font-size: 1.1rem; }
        .with-icon { padding-left: 2.75rem !important; }
        .icon-overlay { position: absolute; left: 1rem; top: 12px; }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .center { justify-content: center; }
        .font-bold { font-weight: 700; }
        .uppercase { text-transform: uppercase; letter-spacing: 0.1em; }
        .tiny { font-size: 0.7rem; }
        .xsmall { font-size: 0.8rem; }
        .optional { opacity: 0.55; font-weight: 400; text-transform: none; letter-spacing: 0; }
        .create-admin-link {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          margin: 0.75rem auto 0;
          width: max-content;
          background: transparent;
          border: 1px dashed var(--border-subtle);
          color: var(--text-muted);
          padding: 0.4rem 0.8rem;
          border-radius: var(--radius-sm);
          cursor: pointer;
        }
        .create-admin-link:hover { color: var(--accent-light); border-color: var(--accent); }
      `
        }}
      />
    </div>
  );
}
