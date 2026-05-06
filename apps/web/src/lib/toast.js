const listeners = new Set();
let toasts = [];
function emit() {
  for (const l of listeners) l(toasts);
}
export function subscribeToasts(listener) {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
export function pushToast(kind, message, ttlMs = 5000) {
  const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  toasts = [...toasts, { id, kind, message, createdAt: Date.now() }];
  emit();
  if (ttlMs > 0) {
    setTimeout(() => dismissToast(id), ttlMs);
  }
  return id;
}
export function dismissToast(id) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}
export const toast = {
  success: (msg) => pushToast("success", msg),
  error: (msg) => pushToast("error", msg, 8000),
  info: (msg) => pushToast("info", msg),
  warning: (msg) => pushToast("warning", msg, 7000)
};
