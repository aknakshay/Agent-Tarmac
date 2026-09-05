import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useDeck } from "../store";
import { basename } from "../lib/paths";

const RECENT_DIRS_LIMIT = 10;

interface NewSessionDialogProps {
  onClose(): void;
  onStarted(sessionId: string, cwd: string): void;
}

export function NewSessionDialog({ onClose, onStarted }: NewSessionDialogProps) {
  const sessions = useDeck((state) => state.sessions);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const recentDirs = useMemo(() => {
    const seen = new Set<string>();
    const dirs: string[] = [];
    const sorted = Object.values(sessions)
      .filter((s) => s.cwd)
      .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
    for (const session of sorted) {
      const cwd = session.cwd as string;
      if (seen.has(cwd)) continue;
      seen.add(cwd);
      dirs.push(cwd);
      if (dirs.length >= RECENT_DIRS_LIMIT) break;
    }
    return dirs;
  }, [sessions]);

  const startSession = async (cwd: string) => {
    setError(null);
    setStarting(cwd);
    try {
      const sessionId = await invoke<string>("start_new_session", { cwd });
      onStarted(sessionId, cwd);
    } catch (err) {
      setError(String(err));
      setStarting(null);
    }
  };

  const pickDirectory = async () => {
    setError(null);
    try {
      const selection = await open({ directory: true, multiple: false });
      if (typeof selection === "string") {
        await startSession(selection);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        className="z-50 w-full max-w-sm overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-semibold text-ink">New session</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint hover:bg-surface-hover hover:text-ink-muted"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <button
            type="button"
            onClick={pickDirectory}
            disabled={starting !== null}
            className="flex h-9 items-center justify-center gap-2 rounded-md bg-accent text-sm font-medium text-app-bg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FolderIcon />
            Choose directory…
          </button>

          {error && (
            <p role="alert" className="rounded-md border border-needs-you/40 bg-surface px-3 py-2 text-xs text-needs-you">
              {error}
            </p>
          )}

          {recentDirs.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="px-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
                Recent
              </span>
              <div className="flex flex-col gap-0.5">
                {recentDirs.map((cwd) => (
                  <button
                    key={cwd}
                    type="button"
                    onClick={() => startSession(cwd)}
                    disabled={starting !== null}
                    className="flex items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-100 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{basename(cwd)}</span>
                    <span className="shrink-0 truncate text-xs text-ink-faint">{cwd}</span>
                    {starting === cwd && (
                      <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-ink-faint border-t-transparent" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
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

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 fill-none stroke-current"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4.5z" />
    </svg>
  );
}
