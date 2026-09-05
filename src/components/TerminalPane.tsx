import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDeck } from "../store";
import { ensureOpened, getOrCreateTerminal, writeInfoLine } from "../terminals";
import { basename } from "../lib/paths";
import { displayTitle } from "../lib/session";
import type { Session } from "../types";

interface PopOutResult {
  app: "ghostty" | "terminal";
}

const STATUS_DOT_CLASS: Record<Session["status"], string> = {
  working: "bg-working animate-pulse",
  needsYou: "bg-needs-you",
  idle: "bg-ink-faint",
  dormant: "border border-ink-faint bg-transparent",
};

const RESIZE_DEBOUNCE_MS = 100;

interface TerminalPaneProps {
  sessionId: string;
  active: boolean;
}

export function TerminalPane({ sessionId, active }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resumeAttempted = useRef(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const session = useDeck((state) => state.sessions[sessionId]);
  const setCustomTitle = useDeck((state) => state.setCustomTitle);
  const initialStatus = useRef(session?.status);
  const [renamingTitle, setRenamingTitle] = useState(false);

  // Mount once: open the terminal into this pane's container, resuming a
  // dormant session's PTY first if it isn't already running.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    ensureOpened(sessionId, container);

    if (!resumeAttempted.current && initialStatus.current === "dormant") {
      resumeAttempted.current = true;
      invoke("resume_session", { sessionId }).catch((err) => {
        setResumeError(String(err));
      });
    }
    // Runs once per pane mount; sessionId is stable for the pane's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Keep the terminal fitted to its container, and let the PTY know the new
  // rows/cols whenever the pane resizes (including becoming visible again).
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { fit, term } = getOrCreateTerminal(sessionId);

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const doFit = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.rows === 0 || term.cols === 0) return;
      invoke("resize_pty", { sessionId, rows: term.rows, cols: term.cols }).catch((err) => {
        console.error(`resize_pty failed for session ${sessionId}`, err);
      });
    };

    const observer = new ResizeObserver(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(doFit, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    if (active) doFit();

    return () => {
      if (timeout) clearTimeout(timeout);
      observer.disconnect();
    };
    // `active` is intentionally in the dependency array: this effect (and
    // its observer) is torn down and recreated on every active toggle, so
    // the `if (active) doFit()` above re-runs and re-fits the terminal every
    // time this pane regains focus — that's what keeps a background pane's
    // stale xterm dimensions from showing on refocus, not an optimization
    // to remove.
  }, [sessionId, active]);

  const title = session ? displayTitle(session) : "Untitled session";
  const project = basename(session?.cwd ?? null);
  const status = session?.status ?? "dormant";
  const cwd = session?.cwd ?? null;
  const [stopping, setStopping] = useState(false);
  const [poppingOut, setPoppingOut] = useState(false);
  const [popOutError, setPopOutError] = useState<string | null>(null);

  const handleStop = () => {
    setStopping(true);
    invoke("stop_session", { sessionId })
      .catch((err) => console.error(`stop_session failed for session ${sessionId}`, err))
      .finally(() => setStopping(false));
  };

  const handlePopOut = () => {
    setPoppingOut(true);
    setPopOutError(null);
    invoke<PopOutResult>("pop_out_to_ghostty", { sessionId })
      .then((result) => {
        writeInfoLine(
          sessionId,
          `popped out to ${result.app === "ghostty" ? "Ghostty" : "Terminal"} — this pane is now read-only until resumed here`,
        );
      })
      .catch((err) => setPopOutError(String(err)))
      .finally(() => setPoppingOut(false));
  };

  return (
    <div
      className="absolute inset-0 flex min-h-0 flex-col"
      style={{ display: active ? "flex" : "none" }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[status]}`} aria-hidden="true" />
        {renamingTitle ? (
          <input
            autoFocus
            defaultValue={title}
            onBlur={(e) => {
              setCustomTitle(sessionId, e.target.value);
              setRenamingTitle(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setCustomTitle(sessionId, e.currentTarget.value);
                setRenamingTitle(false);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenamingTitle(false);
              }
            }}
            aria-label="Rename session"
            className="h-6 min-w-0 flex-1 rounded-md border border-accent/50 bg-app-bg px-1.5 text-sm text-ink focus:outline-none"
          />
        ) : (
          <span
            className="cursor-text truncate text-sm font-medium text-ink"
            title="Double-click to rename"
            onDoubleClick={() => setRenamingTitle(true)}
          >
            {title}
          </span>
        )}
        <span className="text-xs text-ink-faint" aria-hidden="true">
          ·
        </span>
        <span className="truncate text-xs text-ink-faint">{project}</span>
        {cwd && (
          <button
            type="button"
            title="Open in Ghostty"
            onClick={handlePopOut}
            disabled={poppingOut}
            className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-ink-muted transition-colors duration-100 hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 ${
              status !== "dormant" ? "" : "ml-auto"
            }`}
          >
            <PopOutIcon />
            Open in Ghostty
          </button>
        )}
        {status !== "dormant" && (
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            className="ml-auto flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-ink-muted transition-colors duration-100 hover:border-needs-you/50 hover:text-needs-you disabled:cursor-not-allowed disabled:opacity-50"
          >
            <StopIcon />
            Stop
          </button>
        )}
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full px-2 py-1" />
        {resumeError && (
          <div
            role="alert"
            className="absolute inset-x-2 top-2 rounded-md border border-needs-you/40 bg-surface px-3 py-2 text-xs text-needs-you"
          >
            Couldn't resume this session: {resumeError}
          </div>
        )}
        {popOutError && (
          <div
            role="alert"
            className="absolute inset-x-2 top-2 rounded-md border border-needs-you/40 bg-surface px-3 py-2 text-xs text-needs-you"
          >
            Couldn't pop out to Ghostty: {popOutError}
          </div>
        )}
      </div>
    </div>
  );
}

function StopIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 fill-current"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function PopOutIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 fill-none stroke-current"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M6 3H3.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 3h4v4M13 3 7 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
