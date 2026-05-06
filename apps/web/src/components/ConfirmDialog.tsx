import { useEffect, useState } from "react";
import { resolveCurrent, subscribeConfirm, type PendingConfirm } from "../lib/confirm";

export function ConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  useEffect(() => subscribeConfirm(setPending), []);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") resolveCurrent(false);
      if (e.key === "Enter") resolveCurrent(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  if (!pending) return null;

  return (
    <div className="modal-overlay" onClick={() => resolveCurrent(false)} style={{ zIndex: 9999 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        style={{ maxWidth: "420px" }}
      >
        <header className="modal-header">
          <h3 id="confirm-title" style={{ color: pending.danger ? "var(--danger)" : "var(--text-primary)" }}>
            {pending.title}
          </h3>
        </header>

        <div className="modal-body" style={{ paddingBottom: "1rem" }}>
          {pending.message && (
            <p className="muted" style={{ margin: 0 }}>
              {pending.message}
            </p>
          )}
          {pending.details && pending.details.length > 0 && (
            <ul
              style={{
                color: "var(--text-muted)",
                fontSize: "0.85rem",
                paddingLeft: "1.2rem",
                marginTop: "1rem"
              }}
            >
              {pending.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>

        <footer className="modal-footer">
          <button className="ghost" onClick={() => resolveCurrent(false)}>
            {pending.cancelLabel ?? "Cancel"}
          </button>
          <button
            className={pending.danger ? "danger-btn" : "primary"}
            onClick={() => resolveCurrent(true)}
            autoFocus
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </footer>

        <style
          dangerouslySetInnerHTML={{
            __html: `
          .danger-btn { background: var(--danger); color: white; border: none; padding: 0.75rem 1.5rem; border-radius: var(--radius-md); font-weight: 600; cursor: pointer; transition: var(--transition); }
          .danger-btn:hover { background: #dc2626; transform: translateY(-1px); box-shadow: var(--shadow-sm); }
        `
          }}
        />
      </div>
    </div>
  );
}
