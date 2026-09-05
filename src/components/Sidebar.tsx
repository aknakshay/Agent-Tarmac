import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDeck } from "../store";
import type { Session } from "../types";
import { SessionRow } from "./SessionRow";
import { SessionContextMenu } from "./SessionContextMenu";
import { ProjectGroupContextMenu } from "./ProjectGroupContextMenu";
import { displayProjectName } from "../lib/projectMeta";
import { Logo, OnApproachIllustration, RunwayDivider } from "./icons/BrandMotifs";

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
  const setCustomTitle = useDeck((state) => state.setCustomTitle);
  const setProjectName = useDeck((state) => state.setProjectName);
  const projectNames = useDeck((state) => state.projectNames);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<{ cwd: string; label: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingProjectCwd, setRenamingProjectCwd] = useState<string | null>(null);
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  // "checking" until the one-shot `claude --version` probe resolves; only
  // relevant for the empty-state hint below, so it's only kicked off once
  // there are no sessions to show.
  const [claudeCheck, setClaudeCheck] = useState<"checking" | "missing" | "found">("checking");

  const all = useMemo(() => Object.values(sessions), [sessions]);

  useEffect(() => {
    if (all.length > 0) return;
    invoke<string | null>("check_claude")
      .then((version) => setClaudeCheck(version ? "found" : "missing"))
      .catch(() => setClaudeCheck("missing"));
  }, [all.length]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const session of all) for (const tag of session.tags) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [all]);

  const toggleTagFilter = (tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const { groups, hiddenDormantCount } = useMemo(() => {
    const filtered =
      activeTags.size === 0 ? all : all.filter((s) => s.tags.some((tag) => activeTags.has(tag)));
    const favorites = filtered.filter((s) => s.favorite);
    const rest = filtered.filter((s) => !s.favorite);

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
      const cwd = key === NO_PROJECT_KEY ? null : key;
      groups.push({
        key,
        label: displayProjectName(cwd, projectNames[key]),
        sessions: sorted,
        mostRecent: new Date(sorted[0].lastActivity).getTime(),
      });
    }

    groups.sort((a, b) => b.mostRecent - a.mostRecent);

    return { groups, hiddenDormantCount };
  }, [all, showHistory, activeTags, projectNames]);

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
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <Logo className="h-4 w-4 shrink-0 text-ink" />
        <span className="flex-1 text-sm font-semibold text-ink">Agent Tarmac</span>
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

      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-2">
          {allTags.map((tag) => {
            const isActive = activeTags.has(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTagFilter(tag)}
                aria-pressed={isActive}
                className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-100 ${
                  isActive ? "bg-accent text-app-bg" : "bg-surface-hover text-ink-muted hover:text-ink"
                }`}
              >
                {tag}
              </button>
            );
          })}
          {activeTags.size > 0 && (
            <button
              type="button"
              onClick={() => setActiveTags(new Set())}
              aria-label="Clear tag filters"
              title="Clear tag filters"
              className="rounded-full px-1.5 py-0.5 text-xs text-ink-faint hover:text-needs-you"
            >
              ×
            </button>
          )}
        </div>
      )}

      {all.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <OnApproachIllustration className="h-28 w-40 opacity-90" />
          <p className="text-sm font-medium text-ink-muted">Tower's clear</p>
          {claudeCheck === "missing" ? (
            <p className="max-w-[220px] text-xs text-needs-you">
              Couldn't find <code className="rounded bg-surface-hover px-1 py-0.5">claude</code> on your PATH.
              Install the Claude Code CLI, or start a session and it'll appear here.
            </p>
          ) : (
            <p className="text-xs text-ink-faint">Claude Code sessions will appear here as they start.</p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {groups.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-ink-faint">No sessions match the selected tags.</p>
          )}
          {groups.map((group, index) => {
            const isCollapsed = collapsedGroups.has(group.key);
            // Divider after the Favorites group only — it's the one place two
            // "live" groupings sit back to back (see motifs.md a).
            const showDividerBefore = index > 0 && groups[index - 1].key === FAVORITES_KEY;
            // Only real project groups (not Favorites, not no-project) are renameable.
            const isProjectGroup =
              group.key !== FAVORITES_KEY && group.key !== NO_PROJECT_KEY;
            const isRenamingThisProject = renamingProjectCwd === group.key;

            return (
              <div key={group.key} className="mb-1">
                {showDividerBefore && <RunwayDivider className="mb-2" />}
                {isRenamingThisProject ? (
                  <ProjectGroupRenameInput
                    currentLabel={group.label}
                    onCommit={(name) => {
                      setProjectName(group.key, name);
                      setRenamingProjectCwd(null);
                    }}
                    onCancel={() => setRenamingProjectCwd(null)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    onContextMenu={
                      isProjectGroup
                        ? (e) => {
                            e.preventDefault();
                            setProjectContextMenu({ cwd: group.key, label: group.label, x: e.clientX, y: e.clientY });
                          }
                        : undefined
                    }
                    aria-expanded={!isCollapsed}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold tracking-wide text-ink-faint uppercase hover:text-ink-muted"
                  >
                    <ChevronIcon collapsed={isCollapsed} />
                    <span className="truncate">{group.label}</span>
                    <span className="ml-auto font-normal normal-case text-ink-faint">
                      {group.sessions.length}
                    </span>
                  </button>
                )}
                {!isCollapsed && (
                  <div className="flex flex-col gap-0.5">
                    {group.sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeId}
                        onSelect={() => focus(session.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
                        }}
                        renaming={renamingId === session.id}
                        onRenameCommit={(title) => {
                          setCustomTitle(session.id, title);
                          setRenamingId(null);
                        }}
                        onRenameCancel={() => setRenamingId(null)}
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

      {contextMenu && sessions[contextMenu.sessionId] && (
        <SessionContextMenu
          session={sessions[contextMenu.sessionId]}
          x={contextMenu.x}
          y={contextMenu.y}
          allTags={allTags}
          onClose={() => setContextMenu(null)}
          onRequestRename={() => setRenamingId(contextMenu.sessionId)}
        />
      )}

      {projectContextMenu && (
        <ProjectGroupContextMenu
          cwd={projectContextMenu.cwd}
          currentLabel={projectContextMenu.label}
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          onClose={() => setProjectContextMenu(null)}
          onRequestRename={() => setRenamingProjectCwd(projectContextMenu.cwd)}
        />
      )}
    </aside>
  );
}

/** Inline rename input shown in place of the group header button. */
function ProjectGroupRenameInput({
  currentLabel,
  onCommit,
  onCancel,
}: {
  currentLabel: string;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  return (
    <input
      autoFocus
      defaultValue={currentLabel}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      aria-label="Rename project"
      data-app-editable
      className="h-7 w-full rounded-md border border-accent/50 bg-app-bg px-2 text-xs font-semibold tracking-wide text-ink uppercase focus:outline-none"
    />
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
