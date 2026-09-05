import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDeck } from "../store";
import { ensureOpened, getOrCreateTerminal } from "../terminals";
import { basename } from "../lib/paths";
import type { Session } from "../types";

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
  const initialStatus = useRef(session?.status);

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
  }, [sessionId, active]);

  const title = session?.title || "Untitled session";
  const project = basename(session?.cwd ?? null);
  const status = session?.status ?? "dormant";

  return (
    <div
      className="absolute inset-0 flex min-h-0 flex-col"
      style={{ display: active ? "flex" : "none" }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[status]}`} aria-hidden="true" />
        <span className="truncate text-sm font-medium text-ink">{title}</span>
        <span className="text-xs text-ink-faint" aria-hidden="true">
          ·
        </span>
        <span className="truncate text-xs text-ink-faint">{project}</span>
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
      </div>
    </div>
  );
}
