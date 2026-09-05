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
  /** Sign of the zigzag lateral term last frame and a decaying flash timer,
   * used to flare the thruster exactly when the enemy reverses direction.
   * Unused by other enemy types. */
  zigSign: number;
  zigFlashUntil: number;
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
  /** Previous frame's player X, used only to derive a banking-tilt angle for
   * rendering — never read by game logic. */
  prevPlayerX: number;
  /** Timestamp a fired shot's muzzle flash fades at, per barrel position. */
  muzzleFlashes: { x: number; until: number }[];
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
    prevPlayerX: width / 2,
    muzzleFlashes: [],
  };
  freshWave(state, 1);
  return state;
}

function spawnParticles(state: GameState, x: number, y: number, color: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const speed = 1.4 + Math.random() * 2.6;
    const life = 26 + Math.random() * 10;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      color,
    });
  }
}

/**
 * Palette pulled from the app's oklch design tokens (src/index.css), tinted
 * per role so each enemy silhouette is readable at a glance:
 *   drifter — cool gray-blue (a dim, unremarkable straggler)
 *   zigzag  — amber, matching --color-needs-you (erratic, "pay attention")
 *   diver   — red-tinged, intensifying as it commits to a dive
 *   tank    — desaturated violet plating, the boss silhouette
 * Also used to tint that enemy's explosion particles on death.
 */
const ENEMY_PALETTE: Record<EnemyType, { base: string; light: string; dark: string; glow: string }> = {
  straight: { base: "#7a8bab", light: "#aab7d1", dark: "#4b5875", glow: "#8fa3c9" },
  zigzag: { base: "#e0b24a", light: "#f7d787", dark: "#8a6420", glow: "#f7a73b" },
  diver: { base: "#c96a4f", light: "#f0967a", dark: "#6e2f22", glow: "#ff5c4d" },
  tank: { base: "#6f5f9e", light: "#9a8ac9", dark: "#3c3260", glow: "#c9a5ff" },
};

/** Back-compat flat color per type, used for particle tints and the HUD. */
const ENEMY_COLOR: Record<EnemyType, string> = {
  straight: ENEMY_PALETTE.straight.base,
  zigzag: ENEMY_PALETTE.zigzag.base,
  diver: ENEMY_PALETTE.diver.glow,
  tank: ENEMY_PALETTE.tank.base,
};

const PLAYER_PALETTE = {
  hullLight: "#7fe0a0",
  hullDark: "#2f8f55",
  accent: "#6ba5fb",
  flame: "#f7d787",
  flameHot: "#fff3d0",
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

type SpriteKind = "player" | "wingman" | "straight" | "zigzag" | "diver" | "tank";

/**
 * Offscreen sprite cache. Every ship/enemy silhouette (including its glow)
 * is expensive to path and shadowBlur, so each (kind, half-size, DPR) combo
 * is drawn exactly once onto its own small canvas here and then blitted
 * with `drawImage` every frame after — a blit is orders of magnitude
 * cheaper than re-building a gradient-filled, shadow-blurred path 30+ times
 * a frame. Only per-frame *variation* (banking tilt, engine flicker, hit
 * flash, dive glow) is drawn live on top of the cached blit. Padding around
 * each sprite leaves room for the glow to bleed past the silhouette without
 * clipping.
 */
const SPRITE_PAD = 1.9;
const spriteCache = new Map<string, HTMLCanvasElement>();

function getSprite(kind: SpriteKind, half: number, dpr: number): { canvas: HTMLCanvasElement; pad: number } {
  const pad = half * SPRITE_PAD;
  const key = `${kind}:${half}:${dpr}`;
  let canvas = spriteCache.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    const px = Math.max(1, Math.ceil(pad * 2 * dpr));
    canvas.width = px;
    canvas.height = px;
    const sctx = canvas.getContext("2d");
    if (sctx) {
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.translate(pad, pad);
      paintSprite(sctx, kind, half);
    }
    spriteCache.set(key, canvas);
  }
  return { canvas, pad };
}

