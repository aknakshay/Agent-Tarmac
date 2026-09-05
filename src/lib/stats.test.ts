import { describe, expect, it } from "vitest";
import { computeFleetStats, playCardFraming, type RightNowStats } from "./stats";
import type { Session } from "../types";

function session(overrides: Partial<Session>): Session {
  return {
    id: "s1",
    cwd: "/Users/me/proj-a",
    title: "Untitled",
    lastActivity: "2026-08-10T12:00:00.000Z",
    status: "idle",
    favorite: false,
    badge: false,
    markedUnread: false,
    lastSeenAt: null,
    tags: [],
    customTitle: null,
    ...overrides,
  };
}

const NOW = new Date("2026-08-10T18:00:00.000Z");

describe("computeFleetStats", () => {
  it("counts right-now status buckets and derives live as everything non-dormant", () => {
    const sessions: Record<string, Session> = {
      a: session({ id: "a", status: "working" }),
      b: session({ id: "b", status: "needsYou" }),
      c: session({ id: "c", status: "idle" }),
      d: session({ id: "d", status: "dormant" }),
    };
    const stats = computeFleetStats(sessions, {}, NOW);
    expect(stats.rightNow).toEqual({ working: 1, needsYou: 1, idle: 1, live: 3 });
  });

  it("counts sessions active today by lastActivity date, not other days", () => {
    const sessions: Record<string, Session> = {
      today: session({ id: "today", lastActivity: "2026-08-10T09:00:00.000Z" }),
      yesterday: session({ id: "yesterday", lastActivity: "2026-08-09T09:00:00.000Z" }),
    };
    const stats = computeFleetStats(sessions, {}, NOW);
    expect(stats.activeToday).toBe(1);
  });

  it("finds the most active project among sessions active today, respecting custom names", () => {
    const sessions: Record<string, Session> = {
      a1: session({ id: "a1", cwd: "/proj/a", lastActivity: "2026-08-10T09:00:00.000Z" }),
      a2: session({ id: "a2", cwd: "/proj/a", lastActivity: "2026-08-10T10:00:00.000Z" }),
      b1: session({ id: "b1", cwd: "/proj/b", lastActivity: "2026-08-10T09:00:00.000Z" }),
    };
    const stats = computeFleetStats(sessions, { "/proj/a": "Renamed Project" }, NOW);
    expect(stats.mostActiveProject).toEqual({ label: "Renamed Project", count: 2 });
  });

  it("returns null most-active project when no session was active today", () => {
    const sessions: Record<string, Session> = {
      a: session({ id: "a", lastActivity: "2026-08-01T09:00:00.000Z" }),
    };
    const stats = computeFleetStats(sessions, {}, NOW);
    expect(stats.mostActiveProject).toBeNull();
  });

  it("computes fleet totals across all sessions and distinct projects", () => {
    const sessions: Record<string, Session> = {
      a: session({ id: "a", cwd: "/proj/a" }),
      b: session({ id: "b", cwd: "/proj/a" }),
      c: session({ id: "c", cwd: "/proj/b" }),
      d: session({ id: "d", cwd: null }),
    };
    const stats = computeFleetStats(sessions, {}, NOW);
    expect(stats.totals).toEqual({ sessions: 4, projects: 2 });
  });

  it("returns zeroed stats for an empty fleet", () => {
    const stats = computeFleetStats({}, {}, NOW);
    expect(stats.rightNow).toEqual({ working: 0, needsYou: 0, idle: 0, live: 0 });
    expect(stats.activeToday).toBe(0);
    expect(stats.mostActiveProject).toBeNull();
    expect(stats.totals).toEqual({ sessions: 0, projects: 0 });
  });
});

function rightNow(overrides: Partial<RightNowStats>): RightNowStats {
  return { working: 0, needsYou: 0, idle: 0, live: 0, ...overrides };
}

describe("playCardFraming", () => {
  it("stays quiet (null) when any session needs the user", () => {
    expect(playCardFraming(rightNow({ needsYou: 1, working: 2, live: 3 }))).toBeNull();
  });

  it("emphasizes when every live session is working", () => {
    const framing = playCardFraming(rightNow({ working: 3, live: 3 }));
    expect(framing).toEqual({ subtitle: "3 agents working — you've got a minute.", emphasize: true });
  });

  it("uses singular phrasing for exactly one working session", () => {
    const framing = playCardFraming(rightNow({ working: 1, live: 1 }));
    expect(framing?.subtitle).toBe("1 agent working — you've got a minute.");
  });

  it("falls back to a quiet invite when nothing is working and nothing needs you", () => {
    expect(playCardFraming(rightNow({ idle: 2, live: 2 }))).toEqual({
      subtitle: "All agents heads-down? Take a flight.",
      emphasize: false,
    });
  });

  it("falls back to the quiet invite when some but not all live sessions are working", () => {
    const framing = playCardFraming(rightNow({ working: 1, idle: 1, live: 2 }));
    expect(framing).toEqual({ subtitle: "All agents heads-down? Take a flight.", emphasize: false });
  });
});
