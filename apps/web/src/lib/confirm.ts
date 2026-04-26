export type ConfirmOptions = {
  title: string;
  message?: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type PendingConfirm = ConfirmOptions & {
  id: string;
  resolve: (value: boolean) => void;
};

type Listener = (pending: PendingConfirm | null) => void;
const listeners = new Set<Listener>();
let current: PendingConfirm | null = null;

function emit(): void {
  for (const l of listeners) l(current);
}

export function subscribeConfirm(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (current) current.resolve(false);
    current = { ...options, id, resolve };
    emit();
  });
}

export function resolveCurrent(value: boolean): void {
  if (!current) return;
  const resolve = current.resolve;
  current = null;
  emit();
  resolve(value);
}