function blitSprite(
  ctx: CanvasRenderingContext2D,
  kind: SpriteKind,
  x: number,
  y: number,
  half: number,
  dpr: number,
  opts?: { angle?: number; alpha?: number },
) {
  const { canvas, pad } = getSprite(kind, half, dpr);
  ctx.save();
  ctx.translate(x, y);
  if (opts?.angle) ctx.rotate(opts.angle);
  if (opts?.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  ctx.drawImage(canvas, -pad, -pad, pad * 2, pad * 2);
  ctx.restore();
}

/** Body-only silhouette for one sprite kind, drawn once into local space
 * centered on (0, 0) with "up" (the direction of travel / fire) as -y. */
function paintSprite(ctx: CanvasRenderingContext2D, kind: SpriteKind, half: number) {
  switch (kind) {
    case "player":
    case "wingman":
      paintDeltaWing(ctx, half, kind === "wingman");
      return;
    case "straight":
      paintDrifter(ctx, half);
      return;
    case "zigzag":
      paintZigzag(ctx, half);
      return;
    case "diver":
      paintDiver(ctx, half);
      return;
    case "tank":
      paintTank(ctx, half);
      return;
  }
}

/** The brand delta-wing (assets/brand/logo.svg), rendered as a layered hull
 * with a two-tone gradient, wing-edge highlights, and a cockpit canopy
 * glint. `dim` renders the smaller wingman variant: same geometry, cooler
 * and lower-contrast so it reads as backup rather than the lead ship. */
function paintDeltaWing(ctx: CanvasRenderingContext2D, half: number, dim: boolean) {
  const nose = { x: 0, y: -half * 1.2 };
  const rightTip = { x: half * 1.05, y: half * 0.6 };
  const notch = { x: 0, y: half * 0.18 };
  const leftTip = { x: -half * 1.05, y: half * 0.6 };

  const hull = ctx.createLinearGradient(0, nose.y, 0, rightTip.y);
  hull.addColorStop(0, dim ? "#bfe8cd" : PLAYER_PALETTE.hullLight);
  hull.addColorStop(1, dim ? "#3f6b52" : PLAYER_PALETTE.hullDark);

  if (!dim) {
    ctx.save();
    ctx.shadowColor = "rgba(127,224,160,0.55)";
    ctx.shadowBlur = half * 0.9;
    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.moveTo(nose.x, nose.y);
    ctx.lineTo(rightTip.x, rightTip.y);
    ctx.lineTo(notch.x, notch.y);
    ctx.lineTo(leftTip.x, leftTip.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.globalAlpha = dim ? 0.82 : 1;
  ctx.fillStyle = hull;
  ctx.beginPath();
  ctx.moveTo(nose.x, nose.y);
  ctx.lineTo(rightTip.x, rightTip.y);
  ctx.lineTo(notch.x, notch.y);
  ctx.lineTo(leftTip.x, leftTip.y);
  ctx.closePath();
  ctx.fill();

  // Leading-edge highlights on both wings — a thin bright stroke along the
  // nose-to-wingtip edge sells the hull as faceted metal, not a flat fill.
  ctx.strokeStyle = dim ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.55)";
  ctx.lineWidth = Math.max(0.6, half * 0.06);
  ctx.beginPath();
  ctx.moveTo(nose.x, nose.y);
  ctx.lineTo(rightTip.x, rightTip.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(nose.x, nose.y);
  ctx.lineTo(leftTip.x, leftTip.y);
  ctx.stroke();

  // Center spine (keel) — a dark line from nose to the rear notch, breaking
  // up the flat fill and hinting at a two-hull cross-section.
  ctx.strokeStyle = dim ? "rgba(20,40,30,0.35)" : "rgba(20,40,30,0.5)";
  ctx.lineWidth = Math.max(0.5, half * 0.05);
  ctx.beginPath();
  ctx.moveTo(nose.x, nose.y * 0.3);
  ctx.lineTo(notch.x, notch.y);
  ctx.stroke();

  // Cockpit canopy glint, just aft of the nose.
  ctx.fillStyle = dim ? "rgba(255,255,255,0.35)" : PLAYER_PALETTE.accent;
  ctx.globalAlpha = dim ? 0.55 : 0.85;
  ctx.beginPath();
  ctx.ellipse(0, nose.y * 0.32, half * 0.16, half * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.beginPath();
  ctx.ellipse(-half * 0.05, nose.y * 0.4, half * 0.06, half * 0.1, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** drifter: a small, angular dart — the plainest silhouette in the fleet,
 * on purpose, so it reads as background chaff next to the sharper roles. */
function paintDrifter(ctx: CanvasRenderingContext2D, half: number) {
  const p = ENEMY_PALETTE.straight;
  const grad = ctx.createLinearGradient(0, -half, 0, half);
  grad.addColorStop(0, p.light);
  grad.addColorStop(1, p.dark);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, half);
  ctx.lineTo(half * 0.85, -half * 0.75);
  ctx.lineTo(0, -half * 0.35);
  ctx.lineTo(-half * 0.85, -half * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = Math.max(0.5, half * 0.05);
  ctx.stroke();
  // Dim engine dot — this role never lights up the frame.
  ctx.fillStyle = "rgba(70,90,120,0.7)";
  ctx.beginPath();
  ctx.arc(0, half * 0.85, half * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

/** zigzag: an asymmetric swept wing (longer on one side) so the erratic
 * motion reads as a deliberate silhouette rather than a spinning dart. */
function paintZigzag(ctx: CanvasRenderingContext2D, half: number) {
  const p = ENEMY_PALETTE.zigzag;
  const grad = ctx.createLinearGradient(0, -half, 0, half);
  grad.addColorStop(0, p.light);
  grad.addColorStop(1, p.dark);
  ctx.save();
  ctx.shadowColor = "rgba(247,167,59,0.45)";
  ctx.shadowBlur = half * 0.5;
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, -half * 0.9);
  ctx.lineTo(half * 1.15, half * 0.55);
  ctx.lineTo(half * 0.15, half * 0.75);
  ctx.lineTo(-half * 0.7, half * 0.3);
  ctx.lineTo(-half * 0.2, -half * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // Amber accent along the long (right) sweep.
  ctx.strokeStyle = p.glow;
  ctx.lineWidth = Math.max(0.6, half * 0.09);
  ctx.beginPath();
  ctx.moveTo(0, -half * 0.9);
  ctx.lineTo(half * 1.15, half * 0.55);
  ctx.stroke();
}

/** diver: a narrow arrowhead. The nose carries a red-tinged glow that this
 * function only bakes in dimly — the live per-frame overlay in `draw()`
 * intensifies it as the enemy commits to its dive toward the player. */
function paintDiver(ctx: CanvasRenderingContext2D, half: number) {
  const p = ENEMY_PALETTE.diver;
  const grad = ctx.createLinearGradient(0, -half, 0, half);
  grad.addColorStop(0, p.light);
  grad.addColorStop(1, p.dark);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, -half * 1.3);
  ctx.lineTo(half * 0.55, half * 0.7);
  ctx.lineTo(0, half * 0.3);
  ctx.lineTo(-half * 0.55, half * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.shadowColor = p.glow;
  ctx.shadowBlur = half * 0.6;
  ctx.fillStyle = p.glow;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.arc(0, -half * 1.05, half * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** tank/boss: a chunky twin-hull silhouette — two side-by-side pods joined
 * by a center plate, plating seams, amber danger stripes, and a paired
 * engine glow. Visibly heavier than every other role. */
function paintTank(ctx: CanvasRenderingContext2D, half: number) {
  const p = ENEMY_PALETTE.tank;
  const grad = ctx.createLinearGradient(0, -half, 0, half);
  grad.addColorStop(0, p.light);
  grad.addColorStop(1, p.dark);

  const hullPath = (offsetX: number) => {
    ctx.beginPath();
    ctx.moveTo(offsetX, -half * 0.95);
    ctx.lineTo(offsetX + half * 0.55, -half * 0.25);
    ctx.lineTo(offsetX + half * 0.5, half * 0.85);
    ctx.lineTo(offsetX - half * 0.5, half * 0.85);
    ctx.lineTo(offsetX - half * 0.55, -half * 0.25);
    ctx.closePath();
  };

  ctx.save();
  ctx.shadowColor = "rgba(201,165,255,0.4)";
  ctx.shadowBlur = half * 0.5;
  ctx.fillStyle = grad;
  hullPath(-half * 0.42);
  ctx.fill();
  hullPath(half * 0.42);
  ctx.fill();
  ctx.restore();

  // Center connecting plate.
  ctx.fillStyle = p.dark;
  ctx.fillRect(-half * 0.28, -half * 0.15, half * 0.56, half * 0.9);

  // Plating seams.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = Math.max(0.6, half * 0.05);
  for (const offsetX of [-half * 0.42, half * 0.42]) {
    ctx.beginPath();
    ctx.moveTo(offsetX - half * 0.5, half * 0.15);
    ctx.lineTo(offsetX + half * 0.5, half * 0.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(offsetX - half * 0.48, half * 0.45);
    ctx.lineTo(offsetX + half * 0.48, half * 0.45);
    ctx.stroke();
  }

  // Amber danger stripes across the nose.
  ctx.strokeStyle = ENEMY_PALETTE.zigzag.glow;
  ctx.lineWidth = Math.max(0.8, half * 0.08);
  for (const offsetX of [-half * 0.42, half * 0.42]) {
    ctx.beginPath();
    ctx.moveTo(offsetX - half * 0.4, -half * 0.35);
    ctx.lineTo(offsetX + half * 0.15, -half * 0.7);
    ctx.stroke();
  }

  // Paired engines.
  ctx.fillStyle = "rgba(90,70,140,0.85)";
  for (const offsetX of [-half * 0.42, half * 0.42]) {
    ctx.beginPath();
    ctx.arc(offsetX, half * 0.85, half * 0.14, 0, Math.PI * 2);
    ctx.fill();
  }
}

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
        zigSign: 0,
        zigFlashUntil: 0,
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
          state.muzzleFlashes.push({ x: state.playerX, until: time + 70 });
          for (let i = 0; i < state.wingmen; i += 1) {
            const wx = state.playerX + (i === 0 ? -WINGMAN_OFFSET : WINGMAN_OFFSET);
            shootFrom(wx);
            state.muzzleFlashes.push({ x: wx, until: time + 70 });
          }
          playGameSound("shoot");
        }
        state.muzzleFlashes = state.muzzleFlashes.filter((m) => time < m.until);

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
          if (e.type === "zigzag") {
            e.x += Math.sin(e.t * 0.08) * 2.2;
            const sign = Math.sign(Math.cos(e.t * 0.08));
            if (sign !== 0 && e.zigSign !== 0 && sign !== e.zigSign) {
              e.zigFlashUntil = time + 150;
            }
            if (sign !== 0) e.zigSign = sign;
          }
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
      state.prevPlayerX = state.playerX;
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

  // Banking tilt: rotate a few degrees toward the direction of lateral
  // travel, derived from last frame's position rather than stored velocity
  // so this stays pure rendering with zero engine involvement.
  const vx = state.playerX - state.prevPlayerX;
  const bankAngle = Math.max(-0.24, Math.min(0.24, vx * 0.045));

  // Engine flicker: time-based, damped under reduced motion. Drawn live
  // (not baked into the sprite) so it can flutter every frame.
  const flicker = reducedMotion
    ? 0.85 + Math.sin(time * 0.006) * 0.06
    : 0.75 + Math.sin(time * 0.02) * 0.18 + Math.sin(time * 0.055) * 0.1;

  drawEngineFlame(ctx, state.playerX, py, PLAYER_HALF, flicker, 1);
  blitSprite(ctx, "player", state.playerX, py, PLAYER_HALF, dpr, { angle: bankAngle });
  for (let i = 0; i < state.wingmen; i += 1) {
    const wx = state.playerX + (i === 0 ? -WINGMAN_OFFSET : WINGMAN_OFFSET);
    const wHalf = PLAYER_HALF * 0.72;
    drawEngineFlame(ctx, wx, py + 4, wHalf, flicker, 0.7);
    blitSprite(ctx, "wingman", wx, py + 4, wHalf, dpr, { angle: bankAngle * 0.8, alpha: 0.85 });
  }
  if (state.shieldCharges > 0) {
    ctx.strokeStyle = "rgba(127,168,216,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(state.playerX, py, PLAYER_HALF * 1.9, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const m of state.muzzleFlashes) {
    const pct = Math.max(0, (m.until - time) / 70);
    if (pct <= 0) continue;
    ctx.save();
    ctx.globalAlpha = pct;
    ctx.fillStyle = PLAYER_PALETTE.flameHot;
    ctx.beginPath();
    ctx.ellipse(m.x, py - PLAYER_HALF * 1.3, 3.5 * pct + 1, 7 * pct + 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = "#e8ecf1";
  for (const b of state.bullets) ctx.fillRect(b.x - 1.5, b.y - 6, 3, 8);

  for (const e of state.enemies) {
    const size = e.type === "tank" ? 16 : 9;
    blitSprite(ctx, e.type, e.x, e.y, size, dpr);

    if (e.type === "diver") {
      // Dive glow intensifies the deeper the diver has committed to its run.
      const intensity = Math.max(0, Math.min(1, e.y / HEIGHT));
      ctx.save();
      ctx.globalAlpha = 0.3 + intensity * 0.6;
      ctx.shadowColor = ENEMY_PALETTE.diver.glow;
      ctx.shadowBlur = size * (0.6 + intensity * 1.2);
      ctx.fillStyle = ENEMY_PALETTE.diver.glow;
      ctx.beginPath();
      ctx.arc(e.x, e.y - size * 1.05, size * (0.16 + intensity * 0.14), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (e.type === "zigzag" && time < e.zigFlashUntil) {
      const pct = Math.max(0, (e.zigFlashUntil - time) / 150);
      ctx.save();
      ctx.globalAlpha = pct * 0.8;
      ctx.fillStyle = ENEMY_PALETTE.zigzag.glow;
      ctx.beginPath();
      ctx.arc(e.x, e.y + size * 0.75, size * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const flashing = time < e.flashUntil;
    if (flashing) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(e.x, e.y, size * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (e.type === "tank") {
      const barW = 36;
      const barH = 5;
      const barX = e.x - barW / 2;
      const barY = e.y - size - 12;
      const pct = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      roundRect(ctx, barX, barY, barW, barH, 2.5);
      ctx.fill();
      const low = pct <= 0.4;
      ctx.fillStyle = low ? ENEMY_PALETTE.diver.glow : "#52cd7d";
      if (pct > 0) {
        roundRect(ctx, barX, barY, Math.max(barH, barW * pct), barH, 2.5);
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 0.75;
      roundRect(ctx, barX, barY, barW, barH, 2.5);
      ctx.stroke();
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
      const alpha = Math.max(0, p.life / p.maxLife);
      const radius = 1.5 + (1 - alpha) * 1.8;
      ctx.globalAlpha = alpha;
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 2);
      glow.addColorStop(0, p.color);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 2, 0, Math.PI * 2);
      ctx.fill();
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

/** Animated engine flame trailing a ship's rear notch. Drawn live (not
 * cached) since `flicker` varies every frame; `strength` dims the wingman
 * variant. `flicker` is a ~[0.55, 1.05] multiplier on flame length/opacity. */
function drawEngineFlame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  half: number,
  flicker: number,
  strength: number,
) {
  const rearY = y + half * 0.5;
  const length = half * (0.9 + flicker * 0.7) * strength;
  const width = half * 0.42 * strength;
  ctx.save();
  ctx.globalAlpha = Math.min(1, 0.55 + flicker * 0.35) * strength;
  const grad = ctx.createLinearGradient(x, rearY, x, rearY + length);
  grad.addColorStop(0, PLAYER_PALETTE.flameHot);
  grad.addColorStop(0.45, PLAYER_PALETTE.flame);
  grad.addColorStop(1, "rgba(247,215,135,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x - width, rearY);
  ctx.quadraticCurveTo(x, rearY + length * 1.15, x + width, rearY);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Rounded-rect path helper for the tank HP bar. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
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
