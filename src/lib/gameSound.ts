/**
 * Sound effects for the Tarmac Defense mini-game, synthesized with Web Audio
 * so no audio file ships (same approach as ../lib/sound.ts's radar ping).
 * Lives separately from that module because it has its own mute switch:
 * muting the game must never affect the app's notification ping, and vice
 * versa.
 *
 * `playGameSound` is a small dispatcher in front of a table of synth
 * functions. It checks the persisted mute flag first and no-ops for free
 * when muted, so callers at every engine event (fire, hit, kill, wave
 * clear, death) can call it unconditionally. The synth table is swappable
 * via `setSynths` purely so tests can assert the muted path never touches
 * Web Audio at all.
 */

const MUTE_KEY = "tarmac-defense-muted";

export type GameSoundName =
  | "shoot"
  | "enemyHit"
  | "explosion"
  | "bossHit"
  | "powerUp"
  | "waveClear"
  | "gameOver";

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    // No storage access (private mode, disabled storage) — default unmuted.
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // best-effort only; the in-memory toggle for this session still works
  }
}

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  ctx = ctx ?? new AudioContext();
  if (ctx.state === "suspended") {
    // Resume is async; if the browser blocks it the sound is silently
    // skipped for this call.
    void ctx.resume();
  }
  return ctx;
}

function tone(at: number, freq: number, durationSec: number, gainPeak: number, type: OscillatorType = "sine") {
  const audio = getCtx();
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(gainPeak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + durationSec);
  osc.connect(gain).connect(audio.destination);
  osc.start(at);
  osc.stop(at + durationSec + 0.02);
  return { osc, gain };
}

function noiseBurst(at: number, durationSec: number, gainPeak: number, filterFreqStart: number, filterFreqEnd: number) {
  const audio = getCtx();
  const sampleCount = Math.max(1, Math.floor(audio.sampleRate * durationSec));
  const buffer = audio.createBuffer(1, sampleCount, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i += 1) data[i] = Math.random() * 2 - 1;

  const source = audio.createBufferSource();
  source.buffer = buffer;

  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(filterFreqStart, at);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, filterFreqEnd), at + durationSec);

  const gain = audio.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(gainPeak, at + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + durationSec);

  source.connect(filter).connect(gain).connect(audio.destination);
  source.start(at);
  source.stop(at + durationSec + 0.02);
}

const synths: Record<GameSoundName, () => void> = {
  shoot: () => {
    const now = getCtx().currentTime;
    tone(now, 620, 0.05, 0.03, "sine");
  },
  enemyHit: () => {
    const now = getCtx().currentTime;
    noiseBurst(now, 0.04, 0.08, 3200, 1200);
  },
  explosion: () => {
    const now = getCtx().currentTime;
    noiseBurst(now, 0.15, 0.16, 1600, 90);
    const { osc } = tone(now, 220, 0.15, 0.05, "sawtooth");
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.15);
  },
  bossHit: () => {
    const now = getCtx().currentTime;
    tone(now, 110, 0.09, 0.14, "square");
  },
  powerUp: () => {
    const now = getCtx().currentTime;
    tone(now, 660, 0.08, 0.08, "sine");
    tone(now + 0.07, 990, 0.1, 0.08, "sine");
  },
  waveClear: () => {
    const now = getCtx().currentTime;
    tone(now, 400, 0.3, 0.1, "sine");
  },
  gameOver: () => {
    const now = getCtx().currentTime;
    const { osc } = tone(now, 300, 0.4, 0.1, "sine");
    osc.frequency.exponentialRampToValueAtTime(120, now + 0.4);
  },
};

let activeSynths: Record<GameSoundName, () => void> = synths;

/** Test-only seam: swap the synth table (e.g. to spy on which sounds would
 * fire) without touching Web Audio. Call with no argument to restore the
 * real synths. */
export function setSynths(overrides?: Partial<Record<GameSoundName, () => void>>): void {
  activeSynths = overrides ? { ...synths, ...overrides } : synths;
}

export function playGameSound(name: GameSoundName): void {
  if (isMuted()) return;
  try {
    activeSynths[name]();
  } catch {
    // Sound is a garnish; never let it throw into the game loop.
  }
}
