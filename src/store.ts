import { create } from "zustand";
import type { Session, SessionMeta, Status } from "./types";
import { basename } from "./lib/paths";
import { updateWorkspace, type WireSessionMetaEntry, type Workspace } from "./lib/workspaceMeta";

const PERSIST_DEBOUNCE_MS = 1000;
const pendingMetaPersists = new Map<string, ReturnType<typeof setTimeout>>();

function toWireEntry(session: Session): WireSessionMetaEntry {
  return {
    last_seen_at: session.lastSeenAt,
    marked_unread: session.markedUnread,
    tags: session.tags,
    custom_title: session.customTitle,
  };
}

/**
 * Debounces persistence of one session's metadata entry so rapid changes
 * (e.g. `lastSeenAt` re-stamped on every session-index rescan while a
 * session is active) don't hit the backend on every tick. Reads the
 * session fresh via `get()` when the timer fires, not a value captured at
 * schedule time, so the persisted entry reflects whatever's latest.
 */
function scheduleMetaPersist(id: string, get: () => DeckState) {
  const existing = pendingMetaPersists.get(id);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    pendingMetaPersists.delete(id);
    const session = get().sessions[id];
    if (!session) return;
    updateWorkspace((ws) => ({
      ...ws,
      session_meta: { ...ws.session_meta, [id]: toWireEntry(session) },
    })).catch((err) => console.error(`Failed to persist session metadata for ${id}`, err));
  }, PERSIST_DEBOUNCE_MS);
  pendingMetaPersists.set(id, timeout);
}

function persistFavorites(session: Session, id: string) {
  updateWorkspace((ws) => {
    const favorites = session.favorite
      ? ws.favorites.includes(id)
        ? ws.favorites
        : [...ws.favorites, id]
      : ws.favorites.filter((f) => f !== id);
    return { ...ws, favorites };
  }).catch((err) => console.error(`Failed to persist favorite for ${id}`, err));
}

interface DeckState {
  sessions: Record<string, Session>;
  openIds: string[]; // sessions with a terminal pane created
  activeId: string | null;
  /** True once the first `list_sessions`/`sessions_updated` result has landed. */
  sessionsLoaded: boolean;
  /**
   * Cached copy of the last-hydrated `session_meta`/`favorites`, used by
   * `setSessions` to seed a session's metadata the first time it appears
   * (e.g. a session that existed in `workspace.json` before the session
   * index had scanned it yet). Not meant to be read directly by components.
   */
  metaCache: Record<string, WireSessionMetaEntry>;
  favoriteIdsCache: string[];
  /**
   * Merges a fresh session list from the backend, preserving status/badge/
   * favorite for known ids. A session missing from `metas` is dropped unless
   * it's still "live" in this app — open in a pane, or a `start_new_session`
   * placeholder (`new-*`) whose transcript the watcher hasn't surfaced yet —
   * since an unrelated rescan (any transcript write under the projects dir)
   * would otherwise wipe it out from under an open pane.
   */
  setSessions(metas: SessionMeta[]): void;
  /** Sets a session's status. Sets badge=true if the session becomes needsYou while unfocused. */
  setStatus(id: string, status: Status): void;
  /**
   * Focuses a session: clears its badge and ensures its pane is open. If `id`
   * isn't in the index yet (e.g. the placeholder id `start_new_session`
   * returns before the watcher picks up the real transcript), synthesizes a
   * stub session from `cwd` so the pane has a header to render immediately.
   * Clears `markedUnread` and stamps `lastSeenAt` on the newly-focused
   * session, and stamps `lastSeenAt` on the session being switched away from.
   */
  focus(id: string, cwd?: string | null): void;
  /** Merges persisted `session_meta`/`favorites` from `workspace.json` into known sessions. */
  hydrateMeta(ws: Workspace): void;
  /** Sets the explicit unread flag. Persists (debounced). */
  setMarkedUnread(id: string, unread: boolean): void;
  /** Toggles the explicit unread flag on `id` (used by the ⌘⇧U shortcut on the active session). */
  toggleMarkedUnread(id: string): void;
  /** Sets/clears a rename override. Empty string clears it back to the transcript title. */
  setCustomTitle(id: string, title: string): void;
  /** Toggles favorite and persists to `Workspace.favorites`. */
  toggleFavorite(id: string): void;
  addTag(id: string, tag: string): void;
  removeTag(id: string, tag: string): void;
}

