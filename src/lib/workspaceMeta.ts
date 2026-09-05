import { invoke } from "@tauri-apps/api/core";

/** Wire shape of the Rust `SessionMetaEntry` struct (snake_case). */
export interface WireSessionMetaEntry {
  last_seen_at: string | null;
  marked_unread: boolean;
  tags: string[];
  custom_title: string | null;
}

/** Wire shape of the Rust `Workspace` struct (snake_case). */
export interface Workspace {
  live_session_ids: string[];
  open_session_ids: string[];
  favorites: string[];
  session_meta: Record<string, WireSessionMetaEntry>;
}

export const EMPTY_META_ENTRY: WireSessionMetaEntry = {
  last_seen_at: null,
  marked_unread: false,
  tags: [],
  custom_title: null,
};

/**
 * Read-modify-write against the latest `Workspace` (same pattern
 * RestoreBanner uses for `live_session_ids`): fetches the current workspace,
 * applies `mutate`, and persists the result. This means a concurrent write
 * from another feature (favorites toggled elsewhere, the restore banner
 * clearing live ids, ...) isn't clobbered by a stale snapshot.
 *
 * `session_meta` defaults to `{}` for a workspace fetched before this field
 * existed on disk (older `workspace.json`), so callers don't need to guard
 * against `undefined`.
 */
export async function updateWorkspace(mutate: (ws: Workspace) => Workspace): Promise<Workspace> {
  const ws = await invoke<Workspace>("get_workspace");
  const next = mutate({ ...ws, session_meta: ws.session_meta ?? {} });
  await invoke("set_workspace", { ws: next });
  return next;
}
