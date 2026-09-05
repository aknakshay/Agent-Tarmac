import { describe, it, expect, beforeEach } from "vitest";
import { useDeck } from "./store";

beforeEach(() => useDeck.setState({ sessions: {}, openIds: [], activeId: null }));

describe("useDeck", () => {
  it("setStatus on unfocused session sets badge", () => {
    useDeck.getState().setSessions([{ id: "a", cwd: "/p", title: "t", last_activity: "2026-09-05T10:00:00Z", last_role: "assistant" }]);
    useDeck.getState().setStatus("a", "needsYou");
    expect(useDeck.getState().sessions["a"].badge).toBe(true);
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
      sessions: {
        orphan: {
          id: "orphan",
          cwd: "/p",
          title: "t",
          lastActivity: "2026-09-05T10:00:00Z",
          status: "idle",
          favorite: false,
          badge: false,
        },
      },
      openIds: [],
      activeId: null,
    });
    useDeck.getState().setSessions([]);
    expect(useDeck.getState().sessions["orphan"]).toBeUndefined();
  });
});
