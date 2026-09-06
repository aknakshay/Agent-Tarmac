import { useId } from "react";
import type { Session } from "../types";

/**
 * Micro delta-wing jet, replacing the plain status dot everywhere a
 * session's status is shown (sidebar rows, command bar, terminal pane
 * header). Geometry is a simplified version of the dart in
 * `assets/brand/logo.svg` (`M12 1.6 L21.2 17.1 L12 13.3 L2.8 17.1 Z`),
 * rescaled to a 16x16 box so it stays legible at 12-14px.
 *
 * Color semantics match the beacon-light vocabulary in
 * `assets/brand/motifs.md` (c): working = taxi light (green, in motion),
 * needsYou = beacon light (solid amber), idle = parked/engines off (dim),
 * dormant = hollow outline only — the solid/hollow split is the
 * color-blind-safe signal, kept independent of hue.
 */

const STATUS_TEXT_CLASS: Record<Session["status"], string> = {
  working: "text-working",
  needsYou: "text-needs-you",
  idle: "text-ink-faint",
  dormant: "text-ink-faint",
};

const JET_PATH = "M8 1.2 L13.4 12.2 L8 9.8 L2.6 12.2 Z";

interface JetIconProps {
  status: Session["status"];
  /** Popped out to an external terminal — pitched up as if departing. */
  external?: boolean;
  className?: string;
}

export function JetIcon({ status, external = false, className = "h-2.5 w-2.5" }: JetIconProps) {
  const hollow = status === "dormant";
  // Unique per instance — this glyph renders many times at once (every
  // sidebar row), and gradient ids must not collide across <svg>s.
  const flameGradientId = useId();

  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`shrink-0 ${STATUS_TEXT_CLASS[status]} ${className}`}
      style={external ? { transform: "rotate(-20deg)" } : undefined}
    >
      <path
        d={JET_PATH}
        fill={hollow ? "none" : "currentColor"}
        stroke={hollow ? "currentColor" : "none"}
        strokeWidth={hollow ? 1.3 : 0}
        strokeLinejoin="round"
        opacity={status === "idle" ? 0.6 : 1}
      />
      {status === "working" && (
        <>
          {/* Real afterburner physics: hottest (red) at the nozzle, cooling
              to yellow at the flame's tip — kept off the hull's green so
              the flame reads as its own thing even at 12-14px. */}
          <defs>
            <linearGradient id={flameGradientId} x1="8" y1="10" x2="8" y2="13.2" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#ff5a3c" />
              <stop offset="100%" stopColor="#ffd166" />
            </linearGradient>
          </defs>
          <ellipse
            cx="8"
            cy="11.6"
            rx="1"
            ry="1.6"
            fill={`url(#${flameGradientId})`}
            className="origin-[8px_11.6px] animate-[jet-afterburner_1.4s_ease-in-out_infinite]"
          />
        </>
      )}
    </svg>
  );
}
