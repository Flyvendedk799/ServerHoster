import { useEffect, useState } from "react";
import { dismiss, subscribeToasts } from "../lib/toast";
import type { Toast } from "../lib/toast";

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setItems), []);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <button key={item.id} className={`toast toast-${item.tone}`} onClick={() => dismiss(item.id)}>
          {item.message}
        </button>
      ))}
    </div>
  );
}
