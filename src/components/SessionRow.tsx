import { useEffect, useRef, useState } from "react";
import type { Session } from "../types";
import { relativeTime } from "../lib/relativeTime";
import { basename } from "../lib/paths";
import { displayTitle, isSessionUnread } from "../lib/session";

const STATUS_DOT_CLASS: Record<Session["status"], string> = {
  working: "bg-working animate-pulse",
  needsYou: "bg-needs-you",
  idle: "bg-ink-faint",
  dormant: "border border-ink-faint bg-transparent",
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
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
        active ? "bg-surface-hover" : "hover:bg-surface-hover"
      }`}
    >
      <span className="relative shrink-0">
        <span className={`block h-2 w-2 rounded-full ${STATUS_DOT_CLASS[session.status]}`} aria-hidden="true" />
        {unread && (
          <span
            className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-surface"
            role="status"
            aria-label="Unread"
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className={`truncate text-sm ${unread ? "font-semibold text-ink" : "text-ink"}`}>{title}</span>
          {session.badge && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-needs-you"
              role="status"
              aria-label="Needs you"
            />
          )}
        </span>
        <span className="flex items-center gap-1 truncate text-xs text-ink-faint">
          {basename(session.cwd)}
          {session.tags.length > 0 && (
            <span className="truncate text-ink-faint/70">· {session.tags.join(", ")}</span>
          )}
        </span>
      </span>
      <span className="shrink-0 text-xs text-ink-faint">{relativeTime(session.lastActivity)}</span>
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
      className="h-8 w-full rounded-md border border-accent/50 bg-app-bg px-2 text-sm text-ink focus:outline-none"
    />
  );
}
