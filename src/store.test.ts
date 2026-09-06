import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDeck } from "./store";
import { isSessionUnread, displayTitle } from "./lib/session";
import { displayProjectName } from "./lib/projectMeta";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "get_workspace") {
      return Promise.resolve({ live_session_ids: [], favorites: [], session_meta: {}, project_meta: {} });
    }
    return Promise.resolve(undefined);
  }),
}));

const baseSession = {
  cwd: "/p",
  title: "t",
  lastActivity: "2026-09-05T10:00:00Z",
  status: "idle" as const,
  favorite: false,
  badge: false,
  markedUnread: false,
  lastSeenAt: null as string | null,
  tags: [] as string[],
  customTitle: null as string | null,
};

beforeEach(() =>
  useDeck.setState({
    sessions: {},
    openIds: [],
    activeId: null,
    metaCache: {},
    favoriteIdsCache: [],
    projectNames: {},
    showCodexDesktop: false,
  }),
);

describe("useDeck", () => {
  it("setStatus on unfocused session sets badge", () => {
    useDeck.getState().setSessions([{ id: "a", cwd: "/p", title: "t", last_activity: "2026-09-05T10:00:00Z", last_role: "assistant" }]);
    useDeck.getState().setStatus("a", "needsYou");
    expect(useDeck.getState().sessions["a"].badge).toBe(true);
  });

  it("threads backend through, defaulting a metaless session to claude", () => {
    useDeck.getState().setSessions([
      { id: "cx", cwd: "/p", title: "t", last_activity: "2026-09-05T10:00:00Z", last_role: "assistant", backend: "codex" },
      { id: "cl", cwd: "/p", title: "t", last_activity: "2026-09-05T10:00:00Z", last_role: "assistant" },
    ]);
    expect(useDeck.getState().sessions["cx"].backend).toBe("codex");
    // No backend on the wire (pre-backend transcript) reads as claude.
    expect(useDeck.getState().sessions["cl"].backend).toBe("claude");
  });

  it("threads codexDesktop from meta and hydrates/toggles the show setting", () => {
    useDeck.getState().setSessions([
      { id: "d", cwd: "/p", title: "t", last_activity: "2026-09-05T10:00:00Z", last_role: "user", backend: "codex", codex_desktop: true },
      { id: "c", cwd: "/p", title: "t", last_activity: "2026-09-05T10:00:00Z", last_role: "user", backend: "codex" },
    ]);
    expect(useDeck.getState().sessions["d"].codexDesktop).toBe(true);
    // Absent codex_desktop reads as false.
    expect(useDeck.getState().sessions["c"].codexDesktop).toBe(false);

    // Default off; hydrateMeta picks up the persisted flag.
    expect(useDeck.getState().showCodexDesktop).toBe(false);
    useDeck.getState().hydrateMeta({
      live_session_ids: [],
      favorites: [],
      session_meta: {},
      project_meta: {},
      show_codex_desktop: true,
    });
    expect(useDeck.getState().showCodexDesktop).toBe(true);

    // Explicit toggle wins.
    useDeck.getState().setShowCodexDesktop(false);
    expect(useDeck.getState().showCodexDesktop).toBe(false);
  });

  it("focus clears badge and opens pane", () => {
    useDeck.getState().setSessions([{ id: "a", cwd: "/p", title: "t", last_activity: "2026-09-05T10:00:00Z", last_role: null }]);
    useDeck.getState().setStatus("a", "needsYou");
    useDeck.getState().focus("a");
    const s = useDeck.getState();
    expect(s.sessions["a"].badge).toBe(false);
    expect(s.activeId).toBe("a");
    expect(s.openIds).toContain("a");
  });

  it("focus on an unknown id synthesizes a stub session so the pane can render", () => {
    useDeck.getState().focus("new-123", "/Users/me/proj-a");
    const s = useDeck.getState();
    expect(s.sessions["new-123"]).toMatchObject({
      id: "new-123",
      cwd: "/Users/me/proj-a",
      title: "proj-a",
      status: "working",
      favorite: false,
      badge: false,
    });
    expect(s.activeId).toBe("new-123");
    expect(s.openIds).toContain("new-123");
  });

  it("focus on an unknown id without a cwd still synthesizes a stub", () => {
    useDeck.getState().focus("new-456");
    const s = useDeck.getState();
    expect(s.sessions["new-456"]).toMatchObject({
      id: "new-456",
      cwd: null,
      status: "working",
    });
    expect(s.activeId).toBe("new-456");
  });

  it("setSessions preserves a placeholder stub through an unrelated rescan", () => {
    useDeck.getState().focus("new-x", "/tmp/foo");
    // Simulate a rescan triggered by unrelated transcript activity: the
    // placeholder isn't in the backend's list yet (its transcript hasn't
    // been written), and no other sessions exist either.
    useDeck.getState().setSessions([]);
    const s = useDeck.getState();
    expect(s.sessions["new-x"]).toMatchObject({
      id: "new-x",
      cwd: "/tmp/foo",
      title: "foo",
      status: "working",
    });
  });

  it("setSessions drops a stale session that is neither open nor a placeholder", () => {
    useDeck.setState({
      sessions: { orphan: { id: "orphan", ...baseSession } },
      openIds: [],
      activeId: null,
    });
    useDeck.getState().setSessions([]);
    expect(useDeck.getState().sessions["orphan"]).toBeUndefined();
  });

  describe("goHome", () => {
    it("clears activeId without closing the open pane", () => {
      useDeck.setState({
        sessions: { a: { id: "a", ...baseSession } },
        activeId: "a",
        openIds: ["a"],
      });
      useDeck.getState().goHome();
      const s = useDeck.getState();
      expect(s.activeId).toBeNull();
      expect(s.openIds).toContain("a");
    });

    it("stamps lastSeenAt on the session being left", () => {
      useDeck.setState({
        sessions: { a: { id: "a", ...baseSession } },
        activeId: "a",
        openIds: ["a"],
      });
      useDeck.getState().goHome();
      expect(useDeck.getState().sessions["a"].lastSeenAt).not.toBeNull();
    });

    it("is a no-op when already home", () => {
      useDeck.setState({ sessions: {}, activeId: null, openIds: [] });
      useDeck.getState().goHome();
      expect(useDeck.getState().activeId).toBeNull();
    });
  });

  describe("read/unread", () => {
    it("focus stamps lastSeenAt and clears markedUnread", () => {
      useDeck.setState({
        sessions: { a: { id: "a", ...baseSession, markedUnread: true } },
      });
      useDeck.getState().focus("a");
      const s = useDeck.getState().sessions["a"];
      expect(s.markedUnread).toBe(false);
      expect(s.lastSeenAt).not.toBeNull();
    });

    it("focus stamps lastSeenAt on the session being switched away from", () => {
      useDeck.setState({
        sessions: {
          a: { id: "a", ...baseSession },
          b: { id: "b", ...baseSession },
        },
        activeId: "a",
        openIds: ["a"],
      });
      useDeck.getState().focus("b");
      expect(useDeck.getState().sessions["a"].lastSeenAt).not.toBeNull();
    });

    it("toggleMarkedUnread flips the flag on the given session", () => {
      useDeck.setState({ sessions: { a: { id: "a", ...baseSession } } });
      useDeck.getState().toggleMarkedUnread("a");
      expect(useDeck.getState().sessions["a"].markedUnread).toBe(true);
      useDeck.getState().toggleMarkedUnread("a");
      expect(useDeck.getState().sessions["a"].markedUnread).toBe(false);
    });

    it("setMarkedUnread survives being focused again — manual flag isn't auto-cleared by activity, only by focus", () => {
      useDeck.setState({ sessions: { a: { id: "a", ...baseSession } } });
      useDeck.getState().toggleMarkedUnread("a"); // mark unread while inactive
      expect(isSessionUnread(useDeck.getState().sessions["a"], false)).toBe(true);
    });

    it("hydrateMeta merges persisted tags/customTitle/markedUnread/favorites into known sessions", () => {
      useDeck.setState({ sessions: { a: { id: "a", ...baseSession } } });
      useDeck.getState().hydrateMeta({
        live_session_ids: [],
        favorites: ["a"],
        session_meta: {
          a: { last_seen_at: "2026-09-05T09:00:00Z", marked_unread: true, tags: ["urgent"], custom_title: "Renamed" },
        },
        project_meta: {},
      });
      const s = useDeck.getState().sessions["a"];
      expect(s.favorite).toBe(true);
      expect(s.markedUnread).toBe(true);
      expect(s.tags).toEqual(["urgent"]);
      expect(s.customTitle).toBe("Renamed");
      expect(s.lastSeenAt).toBe("2026-09-05T09:00:00Z");
    });
  });

  describe("rename", () => {
    it("setCustomTitle sets an override", () => {
      useDeck.setState({ sessions: { a: { id: "a", ...baseSession } } });
      useDeck.getState().setCustomTitle("a", "  My title  ");
      expect(useDeck.getState().sessions["a"].customTitle).toBe("My title");
    });

    it("setCustomTitle with an empty string clears the override", () => {
      useDeck.setState({ sessions: { a: { id: "a", ...baseSession, customTitle: "Old" } } });
      useDeck.getState().setCustomTitle("a", "   ");
      expect(useDeck.getState().sessions["a"].customTitle).toBeNull();
    });
  });

  describe("favorite", () => {
    it("toggleFavorite flips the flag", () => {
      useDeck.setState({ sessions: { a: { id: "a", ...baseSession } } });
      useDeck.getState().toggleFavorite("a");
      expect(useDeck.getState().sessions["a"].favorite).toBe(true);
      useDeck.getState().toggleFavorite("a");
      expect(useDeck.getState().sessions["a"].favorite).toBe(false);
    });
  });

  describe("tags", () => {
    it("addTag appends a trimmed tag, without duplicates", () => {
      useDeck.setState({ sessions: { a: { id: "a", ...baseSession } } });
      useDeck.getState().addTag("a", "  work  ");
      useDeck.getState().addTag("a", "work");
      expect(useDeck.getState().sessions["a"].tags).toEqual(["work"]);
    });

    it("removeTag drops a tag", () => {
      useDeck.setState({ sessions: { a: { id: "a", ...baseSession, tags: ["work", "urgent"] } } });
      useDeck.getState().removeTag("a", "work");
      expect(useDeck.getState().sessions["a"].tags).toEqual(["urgent"]);
    });
  });

  describe("project rename", () => {
    it("setProjectName stores a trimmed custom name", () => {
      useDeck.getState().setProjectName("/Users/me/proj", "  My Project  ");
      expect(useDeck.getState().projectNames["/Users/me/proj"]).toBe("My Project");
    });

    it("setProjectName with an empty string clears the name", () => {
      useDeck.setState({ projectNames: { "/p": "Custom" } });
      useDeck.getState().setProjectName("/p", "   ");
      expect(useDeck.getState().projectNames["/p"]).toBeNull();
    });

    it("hydrateMeta seeds projectNames from project_meta", () => {
      useDeck.getState().hydrateMeta({
        live_session_ids: [],
        favorites: [],
        session_meta: {},
        project_meta: {
          "/Users/me/proj": { custom_name: "My Project" },
        },
      });
      expect(useDeck.getState().projectNames["/Users/me/proj"]).toBe("My Project");
    });

    it("hydrateMeta with missing project_meta (old workspace.json) doesn't crash", () => {
      // Simulate a hydration call where project_meta is absent (undefined from
      // an older workspace.json). The store must default gracefully.
      const ws = {
        live_session_ids: [],
        favorites: [],
        session_meta: {},
        project_meta: undefined as unknown as Record<string, { custom_name: string | null }>,
      };
      expect(() => useDeck.getState().hydrateMeta(ws)).not.toThrow();
    });
  });
});

