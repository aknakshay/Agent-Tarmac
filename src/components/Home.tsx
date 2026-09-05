import { useMemo, useState } from "react";
import { useDeck } from "../store";
import { computeFleetStats, type SparklineDay } from "../lib/stats";
import { Logo, RunwayDivider } from "./icons/BrandMotifs";
import { TarmacDefense } from "./TarmacDefense";

/**
 * Replaces the "no session selected" placeholder. A calm fleet overview —
 * what's running right now, what happened today, and the sparkline/totals
 * for a longer view — rather than an empty pane. See motifs.md for the
 * runway-centerline divider and ATC copy this borrows.
 */
export function Home() {
  const sessions = useDeck((state) => state.sessions);
  const projectNames = useDeck((state) => state.projectNames);
  const hasSessions = Object.keys(sessions).length > 0;

  const stats = useMemo(() => computeFleetStats(sessions, projectNames), [sessions, projectNames]);
  const allQuiet = stats.rightNow.live === 0;
  const [playing, setPlaying] = useState(false);

  if (playing) {
    return <TarmacDefense onExit={() => setPlaying(false)} />;
  }

  return (
    <div className="thin-scrollbar h-full overflow-y-auto px-8 py-12">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-9">
        <header className="flex flex-col items-center gap-2 text-center">
          <Logo className="h-6 w-6 text-ink-muted" />
          <h1 className="text-base font-semibold text-ink">Agent Tarmac</h1>
          <p className="max-w-sm text-sm text-ink-faint">
            {!hasSessions
              ? "Nothing on the board yet — waiting for Claude Code sessions to appear."
              : allQuiet
                ? "All quiet on the tarmac."
                : "Select a session from the sidebar, or see what's moving below."}
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-ink-muted">Right now</h2>
          <div className="grid grid-cols-4 gap-2.5">
            <StatTile label="Live" value={stats.rightNow.live} tone="accent" />
            <StatTile label="Working" value={stats.rightNow.working} tone="working" />
            <StatTile label="Needs you" value={stats.rightNow.needsYou} tone="needsYou" />
            <StatTile label="Idle" value={stats.rightNow.idle} tone="neutral" />
          </div>
        </section>

        <RunwayDivider />

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-ink-muted">Today</h2>
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-2xl font-semibold text-ink">{stats.activeToday}</div>
              <div className="text-xs text-ink-faint">active sessions</div>
            </div>
            {stats.mostActiveProject && (
              <div className="text-right">
                <div className="max-w-[12rem] truncate text-sm font-medium text-ink">
                  {stats.mostActiveProject.label}
                </div>
                <div className="text-xs text-ink-faint">
                  busiest project · {stats.mostActiveProject.count} session
                  {stats.mostActiveProject.count === 1 ? "" : "s"}
                </div>
              </div>
            )}
          </div>
          <Sparkline data={stats.sparkline} />
        </section>

        <RunwayDivider />

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-ink-muted">Fleet totals</h2>
          <div className="grid grid-cols-2 gap-2.5">
            <StatTile label="All-time sessions" value={stats.totals.sessions} tone="neutral" />
            <StatTile label="Projects" value={stats.totals.projects} tone="neutral" />
          </div>
        </section>

        <button
          type="button"
          onClick={() => setPlaying(true)}
          className="self-center rounded-md px-3 py-1.5 text-xs text-ink-faint transition-colors duration-150 hover:text-ink-muted"
        >
          Play Tarmac Defense
        </button>
      </div>
    </div>
  );
}

const TILE_TONE_CLASS = {
  accent: "text-accent",
  working: "text-working",
  needsYou: "text-needs-you",
  neutral: "text-ink",
} as const;

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: keyof typeof TILE_TONE_CLASS;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-border px-3 py-4">
      <span className={`text-2xl font-semibold tabular-nums ${TILE_TONE_CLASS[tone]}`}>{value}</span>
      <span className="text-center text-xs text-ink-faint">{label}</span>
    </div>
  );
}

/**
 * 7-day bar sparkline sitting on a dashed runway-centerline baseline (see
 * motifs.md a). Counts sessions by last-activity day, not session start —
 * `SessionMeta` has no creation timestamp, so the label says "active
 * sessions by day" rather than implying a start count it can't back up.
 */
function Sparkline({ data }: { data: SparklineDay[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const barWidth = 100 / data.length;
  const baselineY = 28;

  return (
    <div className="flex flex-col gap-1.5">
      <svg
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
        className="h-8 w-full"
        role="img"
        aria-label={`Active sessions per day, last 7 days: ${data.map((d) => `${d.date} ${d.count}`).join(", ")}`}
      >
        <line
          x1="0"
          y1={baselineY}
          x2="100"
          y2={baselineY}
          stroke="var(--color-border)"
          strokeWidth="1"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
        {data.map((d, i) => {
          const h = (d.count / max) * 22;
          if (h <= 0) return null;
          return (
            <rect
              key={d.date}
              x={i * barWidth + barWidth * 0.22}
              y={baselineY - h}
              width={barWidth * 0.56}
              height={h}
              rx="1"
              fill="var(--color-accent)"
              opacity={0.85}
            />
          );
        })}
      </svg>
      <div className="text-xs text-ink-faint">active sessions by day, last 7 days</div>
    </div>
  );
}
