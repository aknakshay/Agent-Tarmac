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
  favorites: string[];
  session_meta: Record<string, WireSessionMetaEntry>;
}

/**
 * Serializes every `updateWorkspace` call through one in-flight chain. The
 * Rust-side `Mutex` only guards a single `get_workspace`/`set_workspace`
 * command each — it does NOT span a get-then-set pair — so two RMWs for
 * different session ids (e.g. `focus()` persisting the session being left
 * and the one being entered) can interleave: both read the same starting
 * workspace, and whichever `set_workspace` lands second silently discards
 * the first one's write. Queuing here means the next call's `get_workspace`
 * only starts after the previous call's `set_workspace` has resolved, so
 * every write is against a workspace that includes all prior writes.
 *
 * A failed call still advances the queue (caught below) so one rejected
 * write doesn't wedge every future one.
 */
let queue: Promise<void> = Promise.resolve();

/**
 * Read-modify-write against the latest `Workspace` (same pattern
 * RestoreBanner uses for `live_session_ids`): fetches the current workspace,
 * applies `mutate`, and persists the result. Queued (see `queue` above) so
 * concurrent callers never clobber each other.
 *
 * `session_meta` defaults to `{}` for a workspace fetched before this field
 * existed on disk (older `workspace.json`), so callers don't need to guard
 * against `undefined`.
 *
 * If `mutate` returns the exact object it was given (by reference), that's
 * read as "nothing to change" and `set_workspace` is skipped — lets callers
 * that only sometimes have something to persist (e.g. clearing an already-
 * empty list) avoid a pointless write without needing their own pre-check.
 */
export function updateWorkspace(mutate: (ws: Workspace) => Workspace): Promise<Workspace> {
  const result = queue.then(async () => {
    const ws = await invoke<Workspace>("get_workspace");
    const hydrated: Workspace = { ...ws, session_meta: ws.session_meta ?? {} };
    const next = mutate(hydrated);
    if (next !== hydrated) {
      await invoke("set_workspace", { ws: next });
    }
    return next;
  });
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
