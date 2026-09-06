import { useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useDeck } from "../store";
import { computeFleetStats, playCardFraming, type RightNowStats } from "../lib/stats";
import { loadBest, type BestScore } from "../lib/tarmacDefenseBest";
import { formatTokenCount } from "../lib/formatTokens";
import { EMPTY_TOKEN_STATS, fetchTokenStats, type TokenStats } from "../lib/tokenStats";
import {
  drawSnapshotCard,
  shareSnapshot,
  SNAPSHOT_HEIGHT,
  SNAPSHOT_WIDTH,
  type SnapshotData,
} from "../lib/snapshotCard";
import { Logo, RunwayDivider } from "./icons/BrandMotifs";
import { TarmacDefense } from "./TarmacDefense";
import { Toast, useToast } from "./Toast";

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

  const [tokens, setTokens] = useState<TokenStats>(EMPTY_TOKEN_STATS);
  // On a cold token cache the first `fetchTokenStats` invoke can take up to
  // ~35s to resolve (the Rust-side compute), during which `tokens` is still the
  // zeroed default. This flag lets the headline show a quiet "computing…"
  // affordance instead of a bare 0, so a real zero (loaded) reads differently
  // from not-computed-yet. Only the first load is uncomputed; the 30s poll
  // afterward just refreshes an already-loaded number.
  const [tokensLoaded, setTokensLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetchTokenStats()
        .then((next) => {
          if (!cancelled) {
            setTokens(next);
            setTokensLoaded(true);
          }
        })
        .catch(() => {
          // token_stats() never errors on the Rust side (missing dir just
          // yields zeros) — this only fires if the command itself can't be
          // reached, in which case the last-known stats stay on screen.
        });
    };
    refresh();
    // The backend cache refreshes at most once every 60s, so polling faster
    // than that just re-reads the same cached snapshot — 30s keeps the
    // number moving during a session without any real extra scan cost.
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // The content half of the snapshot — everything but `now`, which is
  // stamped fresh at render/share time. Shared between the live preview and
  // the actual share action so they can never drift apart.
  const snapshotBase = useMemo(
    () => ({
      tokens,
      sessionsToday: stats.activeToday,
      projects: stats.totals.projects,
      best,
      version,
    }),
    [tokens, stats.activeToday, stats.totals.projects, best, version],
  );

  const { toast, showToast } = useToast();
  const [sharing, setSharing] = useState(false);
  const handleShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const result = await shareSnapshot({ ...snapshotBase, now: new Date() });
      if (result.method === "clipboard") {
        showToast(result.shareSheet ? "Copied — and ready to share" : "Snapshot copied");
      } else if (result.method === "file") showToast("Snapshot saved");
    } catch (err) {
      console.error("Failed to share snapshot", err);
      showToast("Couldn't create snapshot");
    } finally {
      setSharing(false);
    }
  };

  if (playing) {
    return (
      <TarmacDefense
        onExit={() => setPlaying(false)}
        sessionsToday={stats.activeToday}
        projects={stats.totals.projects}
        version={version}
      />
    );
  }

  return (
    <div className="thin-scrollbar h-full overflow-y-auto px-8 py-12">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-9">
        <header className="flex flex-col items-center gap-2 text-center">
          <Logo className="h-6 w-6 text-ink-muted" />
          <h1 className="text-base font-semibold text-ink">Agent Tarmac</h1>
          <p className="max-w-sm text-sm text-ink-faint">
            {!hasSessions
              ? "Nothing on the board yet — waiting for agent sessions to appear."
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

        <RunwayDivider />

        <TokensSection
          tokens={tokens}
          tokensLoaded={tokensLoaded}
          snapshotBase={snapshotBase}
          sharing={sharing}
          onShare={handleShare}
        />

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
              v{update.version} available — View release
            </button>
          ) : (
            <span>up to date</span>
          )}
        </footer>
      </div>
      <Toast toast={toast} />
    </div>
  );
}

