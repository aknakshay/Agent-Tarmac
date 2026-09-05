import type { Session } from "../types";
import { displayProjectName } from "./projectMeta";

export interface RightNowStats {
  working: number;
  needsYou: number;
  idle: number;
  /** Any non-dormant session — a PTY is actually running. */
  live: number;
}

export interface PlayCardFraming {
  subtitle: string;
  /** True when every live session is heads-down working — a good moment to invite a run. */
  emphasize: boolean;
}

/**
 * Copy for the Tarmac Defense play card on Home, framed around "play while
 * your agents work" rather than as a generic game link. Returns null when a
 * session needs the user — the card should stay quiet and not compete for
 * attention, so the caller falls back to plain best-score copy instead.
 */
export function playCardFraming(rightNow: RightNowStats): PlayCardFraming | null {
  if (rightNow.needsYou > 0) return null;
  if (rightNow.working > 0 && rightNow.working === rightNow.live) {
    return {
      subtitle: `${rightNow.working} agent${rightNow.working === 1 ? "" : "s"} working — you've got a minute.`,
      emphasize: true,
    };
  }
  return { subtitle: "All agents heads-down? Take a flight.", emphasize: false };
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
  totals: {
    sessions: number;
    projects: number;
  };
}

/**
 * Buckets a timestamp by the user's LOCAL calendar day, not UTC. Slicing the
 * ISO string would roll "today" over at UTC midnight — mid-afternoon for
 * negative-offset timezones — so a Pacific user's active session would fall
 * out of "Today" at 4-5pm. Local getters keep the boundary at local midnight.
 */
function dayKey(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function computeFleetStats(
  sessions: Record<string, Session>,
  projectNames: Record<string, string | null>,
  now: Date = new Date(),
): FleetStats {
  const all = Object.values(sessions);
  const today = dayKey(now);

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

  const projects = new Set(all.map((s) => s.cwd).filter((cwd): cwd is string => Boolean(cwd)));

  return {
    rightNow,
    activeToday: activeTodaySessions.length,
    mostActiveProject,
    totals: { sessions: all.length, projects: projects.size },
  };
}
