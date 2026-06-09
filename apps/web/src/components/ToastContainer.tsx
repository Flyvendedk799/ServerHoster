import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from "lucide-react";
import { subscribeToasts, dismissToast, type Toast } from "../lib/toast";

const ICONS: Record<Toast["kind"], typeof Info> = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="toasts"
      aria-live="polite"
      style={{
        position: "fixed",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        zIndex: 9999,
        maxWidth: "420px"
      }}
    >
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        const assertive = t.kind === "error" || t.kind === "warning";
        return (
          <div
            key={t.id}
            className={`toast toast-${t.kind} animate-up`}
            role={assertive ? "alert" : "status"}
            aria-live={assertive ? "assertive" : "polite"}
          >
            <span className="toast-icon" aria-hidden="true">
              <Icon size={16} />
            </span>
            <div className="toast-msg" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {t.message}
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
              style={{
                background: "transparent",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                lineHeight: 1,
                padding: 0,
                flex: "0 0 auto"
              }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
