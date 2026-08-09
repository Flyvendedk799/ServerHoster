export type Toast = {
  id: string;
  tone: "success" | "error" | "info";
  message: string;
};

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let counter = 0;

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

function push(tone: Toast["tone"], message: string): void {
  counter += 1;
  const id = `t${counter}`;
  toasts = [...toasts, { id, tone, message }];
  emit();
  setTimeout(() => dismiss(id), tone === "error" ? 6000 : 3000);
}

export function dismiss(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (message: string) => push("success", message),
  error: (message: string) => push("error", message),
  info: (message: string) => push("info", message)
};

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}
