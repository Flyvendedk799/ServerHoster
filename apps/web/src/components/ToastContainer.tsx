import { useEffect, useState } from "react";
import { subscribeToasts, dismissToast, type Toast } from "../lib/toast";

const COLORS: Record<Toast["kind"], { bg: string; border: string; fg: string }> = {
  success: { bg: "#052e1a", border: "#10b981", fg: "#a7f3d0" },
  error: { bg: "#2e0a0a", border: "#ef4444", fg: "#fecaca" },
  info: { bg: "#0a1e2e", border: "#3b82f6", fg: "#bfdbfe" },
  warning: { bg: "#2e2408", border: "#f59e0b", fg: "#fde68a" }
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        right: "1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        zIndex: 9999,
        maxWidth: "420px"
      }}
    >
      {toasts.map((t) => {
        const c = COLORS[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            style={{
              background: c.bg,
              border: `1px solid ${c.border}`,
              color: c.fg,
              padding: "0.75rem 1rem",
              borderRadius: "6px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              display: "flex",
              alignItems: "flex-start",
              gap: "0.75rem",
              fontSize: "0.9rem",
              fontFamily: "system-ui, sans-serif"
            }}
          >
            <div style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{t.message}</div>
            <button
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss"
              style={{
                background: "transparent",
                border: "none",
                color: c.fg,
                cursor: "pointer",
                fontSize: "1.1rem",
                lineHeight: 1,
                padding: 0
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
