import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDeck } from "../store";

const RESUME_GAP_MS = 250;

interface Workspace {
  live_session_ids: string[];
  open_session_ids: string[];
  favorites: string[];
}

async function fetchAndClearLiveIds(): Promise<void> {
  // Read-modify-write against the latest workspace rather than a value
  // captured at mount, so a concurrent favorites/open_session_ids change
  // (e.g. from closing a pane) isn't clobbered.
  const ws = await invoke<Workspace>("get_workspace");
  if (ws.live_session_ids.length === 0) return;
  await invoke("set_workspace", { ws: { ...ws, live_session_ids: [] } });
}

/**
 * Offers to relaunch the sessions that were running the last time the app
 * closed. Evaluated once, after the session index has loaded for the first
 * time — evaluating earlier would see every id as "missing" and either skip
 * restorable sessions or wrongly clear them.
 */
export function RestoreBanner() {
  const sessions = useDeck((state) => state.sessions);
  const sessionsLoaded = useDeck((state) => state.sessionsLoaded);
  const focus = useDeck((state) => state.focus);

  const [candidateIds, setCandidateIds] = useState<string[] | null>(null);
  const [restoring, setRestoring] = useState(false);
  const evaluated = useRef(false);

  useEffect(() => {
    if (!sessionsLoaded || evaluated.current) return;
    evaluated.current = true;

    invoke<Workspace>("get_workspace")
      .then((ws) => {
        if (ws.live_session_ids.length === 0) return;

        // A missing id (its transcript was deleted) is skipped, not treated
        // as "still running" — it neither blocks the banner nor counts
        // toward the restorable total. Anything present and non-dormant
        // means this window already restored it (or it's otherwise live),
        // so back off entirely rather than offering to restore it again.
        const alreadyRunning = ws.live_session_ids.some(
          (id) => sessions[id] && sessions[id].status !== "dormant",
        );
        if (alreadyRunning) return;

        const restorable = ws.live_session_ids.filter((id) => sessions[id]?.status === "dormant");

        if (restorable.length === 0) {
          fetchAndClearLiveIds().catch((err) =>
            console.error("Failed to clear stale workspace ids", err),
          );
          return;
        }

        setCandidateIds(restorable);
      })
      .catch((err) => console.error("Failed to load workspace", err));
  }, [sessionsLoaded, sessions]);

  if (!candidateIds || candidateIds.length === 0) return null;

  const handleRestore = async () => {
    setRestoring(true);
    for (let i = 0; i < candidateIds.length; i++) {
      try {
        await invoke("resume_session", { sessionId: candidateIds[i] });
      } catch (err) {
        console.error(`Failed to resume session ${candidateIds[i]}`, err);
      }
      if (i < candidateIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, RESUME_GAP_MS));
      }
    }
    focus(candidateIds[0]);
    try {
      await fetchAndClearLiveIds();
    } catch (err) {
      console.error("Failed to clear workspace after restore", err);
    }
    setCandidateIds(null);
    setRestoring(false);
  };

  const handleDismiss = () => {
    setCandidateIds(null);
    fetchAndClearLiveIds().catch((err) => console.error("Failed to dismiss workspace banner", err));
  };

  return (
    <div
      role="status"
      className="pointer-events-auto absolute inset-x-0 top-0 z-30 flex items-center gap-3 border-b border-border bg-surface/95 px-4 py-2 backdrop-blur-sm"
    >
      <RestoreIcon />
      <span className="flex-1 text-sm text-ink-muted">
        Restore workspace ({candidateIds.length} session{candidateIds.length === 1 ? "" : "s"})
      </span>
      <button
        type="button"
        onClick={handleRestore}
        disabled={restoring}
        className="flex h-7 items-center rounded-md bg-accent px-3 text-xs font-medium text-app-bg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {restoring ? "Restoring…" : "Restore"}
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        disabled={restoring}
        className="flex h-7 items-center rounded-md px-3 text-xs font-medium text-ink-faint transition-colors duration-100 hover:bg-surface-hover hover:text-ink-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        Dismiss
      </button>
    </div>
  );
}

function RestoreIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 fill-none stroke-current text-ink-faint"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9" />
      <path d="M2.5 12v-3h3" />
    </svg>
  );
}
