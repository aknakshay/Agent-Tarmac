import { useMemo, useState } from "react";
import { useDeck } from "../store";
import type { Session } from "../types";
import { SessionRow } from "./SessionRow";
import { basename } from "../lib/paths";

const DORMANT_VISIBLE_LIMIT = 15;
const FAVORITES_KEY = "__favorites__";
const NO_PROJECT_KEY = "__no_project__";

interface Group {
  key: string;
  label: string;
  sessions: Session[];
  mostRecent: number;
}

function byLastActivityDesc(a: Session, b: Session): number {
  return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
}

interface SidebarProps {
  onOpenCommandBar(): void;
  onOpenNewSession(): void;
}

export function Sidebar({ onOpenCommandBar, onOpenNewSession }: SidebarProps) {
  const sessions = useDeck((state) => state.sessions);
  const activeId = useDeck((state) => state.activeId);
  const focus = useDeck((state) => state.focus);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);

  const all = useMemo(() => Object.values(sessions), [sessions]);

  const { groups, hiddenDormantCount } = useMemo(() => {
    const favorites = all.filter((s) => s.favorite);
    const rest = all.filter((s) => !s.favorite);

    const dormantSorted = rest.filter((s) => s.status === "dormant").sort(byLastActivityDesc);
    const visibleDormantIds = new Set(dormantSorted.slice(0, DORMANT_VISIBLE_LIMIT).map((s) => s.id));
    const hiddenDormantCount = Math.max(0, dormantSorted.length - DORMANT_VISIBLE_LIMIT);

    const visibleRest = rest.filter(
      (s) => s.status !== "dormant" || showHistory || visibleDormantIds.has(s.id),
    );

    const byProject = new Map<string, Session[]>();
    for (const session of visibleRest) {
      const key = session.cwd ?? NO_PROJECT_KEY;
      const group = byProject.get(key);
      if (group) group.push(session);
      else byProject.set(key, [session]);
    }

    const groups: Group[] = [];

    if (favorites.length > 0) {
      const sorted = [...favorites].sort(byLastActivityDesc);
      groups.push({
        key: FAVORITES_KEY,
        label: "Favorites",
        sessions: sorted,
        mostRecent: Infinity,
      });
    }

    for (const [key, groupSessions] of byProject) {
      const sorted = [...groupSessions].sort(byLastActivityDesc);
      groups.push({
        key,
        label: basename(key === NO_PROJECT_KEY ? null : key),
        sessions: sorted,
        mostRecent: new Date(sorted[0].lastActivity).getTime(),
      });
    }

    groups.sort((a, b) => b.mostRecent - a.mostRecent);

    return { groups, hiddenDormantCount };
  }, [all, showHistory]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
        <span className="flex-1 text-sm font-semibold text-ink">Claude Deck</span>
        <button
          type="button"
          onClick={onOpenCommandBar}
          aria-label="Jump to session"
          title="Jump to session (⌘K)"
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint hover:bg-surface-hover hover:text-ink-muted"
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          onClick={onOpenNewSession}
          aria-label="New session"
          title="New session (⌘N)"
          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint hover:bg-surface-hover hover:text-ink-muted"
        >
          <PlusIcon />
        </button>
      </div>

      {all.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <p className="text-sm font-medium text-ink-muted">No sessions yet</p>
          <p className="text-xs text-ink-faint">Claude Code sessions will appear here as they start.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {groups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.key);
            return (
              <div key={group.key} className="mb-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold tracking-wide text-ink-faint uppercase hover:text-ink-muted"
                >
                  <ChevronIcon collapsed={isCollapsed} />
                  <span className="truncate">{group.label}</span>
                  <span className="ml-auto font-normal normal-case text-ink-faint">
                    {group.sessions.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="flex flex-col gap-0.5">
                    {group.sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeId}
                        onSelect={() => focus(session.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hiddenDormantCount > 0 && (
        <div className="border-t border-border px-2 py-2">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="w-full rounded-md px-2 py-1.5 text-xs font-medium text-ink-faint hover:bg-surface-hover hover:text-ink-muted"
          >
            {showHistory ? "Hide history" : `Show history (${hiddenDormantCount})`}
          </button>
        </div>
      )}
    </aside>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 fill-none stroke-current"
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
      className="h-3.5 w-3.5 fill-none stroke-current"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3 w-3 shrink-0 fill-none stroke-current transition-transform duration-150 ${
        collapsed ? "-rotate-90" : ""
      }`}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
