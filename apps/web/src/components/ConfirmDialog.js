import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { resolveCurrent, subscribeConfirm } from "../lib/confirm";
export function ConfirmDialog() {
  const [pending, setPending] = useState(null);
  useEffect(() => subscribeConfirm(setPending), []);
  useEffect(() => {
    if (!pending) return;
    const onKey = (e) => {
      if (e.key === "Escape") resolveCurrent(false);
      if (e.key === "Enter") resolveCurrent(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);
  if (!pending) return null;
  return _jsx("div", {
    className: "modal-overlay",
    onClick: () => resolveCurrent(false),
    style: { zIndex: 9999 },
    children: _jsxs("div", {
      className: "modal-content",
      onClick: (e) => e.stopPropagation(),
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "confirm-title",
      style: { maxWidth: "420px" },
      children: [
        _jsx("header", {
          className: "modal-header",
          children: _jsx("h3", {
            id: "confirm-title",
            style: { color: pending.danger ? "var(--danger)" : "var(--text-primary)" },
            children: pending.title
          })
        }),
        _jsxs("div", {
          className: "modal-body",
          style: { paddingBottom: "1rem" },
          children: [
            pending.message &&
              _jsx("p", { className: "muted", style: { margin: 0 }, children: pending.message }),
            pending.details &&
              pending.details.length > 0 &&
              _jsx("ul", {
                style: {
                  color: "var(--text-muted)",
                  fontSize: "0.85rem",
                  paddingLeft: "1.2rem",
                  marginTop: "1rem"
                },
                children: pending.details.map((d, i) => _jsx("li", { children: d }, i))
              })
          ]
        }),
        _jsxs("footer", {
          className: "modal-footer",
          children: [
            _jsx("button", {
              className: "ghost",
              onClick: () => resolveCurrent(false),
              children: pending.cancelLabel ?? "Cancel"
            }),
            _jsx("button", {
              className: pending.danger ? "danger-btn" : "primary",
              onClick: () => resolveCurrent(true),
              autoFocus: true,
              children: pending.confirmLabel ?? "Confirm"
            })
          ]
        }),
        _jsx("style", {
          dangerouslySetInnerHTML: {
            __html: `
          .danger-btn { background: var(--danger); color: white; border: none; padding: 0.75rem 1.5rem; border-radius: var(--radius-md); font-weight: 600; cursor: pointer; transition: var(--transition); }
          .danger-btn:hover { background: #dc2626; transform: translateY(-1px); box-shadow: var(--shadow-sm); }
        `
          }
        })
      ]
    })
  });
}
