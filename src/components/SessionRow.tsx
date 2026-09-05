import type { Session } from "../types";
import { relativeTime } from "../lib/relativeTime";
import { basename } from "../lib/paths";

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
}

export function SessionRow({ session, active, onSelect }: SessionRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
        active ? "bg-surface-hover" : "hover:bg-surface-hover"
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[session.status]}`}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm text-ink">{session.title || "Untitled session"}</span>
          {session.badge && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-needs-you"
              role="status"
              aria-label="Needs you"
            />
          )}
        </span>
        <span className="truncate text-xs text-ink-faint">{basename(session.cwd)}</span>
      </span>
      <span className="shrink-0 text-xs text-ink-faint">{relativeTime(session.lastActivity)}</span>
    </button>
  );
}