describe("isSessionUnread", () => {
  it("is read when there's no lastSeenAt and no manual flag (old sessions default read)", () => {
    expect(isSessionUnread({ markedUnread: false, lastActivity: "2026-09-05T10:00:00Z", lastSeenAt: null }, false)).toBe(
      false,
    );
  });

  it("is unread when activity is newer than lastSeenAt", () => {
    expect(
      isSessionUnread(
        { markedUnread: false, lastActivity: "2026-09-05T10:00:00Z", lastSeenAt: "2026-09-05T09:00:00Z" },
        false,
      ),
    ).toBe(true);
  });

  it("is read when activity is not newer than lastSeenAt", () => {
    expect(
      isSessionUnread(
        { markedUnread: false, lastActivity: "2026-09-05T09:00:00Z", lastSeenAt: "2026-09-05T09:00:00Z" },
        false,
      ),
    ).toBe(false);
  });

  it("is read while active, even with newer activity than lastSeenAt", () => {
    expect(
      isSessionUnread(
        { markedUnread: false, lastActivity: "2026-09-05T10:00:00Z", lastSeenAt: "2026-09-05T09:00:00Z" },
        true,
      ),
    ).toBe(false);
  });

  it("the manual flag wins even while active", () => {
    expect(isSessionUnread({ markedUnread: true, lastActivity: "2026-09-05T10:00:00Z", lastSeenAt: null }, true)).toBe(
      true,
    );
  });
});

describe("displayTitle", () => {
  it("prefers customTitle over the transcript title", () => {
    expect(displayTitle({ title: "transcript", customTitle: "renamed" })).toBe("renamed");
  });

  it("falls back to the transcript title when there's no override", () => {
    expect(displayTitle({ title: "transcript", customTitle: null })).toBe("transcript");
  });

  it("falls back to Untitled session when both are empty", () => {
    expect(displayTitle({ title: "", customTitle: null })).toBe("Untitled session");
  });
});

describe("displayProjectName", () => {
  it("returns the custom name when set", () => {
    expect(displayProjectName("/Users/me/proj", "My Project")).toBe("My Project");
  });

  it("falls back to basename when custom name is null", () => {
    expect(displayProjectName("/Users/me/proj", null)).toBe("proj");
  });

  it("falls back to basename when custom name is empty string", () => {
    expect(displayProjectName("/Users/me/proj", "")).toBe("proj");
  });

  it("falls back to basename when custom name is whitespace-only", () => {
    expect(displayProjectName("/Users/me/proj", "   ")).toBe("proj");
  });

  it("handles null cwd (no-project group) — falls back to basename's 'no project'", () => {
    expect(displayProjectName(null, null)).toBe("no project");
  });
});
