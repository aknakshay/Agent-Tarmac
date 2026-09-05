import type { Session } from "../types";
import { displayProjectName } from "./projectMeta";

export interface RightNowStats {
  working: number;
  needsYou: number;
  idle: number;
  /** Any non-dormant session — a PTY is actually running. */
  live: number;
}

export interface SparklineDay {
  /** UTC date, YYYY-MM-DD. */
  date: string;
  count: number;
}

export interface MostActiveProject {
  label: string;
  count: number;
}

export interface FleetStats {
  rightNow: RightNowStats;
  /** Sessions with activity today. NOT "sessions started today" — SessionMeta
   * only carries `last_activity`, no creation timestamp, so this is the
   * closest honest signal available. */
  activeToday: number;
  mostActiveProject: MostActiveProject | null;
  /** Last 7 days, oldest first, today last. Labelled "active sessions by
   * day" in the UI for the same reason as `activeToday` — this counts
   * sessions whose last activity fell on that day, not sessions started
   * that day. */
  sparkline: SparklineDay[];
  totals: {
    sessions: number;
    projects: number;
  };
}

const SPARKLINE_DAYS = 7;

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function computeFleetStats(
  sessions: Record<string, Session>,
  projectNames: Record<string, string | null>,
  now: Date = new Date(),
): FleetStats {
  const all = Object.values(sessions);
  const today = dayKey(now.toISOString());

  const rightNow: RightNowStats = { working: 0, needsYou: 0, idle: 0, live: 0 };
  for (const session of all) {
    if (session.status === "working") rightNow.working += 1;
    else if (session.status === "needsYou") rightNow.needsYou += 1;
    else if (session.status === "idle") rightNow.idle += 1;
    if (session.status !== "dormant") rightNow.live += 1;
  }

  const activeTodaySessions = all.filter((s) => dayKey(s.lastActivity) === today);

  const projectCountsToday = new Map<string, number>();
  for (const session of activeTodaySessions) {
    if (!session.cwd) continue;
    projectCountsToday.set(session.cwd, (projectCountsToday.get(session.cwd) ?? 0) + 1);
  }
  let mostActiveProject: MostActiveProject | null = null;
  for (const [cwd, count] of projectCountsToday) {
    if (!mostActiveProject || count > mostActiveProject.count) {
      mostActiveProject = { label: displayProjectName(cwd, projectNames[cwd]), count };
    }
  }

  const sparklineCounts = new Map<string, number>();
  for (const session of all) {
    const key = dayKey(session.lastActivity);
    sparklineCounts.set(key, (sparklineCounts.get(key) ?? 0) + 1);
  }
  const sparkline: SparklineDay[] = [];
  for (let i = SPARKLINE_DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKey(d.toISOString());
    sparkline.push({ date: key, count: sparklineCounts.get(key) ?? 0 });
  }

  const projects = new Set(all.map((s) => s.cwd).filter((cwd): cwd is string => Boolean(cwd)));

  return {
    rightNow,
    activeToday: activeTodaySessions.length,
    mostActiveProject,
    sparkline,
    totals: { sessions: all.length, projects: projects.size },
  };
}
