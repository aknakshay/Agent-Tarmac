import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

interface UpdateAvailablePayload {
  version: string;
  url: string;
}

/**
 * Slim top-of-window notice that a newer release exists on GitHub. Purely
 * reactive to the `update_available` event emitted by the Rust-side
 * background checker (see update_check.rs) — no polling, no persistence.
 * Dismissal is session-local only: a dismissed banner may reappear on the
 * next launch, which is intentional for v1.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateAvailablePayload | null>(null);
  const dismissedVersion = useRef<string | null>(null);

  useEffect(() => {
    // Keep the listen() promise itself rather than a `let fn` captured by a
    // later .then(); under StrictMode's dev-only mount->cleanup->remount,
    // cleanup can run before the promise resolves, which would otherwise
    // leak a listener.
    const updateAvailable = listen<UpdateAvailablePayload>("update_available", (event) => {
      if (event.payload.version === dismissedVersion.current) return;
      setUpdate(event.payload);
    });

    return () => {
      updateAvailable.then((unlisten) => unlisten());
    };
  }, []);

  if (!update) return null;

  const handleDismiss = () => {
    dismissedVersion.current = update.version;
    setUpdate(null);
  };

  return (
    <div
      role="status"
      className="pointer-events-auto absolute inset-x-0 top-0 z-30 flex items-center gap-3 border-b border-border bg-surface/95 px-4 py-2 backdrop-blur-sm"
    >
      <UpdateIcon />
      <span className="flex-1 text-sm text-ink-muted">
        Agent Tarmac {update.version} is available
      </span>
      <button
        type="button"
        onClick={() => openUrl(update.url).catch((err) => console.error("Failed to open release page", err))}
        className="flex h-7 items-center rounded-md bg-accent px-3 text-xs font-medium text-app-bg transition-opacity duration-150 hover:opacity-90"
      >
        View release
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        className="flex h-7 items-center rounded-md px-3 text-xs font-medium text-ink-faint transition-colors duration-100 hover:bg-surface-hover hover:text-ink-muted"
      >
        Dismiss
      </button>
    </div>
  );
}

function UpdateIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 fill-none stroke-current text-ink-faint"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v8" />
      <path d="M4.5 6.5 8 10l3.5-3.5" />
      <path d="M2.5 13h11" />
    </svg>
  );
}
