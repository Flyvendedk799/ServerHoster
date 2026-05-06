const listeners = new Set();
let current = null;
function emit() {
  for (const l of listeners) l(current);
}
export function subscribeConfirm(listener) {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
export function confirmDialog(options) {
  return new Promise((resolve) => {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (current) current.resolve(false);
    current = { ...options, id, resolve };
    emit();
  });
}
export function resolveCurrent(value) {
  if (!current) return;
  const resolve = current.resolve;
  current = null;
  emit();
  resolve(value);
}
