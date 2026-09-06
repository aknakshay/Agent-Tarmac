import { useCallback, useEffect, useState } from "react";

/**
 * Minimal transient toast, first used for "Snapshot copied" feedback after
 * the share-card action. Auto-dismisses; not focus-stealing (aria-live
 * polite, not an alert) since it's confirming something the user just did,
 * not asking for attention.
 */
export interface ToastState {
  id: number;
  message: string;
}

const AUTO_DISMISS_MS = 3200;

export function useToast() {
  const [toast, setToastState] = useState<ToastState | null>(null);

  const showToast = useCallback((message: string) => {
    setToastState({ id: Date.now(), message });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToastState(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return { toast, showToast };
}

export function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-surface px-4 py-2 text-sm text-ink shadow-lg"
    >
      {toast.message}
    </div>
  );
}
