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
    <div className="modal-backdrop" onClick={() => resolveCurrent(false)}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        style={{ maxWidth: "460px" }}
      >
        <h3 id="confirm-title" style={{ color: pending.danger ? "var(--danger)" : undefined }}>
          {pending.title}
        </h3>
        {pending.message && <p style={{ color: "var(--text-secondary)" }}>{pending.message}</p>}
        {pending.details && pending.details.length > 0 && (
          <ul style={{ color: "var(--text-muted)", fontSize: "0.85rem", paddingLeft: "1.1rem" }}>
            {pending.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
          <button className="btn-ghost" onClick={() => resolveCurrent(false)}>
            {pending.cancelLabel ?? "Cancel"}
          </button>
          <button
            className={pending.danger ? "btn-danger" : ""}
            onClick={() => resolveCurrent(true)}
            autoFocus
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
