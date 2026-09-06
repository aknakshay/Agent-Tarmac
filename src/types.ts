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
  /** Owning agent CLI. Optional/undefined is treated as "claude" (the default
   * and the shape of pre-backend sessions), so only Codex gets a badge. */
  backend?: BackendKind;
  /** True only for a Codex session written by the ChatGPT Desktop app. Hidden
   * from the sidebar unless the "show ChatGPT Desktop sessions" toggle is on. */
  codexDesktop?: boolean;
}

/** Which agent CLI owns a session. Mirrors the Rust `BackendKind` enum. */
export type BackendKind = "claude" | "codex";

/** Wire shape of the Rust `SessionMeta` struct (snake_case). */
export interface SessionMeta {
  id: string;
  cwd: string | null;
  title: string;
  last_activity: string;
  last_role: string | null;
  /** Owning backend; optional for back-compat with pre-backend transcripts
   * (defaults to "claude" on the Rust side). */
  backend?: BackendKind;
  /** Whether this Codex session was written by the ChatGPT Desktop app. */
  codex_desktop?: boolean;
}

export interface StatusChange {
  sessionId: string;
  status: Status;
}
