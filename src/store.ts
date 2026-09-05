import { create } from "zustand";
import type { Session, SessionMeta, Status } from "./types";
import { basename } from "./lib/paths";

interface DeckState {
  sessions: Record<string, Session>;
  openIds: string[]; // sessions with a terminal pane created
  activeId: string | null;
  /** Merges a fresh session list from the backend, preserving status/badge/favorite for known ids. */
  setSessions(metas: SessionMeta[]): void;
  /** Sets a session's status. Sets badge=true if the session becomes needsYou while unfocused. */
  setStatus(id: string, status: Status): void;
  /**
   * Focuses a session: clears its badge and ensures its pane is open. If `id`
   * isn't in the index yet (e.g. the placeholder id `start_new_session`
   * returns before the watcher picks up the real transcript), synthesizes a
   * stub session from `cwd` so the pane has a header to render immediately.
   */
  focus(id: string, cwd?: string | null): void;
  closePane(id: string): void;
}

export const useDeck = create<DeckState>()((set, get) => ({
  sessions: {},
  openIds: [],
  activeId: null,

  setSessions: (metas) => {
    const existing = get().sessions;
    const next: Record<string, Session> = {};
    for (const meta of metas) {
      const prev = existing[meta.id];
      next[meta.id] = {
        id: meta.id,
        cwd: meta.cwd,
        title: meta.title,
        lastActivity: meta.last_activity,
        status: prev?.status ?? "dormant",
        favorite: prev?.favorite ?? false,
        badge: prev?.badge ?? false,
      };
    }
    set({ sessions: next });
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
    set((state) => {
      const existing = state.sessions[id];
      const session: Session = existing
        ? { ...existing, badge: false }
        : {
            id,
            cwd,
            title: basename(cwd),
            lastActivity: new Date().toISOString(),
            status: "working",
            favorite: false,
            badge: false,
          };
      return {
        activeId: id,
        openIds: state.openIds.includes(id) ? state.openIds : [...state.openIds, id],
        sessions: { ...state.sessions, [id]: session },
      };
    });
  },

  closePane: (id) => {
    set((state) => ({
      openIds: state.openIds.filter((openId) => openId !== id),
      activeId: state.activeId === id ? null : state.activeId,
    }));
  },
}));