export const useDeck = create<DeckState>()((set, get) => ({
  sessions: {},
  openIds: [],
  activeId: null,
  sessionsLoaded: false,
  metaCache: {},
  favoriteIdsCache: [],

  setSessions: (metas) => {
    const existing = get().sessions;
    const openIds = get().openIds;
    const activeId = get().activeId;
    const metaCache = get().metaCache;
    const favoriteIdsCache = get().favoriteIdsCache;
    const next: Record<string, Session> = {};
    // meta.last_role is intentionally unused here: status ("working" /
    // "needsYou" / etc.) flows exclusively through session_status_changed
    // events (see setStatus), not derived from the transcript's last role.
    for (const meta of metas) {
      const prev = existing[meta.id];
      const cached = prev ? undefined : metaCache[meta.id];
      const lastSeenAt =
        meta.id === activeId
          ? meta.last_activity // keep fresh while this session is the one on screen
          : (prev?.lastSeenAt ?? cached?.last_seen_at ?? null);
      next[meta.id] = {
        id: meta.id,
        cwd: meta.cwd,
        title: meta.title,
        lastActivity: meta.last_activity,
        status: prev?.status ?? "dormant",
        favorite: prev?.favorite ?? favoriteIdsCache.includes(meta.id),
        badge: prev?.badge ?? false,
        markedUnread: prev?.markedUnread ?? cached?.marked_unread ?? false,
        lastSeenAt,
        tags: prev?.tags ?? cached?.tags ?? [],
        customTitle: prev?.customTitle ?? cached?.custom_title ?? null,
      };
    }
    for (const [id, session] of Object.entries(existing)) {
      if (id in next) continue;
      if (openIds.includes(id) || id.startsWith("new-")) next[id] = session;
    }
    set({ sessions: next, sessionsLoaded: true });
    if (activeId && next[activeId] && next[activeId].lastSeenAt !== existing[activeId]?.lastSeenAt) {
      scheduleMetaPersist(activeId, get);
    }
  },

  setStatus: (id, status) => {
    set((state) => {
      const session = state.sessions[id];
      if (!session) return state;
      const badge = status === "needsYou" && id !== state.activeId ? true : session.badge;
      return { sessions: { ...state.sessions, [id]: { ...session, status, badge } } };
    });
  },

  focus: (id, cwd = null) => {
    const prevActiveId = get().activeId;
    set((state) => {
      const now = new Date().toISOString();
      let sessions = state.sessions;

      // Stamp lastSeenAt for the session we're leaving, so activity that
      // happens after this point (but before it's re-focused) counts as
      // unread rather than being silently backdated to "seen".
      if (prevActiveId && prevActiveId !== id && sessions[prevActiveId]) {
        sessions = {
          ...sessions,
          [prevActiveId]: { ...sessions[prevActiveId], lastSeenAt: now },
        };
      }

      const existing = sessions[id];
      const session: Session = existing
        ? { ...existing, badge: false, markedUnread: false, lastSeenAt: now }
        : {
            id,
            cwd,
            title: basename(cwd),
            lastActivity: now,
            status: "working",
            favorite: false,
            badge: false,
            markedUnread: false,
            lastSeenAt: now,
            tags: [],
            customTitle: null,
          };

      return {
        activeId: id,
        openIds: state.openIds.includes(id) ? state.openIds : [...state.openIds, id],
        sessions: { ...sessions, [id]: session },
      };
    });

    if (prevActiveId && prevActiveId !== id) scheduleMetaPersist(prevActiveId, get);
    scheduleMetaPersist(id, get);
  },

  hydrateMeta: (ws) => {
    set((state) => {
      const sessions = { ...state.sessions };
      for (const [id, entry] of Object.entries(ws.session_meta)) {
        const session = sessions[id];
        if (!session) continue;
        sessions[id] = {
          ...session,
          // Don't clobber a lastSeenAt this session already picked up locally
          // (e.g. it's the active session and was just stamped) with an
          // older persisted value.
          lastSeenAt: session.lastSeenAt ?? entry.last_seen_at,
          markedUnread: entry.marked_unread,
          tags: entry.tags,
          customTitle: entry.custom_title,
        };
      }
      for (const id of ws.favorites) {
        if (sessions[id]) sessions[id] = { ...sessions[id], favorite: true };
      }
      return { sessions, metaCache: ws.session_meta, favoriteIdsCache: ws.favorites };
    });
  },

  setMarkedUnread: (id, unread) => {
    set((state) => {
      const session = state.sessions[id];
      if (!session || session.markedUnread === unread) return state;
      return { sessions: { ...state.sessions, [id]: { ...session, markedUnread: unread } } };
    });
    scheduleMetaPersist(id, get);
  },

  toggleMarkedUnread: (id) => {
    const session = get().sessions[id];
    if (!session) return;
    get().setMarkedUnread(id, !session.markedUnread);
  },

  setCustomTitle: (id, title) => {
    const trimmed = title.trim();
    set((state) => {
      const session = state.sessions[id];
      if (!session) return state;
      return {
        sessions: { ...state.sessions, [id]: { ...session, customTitle: trimmed === "" ? null : trimmed } },
      };
    });
    scheduleMetaPersist(id, get);
  },

  toggleFavorite: (id) => {
    set((state) => {
      const session = state.sessions[id];
      if (!session) return state;
      return { sessions: { ...state.sessions, [id]: { ...session, favorite: !session.favorite } } };
    });
    const session = get().sessions[id];
    if (session) persistFavorites(session, id);
  },

  addTag: (id, tag) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    set((state) => {
      const session = state.sessions[id];
      if (!session || session.tags.includes(trimmed)) return state;
      return { sessions: { ...state.sessions, [id]: { ...session, tags: [...session.tags, trimmed] } } };
    });
    scheduleMetaPersist(id, get);
  },

  removeTag: (id, tag) => {
    set((state) => {
      const session = state.sessions[id];
      if (!session) return state;
      return { sessions: { ...state.sessions, [id]: { ...session, tags: session.tags.filter((t) => t !== tag) } } };
    });
    scheduleMetaPersist(id, get);
  },
}));
