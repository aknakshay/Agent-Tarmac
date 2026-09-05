export type Status = "working" | "needsYou" | "idle" | "dormant";

export interface Session {
  id: string;
  cwd: string | null;
  title: string;
  lastActivity: string; // ISO
  status: Status;
  favorite: boolean;
  badge: boolean; // finished/needsYou while unfocused
  markedUnread: boolean; // explicit "mark as unread" flag, survives focus
  lastSeenAt: string | null; // ISO; when this session was last on screen
  tags: string[];
  customTitle: string | null; // user rename; null = use transcript title
}

/** Wire shape of the Rust `SessionMeta` struct (snake_case). */
export interface SessionMeta {
  id: string;
  cwd: string | null;
  title: string;
  last_activity: string;
  last_role: string | null;
}

export interface StatusChange {
  sessionId: string;
  status: Status;
}
