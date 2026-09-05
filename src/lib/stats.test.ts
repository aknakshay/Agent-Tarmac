import { describe, expect, it } from "vitest";
import { computeFleetStats } from "./stats";
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

  it("builds a 7-day sparkline, oldest day first, ending on today", () => {
    const sessions: Record<string, Session> = {
      a: session({ id: "a", lastActivity: "2026-08-10T09:00:00.000Z" }),
      b: session({ id: "b", lastActivity: "2026-08-08T09:00:00.000Z" }),
    };
    const stats = computeFleetStats(sessions, {}, NOW);
    expect(stats.sparkline).toHaveLength(7);
    expect(stats.sparkline[6].date).toBe("2026-08-10");
    expect(stats.sparkline[6].count).toBe(1);
    expect(stats.sparkline[0].date).toBe("2026-08-04");
    expect(stats.sparkline.find((d) => d.date === "2026-08-08")?.count).toBe(1);
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
    expect(stats.sparkline).toHaveLength(7);
    expect(stats.sparkline.every((d) => d.count === 0)).toBe(true);
  });
});
