/**
 * Pure math for Tarmac Defense: wave composition, the difficulty curve,
 * scoring with a combo/multiplier chain, hit/graze collision checks, and
 * power-up drops. Kept separate from the game component so it can be unit
 * tested without a canvas or an rAF loop.
 */

export type EnemyType = "straight" | "zigzag" | "diver" | "tank";
export type PowerUpType = "spread" | "rapid" | "shield" | "wingman";

const POWERUP_TYPES: PowerUpType[] = ["spread", "rapid", "shield", "wingman"];

const BASE_SPAWN_FRAMES = 44;
const MIN_SPAWN_FRAMES = 14;
const TANK_FIRST_LEVEL = 3;
const TANK_EVERY_LEVELS = 3;
const BREATHER_EVERY_LEVELS = 5;

export interface WaveConfig {
  enemyCount: number;
  spawnEveryFrames: number;
  speedMultiplier: number;
  hasTank: boolean;
  tankHp: number;
  isBreather: boolean;
}

/**
 * Wave composition for a level: enemy count, spawn rate, and speed ramp up
 * steadily. A tank wave lands every third level from level 3 on; a breather
 * wave (fewer, slower enemies, no tank) lands every fifth level otherwise —
 * the ramp-then-calm rhythm that keeps a long run from feeling like a flat
 * grind.
 */
export function waveConfig(level: number): WaveConfig {
  const hasTank = level >= TANK_FIRST_LEVEL && (level - TANK_FIRST_LEVEL) % TANK_EVERY_LEVELS === 0;
  const isBreather = !hasTank && level > 1 && level % BREATHER_EVERY_LEVELS === 0;

  const baseCount = 6 + level * 2;
  const baseSpawn = Math.max(MIN_SPAWN_FRAMES, BASE_SPAWN_FRAMES - level * 4);
  const baseSpeed = 1 + (level - 1) * 0.2;

  return {
    enemyCount: isBreather ? Math.round(baseCount * 0.6) : baseCount,
    spawnEveryFrames: isBreather ? baseSpawn + 10 : baseSpawn,
    speedMultiplier: isBreather ? Number((baseSpeed * 0.85).toFixed(3)) : baseSpeed,
    hasTank,
    tankHp: hasTank ? 3 + Math.floor(level / TANK_EVERY_LEVELS) : 0,
    isBreather,
  };
}

/** Regular (non-tank) enemy type for a spawn, weighted by level. */
export function enemyTypeForRoll(level: number, roll: number): EnemyType {
  if (level >= 3 && roll < 0.3) return "diver";
  if (level >= 2 && roll < 0.6) return "zigzag";
  return "straight";
}

export const COMBO_STEP = 5;
export const COMBO_MAX_MULTIPLIER = 4;

/**
 * Kills chained without a miss or taking a hit step the multiplier up every
 * COMBO_STEP kills, capped at COMBO_MAX_MULTIPLIER. `chain` is the number of
 * kills already banked in the current streak (0 for the first kill).
 */
export function comboMultiplier(chain: number): number {
  return Math.min(COMBO_MAX_MULTIPLIER, 1 + Math.floor(chain / COMBO_STEP) * 0.5);
}

export function enemyBaseScore(type: EnemyType): number {
  switch (type) {
    case "straight":
      return 10;
    case "zigzag":
      return 15;
    case "diver":
      return 20;
    case "tank":
      return 60;
  }
}

export function scoreForKill(type: EnemyType, chain: number): number {
  return Math.round(enemyBaseScore(type) * comboMultiplier(chain));
}

export const GRAZE_RADIUS = 22;
export const HIT_RADIUS = 12;
export const TANK_HIT_RADIUS = 20;

export function circlesOverlap(ax: number, ay: number, bx: number, by: number, radius: number): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy <= radius * radius;
}

/** A near-miss: inside the graze ring but outside the hit radius. */
export function isGraze(ax: number, ay: number, bx: number, by: number): boolean {
  return circlesOverlap(ax, ay, bx, by, GRAZE_RADIUS) && !circlesOverlap(ax, ay, bx, by, HIT_RADIUS);
}

const TANK_DROP_CHANCE = 1;
const REGULAR_DROP_CHANCE = 0.08;

/** Whether a kill drops a power-up. Tanks always do; regular enemies rarely. */
export function shouldDropPowerUp(type: EnemyType, dropRoll: number): boolean {
  return dropRoll < (type === "tank" ? TANK_DROP_CHANCE : REGULAR_DROP_CHANCE);
}

export function pickPowerUpType(roll: number): PowerUpType {
  const index = Math.min(POWERUP_TYPES.length - 1, Math.floor(roll * POWERUP_TYPES.length));
  return POWERUP_TYPES[index];
}
