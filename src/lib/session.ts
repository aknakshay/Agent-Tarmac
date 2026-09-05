import type { Session } from "../types";

/**
 * A session reads as unread when either the user explicitly flagged it (and
 * that flag persists even while the session is active — ⌘⇧U is "come back to
 * this"), or its transcript picked up activity since it was last on screen.
 * A session with no `lastSeenAt` yet (never focused, or metadata predates
 * this feature) defaults to read rather than lighting up every old session.
 */
export function isSessionUnread(
  session: Pick<Session, "markedUnread" | "lastActivity" | "lastSeenAt">,
  isActive: boolean,
): boolean {
  if (session.markedUnread) return true;
  if (isActive) return false;
  if (!session.lastSeenAt) return false;
  return new Date(session.lastActivity).getTime() > new Date(session.lastSeenAt).getTime();
}

/** The title to render: the user's rename if set, else the transcript title. */
export function displayTitle(session: Pick<Session, "title" | "customTitle">): string {
  return session.customTitle || session.title || "Untitled session";
}
