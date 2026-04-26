export type ToastKind = "success" | "error" | "info" | "warning";
export type Toast = { id: string; kind: ToastKind; message: string; createdAt: number };

type Listener = (toasts: Toast[]) => void;

const listeners = new Set<Listener>();
let toasts: Toast[] = [];

function emit(): void {
  for (const l of listeners) l(toasts);
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

export function pushToast(kind: ToastKind, message: string, ttlMs = 5000): string {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  toasts = [...toasts, { id, kind, message, createdAt: Date.now() }];
  emit();
  if (ttlMs > 0) {
    setTimeout(() => dismissToast(id), ttlMs);
  }
  return id;
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (msg: string) => pushToast("success", msg),
  error: (msg: string) => pushToast("error", msg, 8000),
  info: (msg: string) => pushToast("info", msg),
  warning: (msg: string) => pushToast("warning", msg, 7000)
};
