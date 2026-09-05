import { useEffect, useRef } from "react";
import { loadBest, saveBest, type BestScore } from "../lib/tarmacDefenseBest";

/**
 * Tarmac Defense — a small canvas space shooter, easter egg reachable only
 * from Home's "Play Tarmac Defense" affordance (never auto-starts). Player
 * is a delta-wing drawn from the same geometry as the brand mark and
 * JetIcon; enemies escalate across levels (straight → zigzag → diver);
 * score/best persist to localStorage.
 *
 * Everything lives in one mutable ref rather than React state: the game
 * loop runs at 60fps and both game state and the HUD are drawn directly to
 * the canvas, so there's no per-frame re-render to synchronize.
 */

const WIDTH = 480;
const HEIGHT = 360;
const PLAYER_HALF = 12;
const BULLET_SPEED = 6;
const INTERSTITIAL_MS = 1400;

type EnemyType = "straight" | "zigzag" | "diver";

interface Enemy {
  x: number;
  y: number;
  t: number;
  type: EnemyType;
}

interface Bullet {
  x: number;
  y: number;
}

type Phase = "playing" | "interstitial" | "gameover";

interface GameState {
  playerX: number;
  bullets: Bullet[];
  enemies: Enemy[];
  level: number;
  score: number;
  lives: number;
  phase: Phase;
  remainingToSpawn: number;
  spawnTimer: number;
  phaseUntil: number;
  lastShot: number;
  stripeOffset: number;
  best: BestScore;
}

function freshWave(state: GameState, level: number) {
  state.level = level;
  state.enemies = [];
  state.bullets = [];
  state.remainingToSpawn = 6 + level * 2;
  state.spawnTimer = 0;
  state.phase = "playing";
}

function newGame(): GameState {
  const state: GameState = {
    playerX: WIDTH / 2,
    bullets: [],
    enemies: [],
    level: 1,
    score: 0,
    lives: 3,
    phase: "playing",
    remainingToSpawn: 0,
    spawnTimer: 0,
    phaseUntil: 0,
    lastShot: 0,
    stripeOffset: 0,
    best: loadBest(),
  };
  freshWave(state, 1);
  return state;
}

