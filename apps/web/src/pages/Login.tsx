import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setAuthToken } from "../lib/api";
import { toast } from "../lib/toast";
import { motion } from "framer-motion";
import { Lock, User, LogIn, Loader2, ShieldCheck, UserPlus, Eye, EyeOff } from "lucide-react";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
      toast.success("Signed in");
      navigate("/dashboard");
    } catch (err) {
      toast.error("Incorrect username or password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen animate-up">
      <motion.div
        className="auth-card"
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <div className="auth-logo-wrap">
          <div className="auth-logo">LS</div>
          <span className="auth-product">LocalSURV</span>
        </div>
        <div className="auth-title">Sign in</div>
        <div className="auth-sub">Sign in to manage your services</div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label">
              Username <span className="optional">optional</span>
            </label>
            <div className="input-wrap">
              <span className="input-icon">
                <User size={14} />
              </span>
              <input
                className="input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={
                  hasUsers ? "Username for your admin account" : "Leave blank to use admin passphrase"
                }
                autoFocus
                autoComplete="username"
              />
            </div>
            <span className="field-hint">
              {hasUsers === false
                ? "No admin accounts created yet; leave blank for the legacy passphrase."
                : "Leave blank to log in with the legacy passphrase."}
            </span>
          </div>

          <div className="field">
            <label className="field-label">Password</label>
            <div className="input-wrap">
              <span className="input-icon">
                <Lock size={14} />
              </span>
              <input
                className="input has-action"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                autoComplete="current-password"
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
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg"
            disabled={loading}
            style={{ width: "100%", justifyContent: "center", marginTop: 4 }}
          >
            {loading ? (
              <Loader2 className="spinner" size={16} />
            ) : (
              <>
                <LogIn size={15} /> Sign In
              </>
            )}
          </button>
        </form>

        <div className="auth-footer">
          <ShieldCheck size={13} style={{ color: "var(--green)", opacity: 0.8 }} />
          <span>Secure session management active</span>
          {hasUsers === false && (
            <button
              type="button"
              className="btn btn-default btn-sm create-admin-link"
              onClick={() => {
                // Clear any "prefer login" override so the user can reach
                // onboarding instead of being bounced back to this screen.
                sessionStorage.removeItem("survhub_prefer_login");
                navigate("/onboarding");
              }}
            >
              <UserPlus size={14} /> Create an admin account
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
