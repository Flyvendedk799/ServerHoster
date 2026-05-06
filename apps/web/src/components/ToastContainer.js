import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { subscribeToasts, dismissToast } from "../lib/toast";
const COLORS = {
  success: { bg: "#052e1a", border: "#10b981", fg: "#a7f3d0" },
  error: { bg: "#2e0a0a", border: "#ef4444", fg: "#fecaca" },
  info: { bg: "#0a1e2e", border: "#3b82f6", fg: "#bfdbfe" },
  warning: { bg: "#2e2408", border: "#f59e0b", fg: "#fde68a" }
};
export function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => subscribeToasts(setToasts), []);
  if (toasts.length === 0) return null;
  return _jsx("div", {
    style: {
      position: "fixed",
      bottom: "1rem",
      right: "1rem",
      display: "flex",
      flexDirection: "column",
      gap: "0.5rem",
      zIndex: 9999,
      maxWidth: "420px"
    },
    children: toasts.map((t) => {
      const c = COLORS[t.kind];
      return _jsxs(
        "div",
        {
          role: "status",
          style: {
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
          },
          children: [
            _jsx("div", {
              style: { flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" },
              children: t.message
            }),
            _jsx("button", {
              onClick: () => dismissToast(t.id),
              "aria-label": "Dismiss",
              style: {
                background: "transparent",
                border: "none",
                color: c.fg,
                cursor: "pointer",
                fontSize: "1.1rem",
                lineHeight: 1,
                padding: 0
              },
              children: "\u00D7"
            })
          ]
        },
        t.id
      );
    })
  });
}
