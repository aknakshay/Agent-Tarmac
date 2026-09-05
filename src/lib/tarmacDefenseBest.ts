/**
 * Persisted best-run record for the Tarmac Defense mini-game. Lives outside
 * TarmacDefense.tsx so Home's prominent play card can read it without
 * pulling in the game component (and its canvas/rAF loop) just to show a
 * number.
 */

const BEST_KEY = "tarmac-defense-best";

export interface BestScore {
  score: number;
  level: number;
}

export function loadBest(): BestScore {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (!raw) return { score: 0, level: 1 };
    const parsed = JSON.parse(raw) as Partial<BestScore>;
    if (typeof parsed.score === "number" && typeof parsed.level === "number") {
      return { score: parsed.score, level: parsed.level };
    }
  } catch {
    // ignore malformed/unavailable storage — fall through to defaults
  }
  return { score: 0, level: 1 };
}

export function saveBest(best: BestScore) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // best-effort only; a private window or full storage just loses the record
  }
}