/**
 * The "tokenmaxxing" stats section — today's output tokens as the flex
 * number (largest figure on the page besides the game's own HUD), input +
 * cache-read kept subtle beneath it, all-time total as the long view. The
 * live preview below renders the exact PNG the share action produces (same
 * lib/snapshotCard.ts draw code, same numbers) so there's never a surprise
 * between what's on screen and what gets shared.
 */
function TokensSection({
  tokens,
  tokensLoaded,
  snapshotBase,
  sharing,
  onShare,
}: {
  tokens: TokenStats;
  tokensLoaded: boolean;
  snapshotBase: Omit<SnapshotData, "now">;
  sharing: boolean;
  onShare: () => void;
}) {
  const allTime = tokens.totalInput + tokens.totalOutput;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink-muted">Tokenmaxxing</h2>
        <button
          type="button"
          onClick={onShare}
          disabled={sharing}
          title="Share this tokenmaxxing snapshot"
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors duration-150 hover:border-accent/50 hover:text-ink disabled:opacity-50"
        >
          {sharing ? "Rendering…" : "Share snapshot"}
        </button>
      </div>
      {tokensLoaded ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tabular-nums text-ink">{formatTokenCount(tokens.todayOutput)}</span>
            <span className="text-xs text-ink-faint">tokens out today</span>
          </div>
          <p className="text-xs text-ink-faint">
            {formatTokenCount(tokens.todayInput)} in · {formatTokenCount(tokens.todayCacheRead)} cache read
          </p>
          <p className="text-xs text-ink-faint">{formatTokenCount(allTime)} all-time</p>
        </>
      ) : (
        // Cold cache: the invoke is still computing the counts (up to ~35s).
        // A quiet shimmer stands in for the headline so it doesn't read as a
        // real zero — this is a background calc, not an error, so keep it calm.
        <>
          <div className="flex items-baseline gap-2">
            <span
              className="animate-pulse text-4xl font-semibold text-ink-faint/70"
              aria-hidden="true"
            >
              ·····
            </span>
            <span className="text-xs text-ink-faint">tallying tokens out today…</span>
          </div>
          <p className="text-xs text-ink-faint">reading local session logs</p>
        </>
      )}
      <SnapshotPreview data={snapshotBase} sharing={sharing} onShare={onShare} />
    </section>
  );
}

/**
 * A live, to-scale preview of the exact card the share action produces —
 * "show on the dashboard how it will be exported" per product feedback.
 * Redraws (lightly debounced) whenever the underlying numbers change, at
 * the viewer's actual device pixel ratio so it stays crisp on retina.
 * Clicking it shares, same as the button above.
 */
function SnapshotPreview({
  data,
  sharing,
  onShare,
}: {
  data: Omit<SnapshotData, "now">;
  sharing: boolean;
  onShare: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const DISPLAY_WIDTH = 480;
  const displayHeight = Math.round((DISPLAY_WIDTH * SNAPSHOT_HEIGHT) / SNAPSHOT_WIDTH);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The numbers here tick at most every 30s (token poll) or right after a
    // game run — nothing time-sensitive enough to redraw on every render,
    // so a light debounce avoids doing the draw work on transient state.
    const timer = window.setTimeout(() => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = Math.round(DISPLAY_WIDTH * dpr);
      const targetHeight = Math.round((targetWidth * SNAPSHOT_HEIGHT) / SNAPSHOT_WIDTH);
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.setTransform(targetWidth / SNAPSHOT_WIDTH, 0, 0, targetHeight / SNAPSHOT_HEIGHT, 0, 0);
      drawSnapshotCard(ctx, { ...data, now: new Date() });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [data]);

  return (
    <button
      type="button"
      onClick={onShare}
      disabled={sharing}
      title="Click to share this snapshot"
      className="group self-start overflow-hidden rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-all duration-150 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_10px_28px_rgba(0,0,0,0.4)] focus-visible:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <canvas
        ref={canvasRef}
        style={{ width: DISPLAY_WIDTH, height: displayHeight }}
        className="block"
        aria-hidden="true"
      />
      <span className="sr-only">Share this tokenmaxxing snapshot</span>
    </button>
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
