import { useEffect, useMemo, useRef, useState } from "react";
import { useDeck } from "../store";
import type { Session } from "../types";
import { basename } from "../lib/paths";
import { displayTitle } from "../lib/session";

const STATUS_DOT_CLASS: Record<Session["status"], string> = {
  working: "bg-working animate-pulse",
  needsYou: "bg-needs-you",
  idle: "bg-ink-faint",
  dormant: "border border-ink-faint bg-transparent",
};

const MAX_RESULTS = 12;

interface CommandBarProps {
  onClose(): void;
  onFocusSession(id: string): void;
  onNewSession(): void;
}

/** Ranks a session against a query: prefix match > word-boundary match > substring match. Higher is better. */
function score(session: Session, query: string): number {
  const title = displayTitle(session).toLowerCase();
  const cwd = (session.cwd ?? "").toLowerCase();
  const project = basename(session.cwd).toLowerCase();

  let best = -1;
  for (const field of [title, project, cwd]) {
    if (!field.includes(query)) continue;
    if (field.startsWith(query)) best = Math.max(best, 3);
    else if (new RegExp(`[\\s/_-]${escapeRegExp(query)}`).test(field)) best = Math.max(best, 2);
    else best = Math.max(best, 1);
  }
  return best;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function CommandBar({ onClose, onFocusSession, onNewSession }: CommandBarProps) {
  const sessions = useDeck((state) => state.sessions);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.values(sessions);
    if (!q) {
      return [...all]
        .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime())
        .slice(0, MAX_RESULTS);
    }
    return all
      .map((session) => ({ session, rank: score(session, q) }))
      .filter((entry) => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.session);
  }, [sessions, query]);

  // Row count includes the pinned "New session…" action at the bottom.
  const rowCount = results.length + 1;

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-index="${selected}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const commit = (index: number) => {
    if (index < results.length) {
      onFocusSession(results[index].id);
    } else {
      onNewSession();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (i + 1) % rowCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (i - 1 + rowCount) % rowCount);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(selected);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to session"
        className="z-50 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Jump to a session…"
            aria-label="Jump to a session"
            data-app-editable
            className="h-11 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-ink-faint">esc</kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 && query.trim() && (
            <p className="px-3 py-3 text-sm text-ink-faint">No sessions match "{query.trim()}".</p>
          )}

          {results.map((session, index) => (
            <button
              key={session.id}
              type="button"
              data-index={index}
              onMouseEnter={() => setSelected(index)}
              onClick={() => commit(index)}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-100 ${
                selected === index ? "bg-surface-hover" : ""
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[session.status]}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{displayTitle(session)}</span>
              <span className="shrink-0 truncate text-xs text-ink-faint">{basename(session.cwd)}</span>
            </button>
          ))}

          <button
            type="button"
            data-index={results.length}
            onMouseEnter={() => setSelected(results.length)}
            onClick={() => commit(results.length)}
            className={`mt-0.5 flex w-full items-center gap-2 rounded-md border-t border-border px-2.5 py-2 text-left transition-colors duration-100 ${
              selected === results.length ? "bg-surface-hover" : ""
            }`}
          >
            <PlusIcon />
            <span className="text-sm text-ink-muted">New session…</span>
            <kbd className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-ink-faint">
              ⌘N
            </kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 fill-none stroke-current text-ink-faint"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5" />
      <path d="M11 11l3.5 3.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 fill-none stroke-current text-ink-faint"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
