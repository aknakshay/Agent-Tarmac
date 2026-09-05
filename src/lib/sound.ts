/** The app's single notification sound: a radar ping (880Hz blip with a
 * quieter echo), synthesized with Web Audio so no audio file ships. Played
 * when a session needs attention while the user isn't looking at it — the
 * audible twin of the amber badge. Every call is wrapped so audio problems
 * (no output device, autoplay policy, suspended context) can never break the
 * caller. */

let ctx: AudioContext | null = null;

function blip(at: number, gainPeak: number): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(gainPeak, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.2);
}

export function playRadarPing(): void {
  try {
    ctx = ctx ?? new AudioContext();
    if (ctx.state === "suspended") {
      // Resume is async; if the browser blocks it this ping is silently
      // skipped — the badge still carries the signal.
      void ctx.resume();
    }
    const now = ctx.currentTime;
    blip(now, 0.12);
    blip(now + 0.25, 0.05); // the echo
  } catch {
    // Sound is a garnish; never let it throw into store logic.
  }
}
