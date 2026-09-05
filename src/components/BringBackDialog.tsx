import { useEffect } from "react";

interface BringBackDialogProps {
  sessionTitle: string;
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Confirmation dialog shown before bringing a popped-out session back from
 * Ghostty. Styled like `NewSessionDialog` (fixed overlay + card). Closes on
 * Escape or backdrop click; "Bring back" triggers `onConfirm`.
 *
 * A browser `confirm()` is intentionally NOT used here (product requirement).
 */
export function BringBackDialog({ sessionTitle, onConfirm, onCancel }: BringBackDialogProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bring session back to Tarmac"
        className="z-50 w-full max-w-sm overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-semibold text-ink">Bring session back?</span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint hover:bg-surface-hover hover:text-ink-muted"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-ink-muted">
            The Ghostty window running{" "}
            <span className="font-medium text-ink">{sessionTitle}</span> will be closed.
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="flex h-9 flex-1 items-center justify-center rounded-md border border-border text-sm font-medium text-ink-muted transition-colors duration-100 hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="flex h-9 flex-1 items-center justify-center rounded-md bg-accent text-sm font-medium text-app-bg transition-opacity duration-150 hover:opacity-90"
            >
              Bring back to Tarmac
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 fill-none stroke-current"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
