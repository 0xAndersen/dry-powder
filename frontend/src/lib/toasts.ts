export type Toast = {
  id: number;
  tone: "info" | "ok" | "warn" | "error";
  title: string;
  body?: string;
  /** Unix ms after which it disappears. */
  expires: number;
};

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const toastStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get: (): Toast[] => toasts,
  dismiss(id: number): void {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  },
};

const EMPTY: Toast[] = [];
export const emptyToasts = (): Toast[] => EMPTY;

export function toast(tone: Toast["tone"], title: string, body?: string, ttlMs = 7_000): void {
  const id = nextId++;
  toasts = [...toasts.slice(-4), { id, tone, title, body, expires: Date.now() + ttlMs }];
  emit();
  setTimeout(() => toastStore.dismiss(id), ttlMs);
}
