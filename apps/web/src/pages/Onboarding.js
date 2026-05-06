import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setAuthToken } from "../lib/api";
import { toast } from "../lib/toast";
import { motion } from "framer-motion";
import { ShieldCheck, UserPlus, Lock, Loader2, ChevronRight, ShieldAlert } from "lucide-react";
export function OnboardingPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  async function handleSubmit(e) {
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
      const loginRes = await api("/auth/login", {
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
  return _jsxs("div", {
    className: "auth-page onboarding-page",
    children: [
      _jsx("div", { className: "auth-gradient" }),
      _jsxs(motion.div, {
        className: "auth-card large glass-card",
        initial: { opacity: 0, scale: 0.98 },
        animate: { opacity: 1, scale: 1 },
        transition: { duration: 0.6 },
        style: { maxWidth: "560px" },
        children: [
          _jsxs("div", {
            className: "auth-header",
            children: [
              _jsx("div", { className: "auth-logo", children: "\u25C8" }),
              _jsx("h1", { className: "font-bold", children: "Initialize Node" }),
              _jsx("p", {
                className: "muted small",
                children: "Configure your primary administrative identity"
              })
            ]
          }),
          _jsx("div", {
            className: "onboarding-steps-container",
            children: [
              { id: 1, label: "Identity", active: true },
              { id: 2, label: "Services", active: false }
            ].map((s, i, arr) =>
              _jsxs(
                "div",
                {
                  className: "row step-wrapper",
                  children: [
                    _jsx("div", { className: `step-circle ${s.active ? "active" : ""}`, children: s.id }),
                    _jsx("span", {
                      className: `tiny uppercase font-bold ${s.active ? "text-accent" : "muted"}`,
                      children: s.label
                    }),
                    i < arr.length - 1 && _jsx("div", { className: "step-connector" })
                  ]
                },
                s.id
              )
            )
          }),
          _jsxs("form", {
            className: "auth-form",
            onSubmit: handleSubmit,
            children: [
              _jsxs("div", {
                className: "form-group",
                children: [
                  _jsx("label", { className: "tiny uppercase font-bold muted", children: "Root Username" }),
                  _jsxs("div", {
                    className: "pr-overlap",
                    children: [
                      _jsx(UserPlus, { size: 18, className: "icon-overlay muted" }),
                      _jsx("input", {
                        className: "with-icon",
                        type: "text",
                        value: username,
                        onChange: (e) => setUsername(e.target.value),
                        placeholder: "e.g. admin",
                        required: true,
                        autoFocus: true
                      })
                    ]
                  })
                ]
              }),
              _jsxs("div", {
                className: "form-row",
                style: { marginTop: "1.5rem" },
                children: [
                  _jsxs("div", {
                    className: "form-group",
                    children: [
                      _jsx("label", {
                        className: "tiny uppercase font-bold muted",
                        children: "Master Password"
                      }),
                      _jsxs("div", {
                        className: "pr-overlap",
                        children: [
                          _jsx(Lock, { size: 18, className: "icon-overlay muted" }),
                          _jsx("input", {
                            className: "with-icon",
                            type: "password",
                            value: password,
                            onChange: (e) => setPassword(e.target.value),
                            placeholder: "At least 8 chars",
                            required: true
                          })
                        ]
                      })
                    ]
                  }),
                  _jsxs("div", {
                    className: "form-group",
                    children: [
                      _jsx("label", {
                        className: "tiny uppercase font-bold muted",
                        children: "Verification"
                      }),
                      _jsxs("div", {
                        className: "pr-overlap",
                        children: [
                          _jsx(ShieldCheck, { size: 18, className: "icon-overlay muted" }),
                          _jsx("input", {
                            className: "with-icon",
                            type: "password",
                            value: confirmPassword,
                            onChange: (e) => setConfirmPassword(e.target.value),
                            placeholder: "Confirm pass",
                            required: true
                          })
                        ]
                      })
                    ]
                  })
                ]
              }),
              _jsxs("div", {
                className: "info-box-premium row",
                style: { marginTop: "2rem" },
                children: [
                  _jsx(ShieldAlert, { size: 24, className: "text-warning", style: { flexShrink: 0 } }),
                  _jsx("p", {
                    className: "tiny muted",
                    children:
                      "This account holds root credentials for the entire cluster. Multi-factor authentication can be enabled in settings after bootstrap."
                  })
                ]
              }),
              _jsx("button", {
                type: "submit",
                className: "primary large",
                disabled: loading,
                style: { marginTop: "2.5rem", width: "100%", justifyContent: "center" },
                children: loading
                  ? _jsx(Loader2, { className: "animate-spin", size: 24 })
                  : _jsxs(_Fragment, { children: [_jsx(ChevronRight, { size: 20 }), " Finalize Bootstrap"] })
              })
            ]
          })
        ]
      }),
      _jsx("style", {
        dangerouslySetInnerHTML: {
          __html: `
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
      `
        }
      })
    ]
  });
}