export function TarmacDefense({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(newGame());
  const keysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onExit();
        return;
      }
      const key = e.key.toLowerCase();
      keysRef.current.add(key);
      if (key === " ") e.preventDefault();
      if (stateRef.current.phase === "gameover" && (key === " " || key === "enter")) {
        stateRef.current = newGame();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [onExit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let raf = 0;

    const spawnEnemy = (state: GameState) => {
      const level = state.level;
      const roll = Math.random();
      const type: EnemyType =
        level >= 3 && roll < 0.3 ? "diver" : level >= 2 && roll < 0.6 ? "zigzag" : "straight";
      state.enemies.push({ x: 24 + Math.random() * (WIDTH - 48), y: -10, t: 0, type });
    };

    const tick = (time: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const state = stateRef.current;
      const keys = keysRef.current;

      if (state.phase === "playing") {
        const speed = 4.2;
        if (keys.has("arrowleft") || keys.has("a")) state.playerX -= speed;
        if (keys.has("arrowright") || keys.has("d")) state.playerX += speed;
        state.playerX = Math.max(PLAYER_HALF, Math.min(WIDTH - PLAYER_HALF, state.playerX));

        if (keys.has(" ") && time - state.lastShot > 220) {
          state.lastShot = time;
          state.bullets.push({ x: state.playerX, y: HEIGHT - 40 });
        }

        state.spawnTimer -= 1;
        const spawnEvery = Math.max(16, 44 - state.level * 4);
        if (state.remainingToSpawn > 0 && state.spawnTimer <= 0) {
          state.spawnTimer = spawnEvery;
          state.remainingToSpawn -= 1;
          spawnEnemy(state);
        }

        for (const b of state.bullets) b.y -= BULLET_SPEED;

        const speedMul = 1 + (state.level - 1) * 0.22;
        for (const e of state.enemies) {
          e.t += 1;
          if (e.type === "zigzag") e.x += Math.sin(e.t * 0.08) * 2.2;
          if (e.type === "diver") {
            const dx = state.playerX - e.x;
            e.x += Math.sign(dx) * Math.min(Math.abs(dx), 1.6);
          }
          e.y += 1.35 * speedMul;
        }

        for (const b of state.bullets) {
          for (const e of state.enemies) {
            if (Math.abs(b.x - e.x) < 12 && Math.abs(b.y - e.y) < 12) {
              e.y = HEIGHT + 999; // mark dead, swept below
              b.y = -999;
              state.score += 10;
            }
          }
        }

        for (const e of state.enemies) {
          if (e.y > HEIGHT - 18 && e.y < HEIGHT + 100) {
            e.y = HEIGHT + 999;
            state.lives -= 1;
          }
        }

        state.bullets = state.bullets.filter((b) => b.y > -20 && b.y < HEIGHT + 20);
        state.enemies = state.enemies.filter((e) => e.y < HEIGHT + 50);

        if (state.lives <= 0) {
          state.phase = "gameover";
          if (
            state.score > state.best.score ||
            (state.score === state.best.score && state.level > state.best.level)
          ) {
            state.best = { score: state.score, level: state.level };
            saveBest(state.best);
          }
        } else if (state.remainingToSpawn === 0 && state.enemies.length === 0) {
          state.phase = "interstitial";
          state.phaseUntil = time + INTERSTITIAL_MS;
        }
      } else if (state.phase === "interstitial" && time >= state.phaseUntil) {
        freshWave(state, state.level + 1);
      }

      state.stripeOffset = (state.stripeOffset + 1.5) % 40;
      draw(ctx, state);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-app-bg">
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="rounded-lg border border-border"
        role="img"
        aria-label="Tarmac Defense mini-game"
      />
      <p className="text-xs text-ink-faint">Arrows/WASD to move · Space to fire · Esc to exit</p>
    </div>
  );
}

function draw(ctx: CanvasRenderingContext2D, state: GameState) {
  ctx.fillStyle = "#12141a";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Runway-stripe starfield: scrolling dashed centerline lanes.
  ctx.strokeStyle = "rgba(161,165,172,0.18)";
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 14]);
  for (const laneX of [WIDTH * 0.25, WIDTH * 0.5, WIDTH * 0.75]) {
    ctx.beginPath();
    ctx.moveTo(laneX, state.stripeOffset - 40);
    ctx.lineTo(laneX, HEIGHT);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Player: delta wing, geometry echoing JetIcon/logo.
  const px = state.playerX;
  const py = HEIGHT - 30;
  ctx.fillStyle = "#7fd88f";
  ctx.beginPath();
  ctx.moveTo(px, py - PLAYER_HALF);
  ctx.lineTo(px + PLAYER_HALF, py + PLAYER_HALF * 0.8);
  ctx.lineTo(px, py + PLAYER_HALF * 0.3);
  ctx.lineTo(px - PLAYER_HALF, py + PLAYER_HALF * 0.8);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#e8ecf1";
  for (const b of state.bullets) {
    ctx.fillRect(b.x - 1.5, b.y - 6, 3, 8);
  }

  for (const e of state.enemies) {
    ctx.fillStyle = e.type === "diver" ? "#e7a15c" : e.type === "zigzag" ? "#e7c85c" : "#c9707d";
    ctx.beginPath();
    ctx.moveTo(e.x, e.y + 9);
    ctx.lineTo(e.x + 9, e.y - 6);
    ctx.lineTo(e.x - 9, e.y - 6);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = "#e8ecf1";
  ctx.font = "12px -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`Score ${state.score}`, 10, 18);
  ctx.fillText(`Level ${state.level}`, 10, 34);
  ctx.textAlign = "right";
  ctx.fillText(`Lives ${state.lives}`, WIDTH - 10, 18);
  ctx.fillText(`Best ${state.best.score} (L${state.best.level})`, WIDTH - 10, 34);
  ctx.textAlign = "left";

  if (state.phase === "interstitial") {
    overlay(ctx, "RUNWAY CLEAR", `Level ${state.level + 1} inbound`);
  } else if (state.phase === "gameover") {
    overlay(ctx, "GO-AROUND", `Score ${state.score} · Space to fly again`);
  }
}

function overlay(ctx: CanvasRenderingContext2D, title: string, subtitle: string) {
  ctx.fillStyle = "rgba(18,20,26,0.72)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "#e8ecf1";
  ctx.textAlign = "center";
  ctx.font = "bold 22px -apple-system, sans-serif";
  ctx.fillText(title, WIDTH / 2, HEIGHT / 2 - 6);
  ctx.font = "13px -apple-system, sans-serif";
  ctx.fillStyle = "#a1a5ac";
  ctx.fillText(subtitle, WIDTH / 2, HEIGHT / 2 + 18);
  ctx.textAlign = "left";
}
