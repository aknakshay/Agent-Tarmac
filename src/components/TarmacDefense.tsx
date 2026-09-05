import { useEffect, useRef, useState } from "react";
import { isMuted, playGameSound, setMuted } from "../lib/gameSound";
import { loadBest, saveBest, type BestScore } from "../lib/tarmacDefenseBest";
import {
  circlesOverlap,
  comboMultiplier,
  enemyTypeForRoll,
  isGraze,
  pickPowerUpType,
  scoreForKill,
  shouldDropPowerUp,
  waveConfig,
  HIT_RADIUS,
  TANK_HIT_RADIUS,
  type EnemyType,
  type PowerUpType,
  type WaveConfig,
} from "../lib/tarmacDefenseEngine";

/**
 * Tarmac Defense — a full-pane canvas space shooter, reachable only from
 * Home's "Play" card (never auto-starts). Player is a delta-wing drawn from
 * the same geometry as the brand mark; enemy roles, the difficulty curve,
 * scoring, and power-up drops live in lib/tarmacDefenseEngine.ts so that
 * math is unit tested without a canvas. Score/best persist to localStorage
 * via lib/tarmacDefenseBest.ts.
 *
 * Everything lives in one mutable ref rather than React state: the game
 * loop runs at ~60fps and both game state and the HUD are drawn directly to
 * the canvas, so there's no per-frame re-render to synchronize.
 */

const PLAYER_HALF = 12;
const WINGMAN_OFFSET = 26;
const BULLET_SPEED = 7;
const INTERSTITIAL_MS = 1400;
const SPREAD_MS = 7000;
const RAPID_MS = 7000;
const MAX_WINGMEN = 2;
const NORMAL_COOLDOWN_MS = 220;
const RAPID_COOLDOWN_MS = 110;
const COMBO_WINDOW_FRAMES = 90;
const SHAKE_MS = 220;
const HIT_FLASH_MS = 160;

interface Bullet {
  x: number;
  y: number;
  dx: number;
}

interface Enemy {
  x: number;
  y: number;
  t: number;
  type: EnemyType;
  hp: number;
  maxHp: number;
  grazed: boolean;
  flashUntil: number;
}

interface FallingPowerUp {
  x: number;
  y: number;
  type: PowerUpType;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

type Phase = "playing" | "interstitial" | "gameover";

interface GameState {
  width: number;
  height: number;
  playerX: number;
  bullets: Bullet[];
  enemies: Enemy[];
  powerUps: FallingPowerUp[];
  particles: Particle[];
  level: number;
  score: number;
  lives: number;
  phase: Phase;
  wave: WaveConfig;
  remainingToSpawn: number;
  tankSpawned: boolean;
  spawnTimer: number;
  phaseUntil: number;
  lastShot: number;
  stripeOffset: number;
  best: BestScore;
  lastRun: BestScore | null;
  comboChain: number;
  comboTimer: number;
  wingmen: number;
  spreadUntil: number;
  rapidUntil: number;
  shieldCharges: number;
  shakeUntil: number;
  hitFlashUntil: number;
}

function freshWave(state: GameState, level: number) {
  state.level = level;
  state.enemies = [];
  state.bullets = [];
  state.powerUps = [];
  state.wave = waveConfig(level);
  state.remainingToSpawn = state.wave.enemyCount;
  state.tankSpawned = false;
  state.spawnTimer = 0;
  state.phase = "playing";
}

function newGame(width: number, height: number): GameState {
  const state: GameState = {
    width,
    height,
    playerX: width / 2,
    bullets: [],
    enemies: [],
    powerUps: [],
    particles: [],
    level: 1,
    score: 0,
    lives: 3,
    phase: "playing",
    wave: waveConfig(1),
    remainingToSpawn: 0,
    tankSpawned: false,
    spawnTimer: 0,
    phaseUntil: 0,
    lastShot: 0,
    stripeOffset: 0,
    best: loadBest(),
    lastRun: null,
    comboChain: 0,
    comboTimer: 0,
    wingmen: 0,
    spreadUntil: 0,
    rapidUntil: 0,
    shieldCharges: 0,
    shakeUntil: 0,
    hitFlashUntil: 0,
  };
  freshWave(state, 1);
  return state;
}

function spawnParticles(state: GameState, x: number, y: number, color: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const speed = 1.2 + Math.random() * 2.2;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 22,
      maxLife: 22,
      color,
    });
  }
}

