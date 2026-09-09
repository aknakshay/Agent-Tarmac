import { useEffect, useRef, useState } from "react";
import type { Session } from "../types";
import { relativeTime } from "../lib/relativeTime";
import { basename } from "../lib/paths";
import { displayTitle, isSessionUnread } from "../lib/session";
import { PilotAvatar } from "./PilotAvatar";

const STATUS_LABEL: Record<Session["status"], string> = {
  working: "Working",
  needsYou: "Needs you",
  idle: "Idle",
  dormant: "Dormant",
};
const STATUS_CLASS: Record<Session["status"], string> = {
  working: "text-working",
  needsYou: "text-needs-you",
  idle: "text-ink-muted",
  dormant: "text-ink-faint",
};

interface SessionRowProps {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  renaming: boolean;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
}

export function SessionRow({
  session,
  active,
  onSelect,
  onContextMenu,
  renaming,
  onRenameCommit,
  onRenameCancel,
}: SessionRowProps) {
  const unread = isSessionUnread(session, active);
  const title = displayTitle(session);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  if (renaming) {
    return <RenameInput ref={inputRef} initialValue={title} onCommit={onRenameCommit} onCancel={onRenameCancel} />;
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={onContextMenu}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-150 ${
        active ? "bg-surface-hover shadow-[inset_2px_0_0_var(--color-accent)]" : "hover:bg-surface-hover"
      }`}
    >
      {/* Pilot = identity (deterministic from id); the ring around it = status. */}
      <PilotAvatar id={session.id} status={session.status} size={40} />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold text-ink" : "text-ink"}`}>
            {title}
          </span>
          <span className={`shrink-0 text-[11px] tabular-nums ${unread ? "text-needs-you" : "text-ink-faint"}`}>
            {relativeTime(session.lastActivity)}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          {session.backend === "codex" && (
            <span
              className="shrink-0 rounded-[3px] border border-codex/35 px-1 py-px text-[9px] font-semibold uppercase leading-none tracking-[0.08em] text-codex"
              title="OpenAI Codex session"
            >
              codex
            </span>
          )}
          <span className="truncate text-ink-faint">{basename(session.cwd)}</span>
          <span className="h-[3px] w-[3px] shrink-0 rounded-full bg-ink-faint/60" aria-hidden="true" />
          <span className={`shrink-0 font-medium ${STATUS_CLASS[session.status]}`}>
            {STATUS_LABEL[session.status]}
          </span>
          {session.tags.length > 0 && (
            <span className="truncate text-ink-faint/70">· {session.tags.join(", ")}</span>
          )}
        </span>
      </span>

      {unread && (
        <span
          className="h-2 w-2 shrink-0 self-center rounded-full bg-needs-you"
          role="status"
          aria-label="Unread"
        />
      )}
    </button>
  );
}

interface RenameInputProps {
  ref: React.Ref<HTMLInputElement>;
  initialValue: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}

// React 19: function components accept `ref` as a plain prop, no
// forwardRef wrapper needed.
function RenameInput({ ref, initialValue, onCommit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(initialValue);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      aria-label="Rename session"
      data-app-editable
      className="h-8 w-full rounded-md border border-accent/50 bg-app-bg px-2 text-sm text-ink focus:outline-none"
    />
  );
}
