import { describe, expect, it } from "vitest";
import {
  circlesOverlap,
  comboMultiplier,
  enemyTypeForRoll,
  isGraze,
  pickPowerUpType,
  scoreForKill,
  shouldDropPowerUp,
  waveConfig,
} from "./tarmacDefenseEngine";

describe("waveConfig", () => {
  it("ramps enemy count, spawn rate, and speed with level", () => {
    const l1 = waveConfig(1);
    const l4 = waveConfig(4);
    expect(l4.enemyCount).toBeGreaterThan(l1.enemyCount);
    expect(l4.spawnEveryFrames).toBeLessThan(l1.spawnEveryFrames);
    expect(l4.speedMultiplier).toBeGreaterThan(l1.speedMultiplier);
  });

  it("never lets spawn rate fall below the floor", () => {
    expect(waveConfig(50).spawnEveryFrames).toBeGreaterThanOrEqual(14);
  });

  it("places a tank every third level starting at level 3", () => {
    expect(waveConfig(3).hasTank).toBe(true);
    expect(waveConfig(6).hasTank).toBe(true);
    expect(waveConfig(9).hasTank).toBe(true);
    expect(waveConfig(4).hasTank).toBe(false);
    expect(waveConfig(2).hasTank).toBe(false);
  });

  it("gives tanks more hp on later levels", () => {
    expect(waveConfig(6).tankHp).toBeGreaterThan(waveConfig(3).tankHp);
  });

  it("marks a calmer breather wave every 5th level, unless it's also a tank level", () => {
    expect(waveConfig(5).isBreather).toBe(true);
    expect(waveConfig(10).isBreather).toBe(true);
    expect(waveConfig(4).isBreather).toBe(false);
  });

  it("makes a breather wave lighter than a same-level non-breather would be", () => {
    const breather = waveConfig(5);
    expect(breather.enemyCount).toBeLessThan(6 + 5 * 2);
    expect(breather.hasTank).toBe(false);
  });
});

describe("enemyTypeForRoll", () => {
  it("only ever spawns straight enemies on level 1", () => {
    expect(enemyTypeForRoll(1, 0)).toBe("straight");
    expect(enemyTypeForRoll(1, 0.99)).toBe("straight");
  });

  it("introduces zigzag at level 2 for low rolls", () => {
    expect(enemyTypeForRoll(2, 0.1)).toBe("zigzag");
    expect(enemyTypeForRoll(2, 0.9)).toBe("straight");
  });

  it("introduces diver at level 3 for the lowest rolls", () => {
    expect(enemyTypeForRoll(3, 0.1)).toBe("diver");
    expect(enemyTypeForRoll(3, 0.4)).toBe("zigzag");
    expect(enemyTypeForRoll(3, 0.9)).toBe("straight");
  });
});

describe("comboMultiplier", () => {
  it("starts at 1x with no chain", () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(4)).toBe(1);
  });

  it("steps up every COMBO_STEP kills", () => {
    expect(comboMultiplier(5)).toBe(1.5);
    expect(comboMultiplier(10)).toBe(2);
    expect(comboMultiplier(15)).toBe(2.5);
  });

  it("caps at COMBO_MAX_MULTIPLIER", () => {
    expect(comboMultiplier(1000)).toBe(4);
  });
});

describe("scoreForKill", () => {
  it("applies the combo multiplier to the enemy's base score", () => {
    expect(scoreForKill("straight", 0)).toBe(10);
    expect(scoreForKill("straight", 5)).toBe(15);
    expect(scoreForKill("tank", 0)).toBe(60);
  });
});

describe("collision checks", () => {
  it("circlesOverlap is true within radius, false outside it", () => {
    expect(circlesOverlap(0, 0, 5, 0, 10)).toBe(true);
    expect(circlesOverlap(0, 0, 50, 0, 10)).toBe(false);
  });

  it("isGraze is true just outside the hit radius but inside the graze ring", () => {
    expect(isGraze(0, 0, 18, 0)).toBe(true);
  });

  it("isGraze is false on a direct hit", () => {
    expect(isGraze(0, 0, 5, 0)).toBe(false);
  });

  it("isGraze is false when nowhere near", () => {
    expect(isGraze(0, 0, 100, 0)).toBe(false);
  });
});

describe("power-up drops", () => {
  it("tanks always drop", () => {
    expect(shouldDropPowerUp("tank", 0.99)).toBe(true);
  });

  it("regular enemies rarely drop", () => {
    expect(shouldDropPowerUp("straight", 0.01)).toBe(true);
    expect(shouldDropPowerUp("straight", 0.5)).toBe(false);
  });

  it("pickPowerUpType spans the full roll range without going out of bounds", () => {
    expect(pickPowerUpType(0)).toBe("spread");
    expect(pickPowerUpType(0.999)).toBe("wingman");
  });
});
