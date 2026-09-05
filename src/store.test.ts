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
});
