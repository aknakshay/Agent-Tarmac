import { useMemo, type CSSProperties } from "react";
import type { Session } from "../types";
import "./PilotAvatar.css";

/**
 * Deterministic generative "pilot" avatar for a session — a helmeted flight
 * crew member drawn from a hash of the session id, so the same session always
 * looks the same. The part system (helmet, visor, skin/species, crest,
 * antennae) yields tens of thousands of unique combinations; ~30% of the roster
 * is non-human. Identity is fixed per session and never changes with status —
 * status rides on the ring around the avatar instead (see the `--rc` ring color
 * and PilotAvatar.css), so the "which one needs me" signal survives.
 */

// FNV-1a hash → 32-bit; then mulberry32 as a tiny seeded PRNG so every pick is
// deterministic in the session id.
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

const HUMAN = ["#f3c9a3", "#e7b28a", "#d69a6a", "#b97a48", "#95582f", "#6d4126"];
const ALIEN = ["#8fd694", "#79c6c9", "#9a8cff", "#c98bd8", "#7fb0f0", "#b7c26a"];
const HELMET = ["#e9edf1", "#2b3440", "#c0453e", "#2f6bb0", "#4b7a4f", "#d7b46a", "#8a4fb0", "#37474f"];
const VISOR = [
  "rgba(90,200,225,.5)",
  "rgba(240,180,60,.5)",
  "rgba(150,120,255,.5)",
  "rgba(120,220,150,.5)",
  "rgba(200,210,220,.45)",
];
const STRIPE = ["#f2b03a", "#3fb9c9", "#e2e6ea", "#c0453e", "#a78bfa", "#57c06b"];
const BG = ["#22303b", "#2a2740", "#243528", "#3a2b2b", "#233a3c", "#2d3350", "#39322a", "#26303a"];
const SUIT = ["#1b232c", "#232b33", "#2a2320", "#1f2a2b", "#262232"];

function buildPilot(id: string): string {
  const r = mulberry32(hash(id));
  const alien = r() < 0.3;
  const skin = alien ? pick(r, ALIEN) : pick(r, HUMAN);
  const bg = pick(r, BG);
  const suit = pick(r, SUIT);
  const helmet = pick(r, HELMET);
  const visor = pick(r, VISOR);
  const stripe = pick(r, STRIPE);
  const eye = alien ? pick(r, ["#12331f", "#0e2b2c", "#1c1440"]) : "#20262f";
  const big = alien && r() < 0.6;
  const third = alien && r() < 0.45;
  const ant = alien && r() < 0.5;
  const er = big ? 4.4 : 3.3;
  const cid = "p" + hash(id).toString(36);

  let s = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;
  s += `<defs><clipPath id="${cid}"><circle cx="50" cy="50" r="50"/></clipPath></defs>`;
  s += `<g clip-path="url(#${cid})">`;
  s += `<rect width="100" height="100" fill="${bg}"/>`;
  s += `<ellipse cx="50" cy="103" rx="43" ry="31" fill="${suit}"/>`;
  s += `<path d="M50 79 l-12 24 h24 z" fill="${suit}"/>`;
  if (ant) {
    s += `<line x1="38" y1="24" x2="33" y2="9" stroke="${stripe}" stroke-width="2.4" stroke-linecap="round"/><circle cx="33" cy="8" r="3.2" fill="${stripe}"/>`;
    s += `<line x1="62" y1="24" x2="67" y2="9" stroke="${stripe}" stroke-width="2.4" stroke-linecap="round"/><circle cx="67" cy="8" r="3.2" fill="${stripe}"/>`;
  }
  s += `<circle cx="50" cy="47" r="33" fill="${helmet}"/>`;
  s += `<rect x="46.2" y="15" width="7.6" height="21" rx="3.8" fill="${stripe}"/>`;
  s += `<ellipse cx="50" cy="55" rx="22" ry="24" fill="${skin}"/>`;
  s += `<rect x="27" y="45" width="46" height="17" rx="8.5" fill="${visor}"/>`;
  s += `<circle cx="41" cy="55" r="${er}" fill="${eye}"/><circle cx="59" cy="55" r="${er}" fill="${eye}"/>`;
  if (third) s += `<circle cx="50" cy="47.5" r="${er - 0.6}" fill="${eye}"/>`;
  s += `</g></svg>`;
  return s;
}

const RING_COLOR: Record<Session["status"], string> = {
  working: "var(--color-working)",
  needsYou: "var(--color-needs-you)",
  idle: "var(--color-ink-muted)",
  dormant: "var(--color-ink-faint)",
};

interface PilotAvatarProps {
  /** Stable session id — the whole avatar is derived from this. */
  id: string;
  status: Session["status"];
  /** Pixel size of the (circular) avatar. */
  size?: number;
}

export function PilotAvatar({ id, status, size = 40 }: PilotAvatarProps) {
  const svg = useMemo(() => buildPilot(id), [id]);
  return (
    <span
      className={`pilot-av${status === "needsYou" ? " pilot-av--need" : ""}`}
      style={{ width: size, height: size, "--rc": RING_COLOR[status] } as CSSProperties}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