const ENEMY_COLOR: Record<EnemyType, string> = {
  straight: "#c9707d",
  zigzag: "#e7c85c",
  diver: "#e7a15c",
  tank: "#8f6fd1",
};

const POWERUP_LABEL: Record<PowerUpType, string> = {
  spread: "S",
  rapid: "R",
  shield: "H",
  wingman: "W",
};

const POWERUP_COLOR: Record<PowerUpType, string> = {
  spread: "#7fd8c8",
  rapid: "#f0d15c",
  shield: "#7fa8d8",
  wingman: "#a3e07f",
};

export function TarmacDefense({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(newGame(480, 360));
  const keysRef = useRef<Set<string>>(new Set());
  const reducedMotionRef = useRef(false);
  const [muted, setMutedState] = useState(() => isMuted());

  const toggleMute = () => {
    setMutedState((prev) => {
      const next = !prev;
      setMuted(next);
      return next;
    });
  };

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onExit();
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "m") {
        toggleMute();
        return;
      }
      keysRef.current.add(key);
      if (key === " ") e.preventDefault();
      if (stateRef.current.phase === "gameover" && (key === " " || key === "enter")) {
        const { width, height } = stateRef.current;
        stateRef.current = newGame(width, height);
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
    const container = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !container || !ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      stateRef.current.width = width;
      stateRef.current.height = height;
      stateRef.current.playerX = Math.min(Math.max(stateRef.current.playerX, PLAYER_HALF), width - PLAYER_HALF);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let raf = 0;

    const spawnEnemy = (state: GameState) => {
      const isTankSpawn = state.wave.hasTank && !state.tankSpawned;
      const type: EnemyType = isTankSpawn ? "tank" : enemyTypeForRoll(state.level, Math.random());
      if (isTankSpawn) state.tankSpawned = true;
      const hp = type === "tank" ? state.wave.tankHp : 1;
      state.enemies.push({
        x: 24 + Math.random() * (state.width - 48),
        y: -10,
        t: 0,
        type,
        hp,
        maxHp: hp,
        grazed: false,
        flashUntil: 0,
      });
    };

    const applyPowerUp = (state: GameState, type: PowerUpType, time: number) => {
      if (type === "spread") state.spreadUntil = time + SPREAD_MS;
      else if (type === "rapid") state.rapidUntil = time + RAPID_MS;
      else if (type === "shield") state.shieldCharges = Math.min(1, state.shieldCharges + 1);
      else if (type === "wingman") state.wingmen = Math.min(MAX_WINGMEN, state.wingmen + 1);
    };

    const registerKill = (state: GameState, enemy: Enemy, time: number) => {
      const points = scoreForKill(enemy.type, state.comboChain);
      state.score += points;
      state.comboChain += 1;
      state.comboTimer = COMBO_WINDOW_FRAMES;
      spawnParticles(state, enemy.x, enemy.y, ENEMY_COLOR[enemy.type], enemy.type === "tank" ? 16 : 8);
      if (shouldDropPowerUp(enemy.type, Math.random())) {
        state.powerUps.push({ x: enemy.x, y: enemy.y, type: pickPowerUpType(Math.random()) });
      }
      void time;
    };

    const takeDamage = (state: GameState, time: number) => {
      if (state.shieldCharges > 0) {
        state.shieldCharges -= 1;
      } else {
        state.lives -= 1;
        state.shakeUntil = time + SHAKE_MS;
        state.hitFlashUntil = time + HIT_FLASH_MS;
      }
      state.comboChain = 0;
      state.comboTimer = 0;
    };

    const tick = (time: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const state = stateRef.current;
      const keys = keysRef.current;
      const py = state.height - 30;

      if (state.phase === "playing") {
        const speed = 4.2;
        if (keys.has("arrowleft") || keys.has("a")) state.playerX -= speed;
        if (keys.has("arrowright") || keys.has("d")) state.playerX += speed;
        state.playerX = Math.max(PLAYER_HALF, Math.min(state.width - PLAYER_HALF, state.playerX));

        const cooldown = time < state.rapidUntil ? RAPID_COOLDOWN_MS : NORMAL_COOLDOWN_MS;
        if (keys.has(" ") && time - state.lastShot > cooldown) {
          state.lastShot = time;
          const spread = time < state.spreadUntil;
          const shootFrom = (x: number) => {
            state.bullets.push({ x, y: py, dx: 0 });
            if (spread) {
              state.bullets.push({ x, y: py, dx: -2.4 });
              state.bullets.push({ x, y: py, dx: 2.4 });
            }
          };
          shootFrom(state.playerX);
          for (let i = 0; i < state.wingmen; i += 1) {
            shootFrom(state.playerX + (i === 0 ? -WINGMAN_OFFSET : WINGMAN_OFFSET));
          }
          playGameSound("shoot");
        }

        if (state.comboTimer > 0) {
          state.comboTimer -= 1;
          if (state.comboTimer === 0) state.comboChain = 0;
        }

        state.spawnTimer -= 1;
        if (state.remainingToSpawn > 0 && state.spawnTimer <= 0) {
          state.spawnTimer = state.wave.spawnEveryFrames;
          state.remainingToSpawn -= 1;
          spawnEnemy(state);
        }

        for (const b of state.bullets) {
          b.x += b.dx;
          b.y -= BULLET_SPEED;
        }

        for (const e of state.enemies) {
          e.t += 1;
          if (e.type === "zigzag") e.x += Math.sin(e.t * 0.08) * 2.2;
          if (e.type === "diver") {
            const dx = state.playerX - e.x;
            e.x += Math.sign(dx) * Math.min(Math.abs(dx), 1.6);
          }
          const fallSpeed = (e.type === "tank" ? 0.75 : 1.35) * state.wave.speedMultiplier;
          e.y += fallSpeed;
        }

        for (const b of state.bullets) {
          for (const e of state.enemies) {
            const radius = e.type === "tank" ? TANK_HIT_RADIUS : HIT_RADIUS;
            if (!circlesOverlap(b.x, b.y, e.x, e.y, radius)) continue;
            b.y = -999;
            e.hp -= 1;
            e.flashUntil = time + 90;
            if (e.hp <= 0) {
              registerKill(state, e, time);
              e.y = state.height + 999;
              playGameSound("explosion");
            } else {
              playGameSound(e.type === "tank" ? "bossHit" : "enemyHit");
            }
          }
        }

        for (const p of state.powerUps) p.y += 1.4;
        state.powerUps = state.powerUps.filter((p) => {
          if (!circlesOverlap(state.playerX, py, p.x, p.y, 16)) return p.y < state.height + 20;
          applyPowerUp(state, p.type, time);
          spawnParticles(state, p.x, p.y, POWERUP_COLOR[p.type], 10);
          playGameSound("powerUp");
          return false;
        });

        for (const e of state.enemies) {
          if (e.y > state.height + 50) continue;
          if (!e.grazed && isGraze(state.playerX, py, e.x, e.y)) {
            e.grazed = true;
            state.score += 2;
          }
          if (e.y > state.height - 18 && e.y < state.height + 100) {
            e.y = state.height + 999;
            takeDamage(state, time);
          }
        }

        for (const p of state.particles) {
          p.x += p.vx;
          p.y += p.vy;
          p.life -= 1;
        }
        state.particles = state.particles.filter((p) => p.life > 0);

        state.bullets = state.bullets.filter((b) => b.y > -20 && b.y < state.height + 20);
        state.enemies = state.enemies.filter((e) => e.y < state.height + 50);

        if (state.lives <= 0) {
          state.phase = "gameover";
          state.lastRun = { score: state.score, level: state.level };
          if (
            state.score > state.best.score ||
            (state.score === state.best.score && state.level > state.best.level)
          ) {
            state.best = { score: state.score, level: state.level };
            saveBest(state.best);
          }
          playGameSound("gameOver");
        } else if (state.remainingToSpawn === 0 && state.enemies.length === 0) {
          state.phase = "interstitial";
          state.phaseUntil = time + INTERSTITIAL_MS;
          playGameSound("waveClear");
        }
      } else if (state.phase === "interstitial" && time >= state.phaseUntil) {
        freshWave(state, state.level + 1);
      }

      state.stripeOffset = (state.stripeOffset + 1.5) % 40;
      draw(ctx, state, time, reducedMotionRef.current);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-app-bg">
      <canvas ref={canvasRef} className="block h-full w-full" role="img" aria-label="Tarmac Defense mini-game" />
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? "Unmute game sound" : "Mute game sound"}
        aria-pressed={muted}
        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-ink-faint hover:text-ink"
      >
        {muted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
      </button>
      <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-ink-faint">
        Arrows/WASD to move · Space to fire · M to mute · Esc to exit
      </p>
    </div>
  );
}

function SpeakerOnIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M1 6v4h3l4 3V3L4 6H1z" />
      <path
        d="M11.2 5.1a3.5 3.5 0 0 1 0 5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M12.6 3.3a5.8 5.8 0 0 1 0 9.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M1 6v4h3l4 3V3L4 6H1z" />
      <path d="M11 6.2l3.6 3.6M14.6 6.2 11 9.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function draw(ctx: CanvasRenderingContext2D, state: GameState, time: number, reducedMotion: boolean) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { width: WIDTH, height: HEIGHT } = state;

  ctx.save();
  const shaking = time < state.shakeUntil;
  if (shaking) {
    const remaining = (state.shakeUntil - time) / SHAKE_MS;
    const magnitude = reducedMotion ? 1.5 : 6;
    ctx.translate((Math.random() - 0.5) * magnitude * remaining, (Math.random() - 0.5) * magnitude * remaining);
  }

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

  const py = HEIGHT - 30;
  drawShip(ctx, state.playerX, py, PLAYER_HALF, "#7fd88f");
  for (let i = 0; i < state.wingmen; i += 1) {
    drawShip(ctx, state.playerX + (i === 0 ? -WINGMAN_OFFSET : WINGMAN_OFFSET), py + 4, PLAYER_HALF * 0.72, "#9fe0ac");
  }
  if (state.shieldCharges > 0) {
    ctx.strokeStyle = "rgba(127,168,216,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(state.playerX, py, PLAYER_HALF * 1.9, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = "#e8ecf1";
  for (const b of state.bullets) ctx.fillRect(b.x - 1.5, b.y - 6, 3, 8);

  for (const e of state.enemies) {
    const flashing = time < e.flashUntil;
    ctx.fillStyle = flashing ? "#ffffff" : ENEMY_COLOR[e.type];
    const size = e.type === "tank" ? 16 : 9;
    ctx.beginPath();
    ctx.moveTo(e.x, e.y + size);
    ctx.lineTo(e.x + size, e.y - size * 0.67);
    ctx.lineTo(e.x - size, e.y - size * 0.67);
    ctx.closePath();
    ctx.fill();

    if (e.type === "tank") {
      const barW = 34;
      const pct = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(e.x - barW / 2, e.y - size - 10, barW, 4);
      ctx.fillStyle = pct > 0.4 ? "#8fd88f" : "#e07f7f";
      ctx.fillRect(e.x - barW / 2, e.y - size - 10, barW * pct, 4);
    }
  }

  for (const p of state.powerUps) {
    ctx.fillStyle = POWERUP_COLOR[p.type];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#12141a";
    ctx.font = "bold 10px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(POWERUP_LABEL[p.type], p.x, p.y + 3.5);
    ctx.textAlign = "left";
  }

  if (!reducedMotion || state.particles.length < 6) {
    for (const p of state.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  if (time < state.hitFlashUntil) {
    const alpha = ((state.hitFlashUntil - time) / HIT_FLASH_MS) * (reducedMotion ? 0.12 : 0.28);
    ctx.fillStyle = `rgba(224,127,127,${alpha})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  ctx.fillStyle = "#e8ecf1";
  ctx.font = "12px -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`Score ${state.score}`, 10, 18);
  ctx.fillText(`Level ${state.level}`, 10, 34);
  const mult = comboMultiplier(state.comboChain);
  if (mult > 1) {
    ctx.fillStyle = "#f0d15c";
    ctx.fillText(`x${mult} combo`, 10, 50);
  }
  ctx.fillStyle = "#e8ecf1";
  ctx.textAlign = "right";
  ctx.fillText(`Lives ${state.lives}`, WIDTH - 10, 18);
  ctx.fillText(`Best ${state.best.score} (L${state.best.level})`, WIDTH - 10, 34);
  ctx.textAlign = "left";

  if (state.wave.isBreather && state.phase === "playing") {
    ctx.fillStyle = "rgba(232,236,241,0.5)";
    ctx.textAlign = "center";
    ctx.font = "11px -apple-system, sans-serif";
    ctx.fillText("Clear skies", WIDTH / 2, 18);
    ctx.textAlign = "left";
  }

  if (state.phase === "interstitial") {
    overlay(ctx, WIDTH, HEIGHT, "RUNWAY CLEAR", `Level ${state.level + 1} inbound`);
  } else if (state.phase === "gameover") {
    drawGameOver(ctx, WIDTH, HEIGHT, state);
  }
}

function drawShip(ctx: CanvasRenderingContext2D, x: number, y: number, half: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - half);
  ctx.lineTo(x + half, y + half * 0.8);
  ctx.lineTo(x, y + half * 0.3);
  ctx.lineTo(x - half, y + half * 0.8);
  ctx.closePath();
  ctx.fill();
}

function overlay(ctx: CanvasRenderingContext2D, width: number, height: number, title: string, subtitle: string) {
  ctx.fillStyle = "rgba(18,20,26,0.72)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e8ecf1";
  ctx.textAlign = "center";
  ctx.font = "bold 22px -apple-system, sans-serif";
  ctx.fillText(title, width / 2, height / 2 - 6);
  ctx.font = "13px -apple-system, sans-serif";
  ctx.fillStyle = "#a1a5ac";
  ctx.fillText(subtitle, width / 2, height / 2 + 18);
  ctx.textAlign = "left";
}

function drawGameOver(ctx: CanvasRenderingContext2D, width: number, height: number, state: GameState) {
  ctx.fillStyle = "rgba(18,20,26,0.78)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e8ecf1";
  ctx.textAlign = "center";
  ctx.font = "bold 24px -apple-system, sans-serif";
  ctx.fillText("GO-AROUND", width / 2, height / 2 - 40);

  const last = state.lastRun ?? { score: state.score, level: state.level };
  const colW = 120;
  const cx = width / 2;

  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillStyle = "#a1a5ac";
  ctx.fillText("THIS RUN", cx - colW / 2, height / 2 - 10);
  ctx.fillText("BEST", cx + colW / 2, height / 2 - 10);

  ctx.font = "bold 18px -apple-system, sans-serif";
  ctx.fillStyle = "#e8ecf1";
  ctx.fillText(`${last.score}`, cx - colW / 2, height / 2 + 12);
  ctx.fillText(`${state.best.score}`, cx + colW / 2, height / 2 + 12);

  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillStyle = "#a1a5ac";
  ctx.fillText(`Level ${last.level}`, cx - colW / 2, height / 2 + 30);
  ctx.fillText(`Level ${state.best.level}`, cx + colW / 2, height / 2 + 30);

  ctx.font = "13px -apple-system, sans-serif";
  ctx.fillStyle = "#e8ecf1";
  ctx.fillText("Space or Enter to fly again", cx, height / 2 + 60);
  ctx.textAlign = "left";
}
