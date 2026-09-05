import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useDeck } from "../store";
import { computeFleetStats, playCardFraming, type RightNowStats } from "../lib/stats";
import { loadBest, type BestScore } from "../lib/tarmacDefenseBest";
import { Logo, RunwayDivider } from "./icons/BrandMotifs";
import { TarmacDefense } from "./TarmacDefense";

interface UpdateAvailablePayload {
  version: string;
  url: string;
}

/**
 * Replaces the "no session selected" placeholder. A calm fleet overview —
 * what's running right now, what happened today, and the fleet totals
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
  const [best, setBest] = useState<BestScore | null>(null);

  // Read on mount and whenever the game hands control back — a run just
  // played may have set a new best.
  useEffect(() => {
    if (!playing) setBest(loadBest());
  }, [playing]);

  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateAvailablePayload | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
    // Parallel listener to UpdateBanner's (same event, additive display) —
    // same StrictMode-safe promise-cleanup pattern.
    const updateAvailable = listen<UpdateAvailablePayload>("update_available", (event) =>
      setUpdate(event.payload),
    );
    return () => {
      updateAvailable.then((unlisten) => unlisten());
    };
  }, []);

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

        <PlayCard best={best} rightNow={stats.rightNow} onPlay={() => setPlaying(true)} />

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
        </section>

        <RunwayDivider />

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-ink-muted">Fleet totals</h2>
          <div className="grid grid-cols-2 gap-2.5">
            <StatTile label="All-time sessions" value={stats.totals.sessions} tone="neutral" />
            <StatTile label="Projects" value={stats.totals.projects} tone="neutral" />
          </div>
        </section>

        <footer className="flex items-center justify-center gap-1.5 pt-2 text-xs text-ink-faint">
          <span>Agent Tarmac{version ? ` v${version}` : ""}</span>
          <span aria-hidden="true">·</span>
          {update ? (
            <button
              type="button"
              onClick={() =>
                openUrl(update.url).catch((err) => console.error("Failed to open release page", err))
              }
              className="font-medium text-accent transition-opacity duration-150 hover:opacity-80"
            >
              v{update.version} available — view release
            </button>
          ) : (
            <span>up to date</span>
          )}
        </footer>
      </div>
    </div>
  );
}

/**
 * Prominent launcher for the Tarmac Defense mini-game, placed right after
 * the Right-now tiles per product feedback ("make the game play CTA much
 * above") — it was previously a small footer link, easy to miss entirely.
 */
function PlayCard({
  best,
  rightNow,
  onPlay,
}: {
  best: BestScore | null;
  rightNow: RightNowStats;
  onPlay: () => void;
}) {
  // The game exists for the wait-while-agents-work moment: an invitation
  // when agents are heads-down, quiet when something needs the user
  // (playCardFraming returns null then, and the card never competes for
  // attention). Logic lives in stats.ts where it's unit-tested.
  const framing = playCardFraming(rightNow);
  const bestLine = best && best.score > 0 ? `Best: ${best.score} pts · Level ${best.level}` : "No runs yet";
  return (
    <section
      className={`flex items-center gap-4 rounded-xl border px-5 py-4 ${
        framing?.emphasize ? "border-accent/50 bg-accent/[0.1]" : "border-accent/25 bg-accent/[0.06]"
      }`}
    >
      <Logo className="h-8 w-8 shrink-0 text-accent" />
      <div className="flex-1">
        <h2 className="text-sm font-semibold text-ink">Tarmac Defense</h2>
        <p className="text-xs text-ink-faint">
          {framing ? `${framing.subtitle} · ${bestLine}` : bestLine}
        </p>
      </div>
      <button
        type="button"
        onClick={onPlay}
        className="shrink-0 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-app-bg transition-colors duration-150 hover:bg-accent/85"
      >
        Play
      </button>
    </section>
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
