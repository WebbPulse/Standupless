/**
 * A module scoped queue of short notices, read by the Toaster. Kept free of
 * React and of any provider, so a write helper in `lib` can raise a notice
 * without the caller threading a context through, and so the queue works
 * whichever component happens to mount the Toaster.
 */

/** How a notice reads: a failure, or a plain confirmation. */
export type ToastTone = 'error' | 'info';

/** One notice on screen. */
export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

/** How long a notice stays before it dismisses itself. */
export const TOAST_TIMEOUT_MS = 5000;

/** The most notices shown at once; older ones give way. */
const TOAST_LIMIT = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Tells every subscriber the queue changed. */
const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Subscribes to queue changes, answering the unsubscribe. */
export const subscribeToasts = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The notices on screen now, oldest first. */
export const currentToasts = (): Toast[] => toasts;

/** Removes one notice, whether it timed out or was dismissed. */
export const dismissToast = (id: number): void => {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
};

/**
 * Raises a notice and answers its id. It dismisses itself after the timeout,
 * so a failure that nobody reads does not linger over the page.
 */
export const showToast = (
  message: string,
  tone: ToastTone = 'info'
): number => {
  const id = nextId;
  nextId += 1;
  toasts = [...toasts, { id, tone, message }].slice(-TOAST_LIMIT);
  timers.set(
    id,
    setTimeout(() => {
      dismissToast(id);
    }, TOAST_TIMEOUT_MS)
  );
  emit();
  return id;
};

/** Raises a failure notice, which is announced assertively. */
export const showErrorToast = (message: string): number =>
  showToast(message, 'error');

/** Clears every notice. Used between tests so one does not leak into another. */
export const clearToasts = (): void => {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts = [];
  emit();
};
