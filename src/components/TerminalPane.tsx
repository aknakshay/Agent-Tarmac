import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDeck } from "../store";
import { ensureOpened, getOrCreateTerminal, writeInfoLine } from "../terminals";
import { basename } from "../lib/paths";
import { displayTitle } from "../lib/session";
import { BringBackDialog } from "./BringBackDialog";
import { ChangesPanel } from "./ChangesPanel";
import { JetIcon } from "./JetIcon";
import { Logo } from "./icons/BrandMotifs";
import { defaultTerminal, terminalLabel } from "../lib/terminals";
import type { StatusChange } from "../types";

type PaneView = "terminal" | "changes";

const BRANCH_REFRESH_DEBOUNCE_MS = 300;

interface PopOutResult {
  app: string;
}

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

  // Current branch, shown as an always-visible chip in the header regardless
  // of which view (Terminal/Changes) is active. Fetched on mount/cwd change
  // and refreshed whenever this session's agent stops (same idle/needsYou
  // signal ChangesPanel refreshes on), so the chip doesn't go stale after a
  // commit or checkout the agent made.
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!cwd) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    invoke<string | null>("git_branch", { cwd })
      .then((result) => {
        if (!cancelled) setBranch(result);
      })
      .catch((err) => {
        console.error(`git_branch failed for session ${sessionId}`, err);
        if (!cancelled) setBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, cwd]);

  useEffect(() => {
    if (!cwd) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const statusChanged = listen<StatusChange>("session_status_changed", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      if (event.payload.status !== "idle" && event.payload.status !== "needsYou") return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        invoke<string | null>("git_branch", { cwd })
          .then(setBranch)
          .catch((err) => console.error(`git_branch refresh failed for session ${sessionId}`, err));
      }, BRANCH_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timeout) clearTimeout(timeout);
      statusChanged.then((unlisten) => unlisten());
    };
  }, [sessionId, cwd]);

  // The Rust ExternalSessions state is the authority on popped-out sessions;
  // the store's externalIds mirrors it (seeded at startup from the backend's
  // reconciliation, updated by the actions below), so "Bring back" survives
  // an app relaunch instead of resetting with pane-local state.
  const externalIds = useDeck((state) => state.externalIds);
  const setSessionExternal = useDeck((state) => state.setSessionExternal);
  const isPoppedOut = externalIds.includes(sessionId);
  const setIsPoppedOut = (external: boolean) => setSessionExternal(sessionId, external);

  // ── Bring-back state ─────────────────────────────────────────────────────
  const [showBringBackConfirm, setShowBringBackConfirm] = useState(false);
  const [bringingBack, setBringingBack] = useState(false);
  const [bringBackError, setBringBackError] = useState<string | null>(null);

  const handleStop = () => {
    setStopping(true);
    invoke("stop_session", { sessionId })
      .catch((err) => console.error(`stop_session failed for session ${sessionId}`, err))
      .finally(() => setStopping(false));
  };

  const availableTerminals = useDeck((state) => state.availableTerminals);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const popOutDefault = defaultTerminal(availableTerminals);

  // Per-pane Terminal ⇄ Changes view. Local state (not persisted) — each pane
  // starts on the terminal, same as every other view toggle in the app.
  const [paneView, setPaneView] = useState<PaneView>("terminal");

  const handlePopOut = (terminal: string) => {
    setTerminalMenuOpen(false);
    setPoppingOut(true);
    setPopOutError(null);
    invoke<PopOutResult>("pop_out_to_ghostty", { sessionId, terminal })
      .then((result) => {
        writeInfoLine(
          sessionId,
          `popped out to ${terminalLabel(result.app)} — this pane is now read-only until resumed here`,
        );
        setIsPoppedOut(true);
      })
      .catch((err) => setPopOutError(String(err)))
      .finally(() => setPoppingOut(false));
  };

  const handleBringBack = () => {
    setBringingBack(true);
    setBringBackError(null);
    setShowBringBackConfirm(false);
    invoke("bring_back_session", { sessionId })
      .then(() => {
        // Whether the external process was found+stopped or wasn't running
        // (NotRunning outcome), we resume into Tarmac's PTY either way.
        setIsPoppedOut(false);
        return invoke("resume_session", { sessionId });
      })
      .catch((err) => setBringBackError(String(err)))
      .finally(() => setBringingBack(false));
  };

  return (
    <div
      className="absolute inset-0 flex min-h-0 flex-col"
      style={{ display: active ? "flex" : "none" }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <JetIcon status={status} external={isPoppedOut} className="h-3 w-3" />
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
            data-app-editable
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

        {/* Always-visible current-branch chip — visible in both Terminal and
            Changes views, secondary to the project name. Hidden entirely
            when there's no cwd or the cwd isn't a git repo (git_branch
            resolves null). */}
        {branch && (
          <span
            className="flex min-w-0 shrink items-center gap-1 text-[11px] text-ink-faint"
            title={branch}
          >
            <BranchIcon />
            <span className="min-w-0 truncate">{branch}</span>
          </span>
        )}

        {/* Terminal ⇄ Changes segmented toggle. The terminal stays mounted
            underneath either way (see the `hidden` toggling below) so its
            xterm scrollback/PTY wiring never gets torn down. */}
        <div className="flex shrink-0 items-center rounded-md border border-border p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setPaneView("terminal")}
            aria-pressed={paneView === "terminal"}
            className={`rounded-sm px-2 py-0.5 font-medium transition-colors ${
              paneView === "terminal" ? "bg-surface-hover text-ink" : "text-ink-faint hover:text-ink-muted"
            }`}
          >
            Terminal
          </button>
          <button
            type="button"
            onClick={() => setPaneView("changes")}
            aria-pressed={paneView === "changes"}
            className={`rounded-sm px-2 py-0.5 font-medium transition-colors ${
              paneView === "changes" ? "bg-surface-hover text-ink" : "text-ink-faint hover:text-ink-muted"
            }`}
          >
            Changes
          </button>
        </div>

        {/* "Bring back to Tarmac" — shown only when this session is popped out */}
        {isPoppedOut && !bringingBack && (
          <button
            type="button"
            title="Bring this session back to Tarmac"
            onClick={() => setShowBringBackConfirm(true)}
            className="ml-auto flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-ink-muted transition-colors duration-100 hover:border-accent/50 hover:text-accent"
          >
            <BringBackIcon />
            Bring back
          </button>
        )}
        {isPoppedOut && bringingBack && (
          <span className="ml-auto flex h-6 shrink-0 items-center gap-1.5 px-2 text-xs text-ink-faint">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-faint border-t-transparent" />
            Bringing back…
          </span>
        )}

        {/* Pop-out control: main click opens the default detected terminal;
            the ⋯ reveals every other installed terminal for a per-use pick. */}
        {cwd && !isPoppedOut && (
          <div
            className={`relative flex shrink-0 items-center ${status !== "dormant" ? "" : "ml-auto"}`}
          >
            <button
              type="button"
              title={`Open in ${terminalLabel(popOutDefault)}`}
              onClick={() => handlePopOut(popOutDefault)}
              disabled={poppingOut}
              className={`flex h-6 items-center gap-1.5 border border-border px-2 text-xs font-medium text-ink-muted transition-colors duration-100 hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 ${
                availableTerminals.length > 1 ? "rounded-l-md border-r-0" : "rounded-md"
              }`}
            >
              <PopOutIcon />
              Open in {terminalLabel(popOutDefault)}
            </button>
            {availableTerminals.length > 1 && (
              <button
                type="button"
                title="Open in another terminal…"
                aria-haspopup="menu"
                aria-expanded={terminalMenuOpen}
                onClick={() => setTerminalMenuOpen((open) => !open)}
                disabled={poppingOut}
                className="flex h-6 items-center rounded-r-md border border-border px-1 text-xs text-ink-muted transition-colors duration-100 hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <EllipsisIcon />
              </button>
            )}
            {terminalMenuOpen && (
              <>
                {/* Click-away layer */}
                <div className="fixed inset-0 z-40" onClick={() => setTerminalMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute top-7 right-0 z-50 min-w-32 rounded-md border border-border bg-surface py-1 shadow-lg"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setTerminalMenuOpen(false);
                  }}
                >
                  {availableTerminals.map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="menuitem"
                      onClick={() => handlePopOut(key)}
                      className="flex w-full items-center px-3 py-1.5 text-left text-xs text-ink-muted transition-colors duration-100 hover:bg-app-bg hover:text-accent"
                    >
                      {terminalLabel(key)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {status !== "dormant" && !isPoppedOut && (
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
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Bottom padding is deliberately asymmetric (pb-2 vs pt-1): it keeps
            the last terminal row clear of the pane edge without shifting the
            header's tight spacing above. FitAddon measures this container,
            so the padding is already accounted for on every refit.
            Hidden (not unmounted) when the Changes view is active, so the
            xterm instance and its PTY wiring survive the toggle. */}
        <div ref={containerRef} className="h-full w-full px-2 pt-1 pb-2" hidden={paneView !== "terminal"} />
        {/* Static brand watermark. Kept as a DOM overlay above the xterm
            canvas (rather than composited into its background) so it works
            identically whether xterm is using the WebGL or canvas renderer,
            and never risks the WebGL renderer's transparency handling. Kill
            switch: --watermark-opacity in index.css. */}
        {paneView === "terminal" && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-3 bottom-3 h-14 w-14 text-ink"
            style={{ opacity: "var(--watermark-opacity)" }}
          >
            <Logo className="h-full w-full" />
          </div>
        )}
        {paneView === "terminal" && resumeError && (
          <div
            role="alert"
            className="absolute inset-x-2 top-2 rounded-md border border-needs-you/40 bg-surface px-3 py-2 text-xs text-needs-you"
          >
            Couldn't resume this session: {resumeError}
          </div>
        )}
        {paneView === "terminal" && popOutError && (
          <div
            role="alert"
            className="absolute inset-x-2 top-2 rounded-md border border-needs-you/40 bg-surface px-3 py-2 text-xs text-needs-you"
          >
            Couldn't pop out: {popOutError}
          </div>
        )}
        {paneView === "terminal" && bringBackError && (
          <div
            role="alert"
            className="absolute inset-x-2 top-2 rounded-md border border-needs-you/40 bg-surface px-3 py-2 text-xs text-needs-you"
          >
            Couldn't bring back session: {bringBackError}
          </div>
        )}
        {paneView === "changes" && (
          <div className="absolute inset-0">
            <ChangesPanel sessionId={sessionId} cwd={cwd} />
          </div>
        )}
      </div>

      {showBringBackConfirm && (
        <BringBackDialog
          sessionTitle={title}
          onConfirm={handleBringBack}
          onCancel={() => setShowBringBackConfirm(false)}
        />
      )}
    </div>
  );
}

function BranchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-[11px] w-[11px] shrink-0 fill-none stroke-current"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Two nodes (top-right, bottom-left) joined by a fork line — a
          minimal git-branch glyph. */}
      <circle cx="11.5" cy="4" r="1.6" />
      <circle cx="4.5" cy="12" r="1.6" />
      <path d="M4.5 10.4V7a2.5 2.5 0 0 1 2.5-2.5h3" />
    </svg>
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

function EllipsisIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0 fill-current" aria-hidden="true">
      <circle cx="4" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12" cy="8" r="1.2" />
    </svg>
  );
}

function BringBackIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 fill-none stroke-current"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {/* Arrow pointing back into the app */}
      <path d="M10 3H12.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 13l-4-4 4-4M3 9h6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
