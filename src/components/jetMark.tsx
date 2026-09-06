import { useId } from "react";
import "./jetMark.css";

/**
 * Shared delta-wing dart used by both the launch splash (SplashScreen) and
 * the sidebar loading state (SidebarLoading), so the two read as the SAME
 * aircraft: the splash launches it, the sidebar shows it still climbing.
 *
 * Geometry is the brand mark from `assets/brand/logo.svg` (also used by
 * JetIcon.tsx). The afterburner keeps the app's red->yellow ramp
 * (--jl-flame-* in jetMark.css, matching JetIcon's #ff5a3c -> #ffd166).
 *
 * This component only draws the aircraft. All motion (taxi, flicker,
 * climb-out) is owned by the consuming component's CSS, which targets the
 * stable classNames below (.jetmark, .jetmark__flame, .jetmark__dart).
 */

export const JET_DART_PATH = "M12 1.6 L21.2 17.1 L12 13.3 L2.8 17.1 Z";
// The accent sits as a nozzle ring at the dart's tail, ABOVE the flame, so
// a lit afterburner trails cleanly below it instead of being bisected.
export const JET_TAIL_PATH = "M9.6 17 L14.4 17 L13.7 18.5 L10.3 18.5 Z";
export const JET_FLAME_PATH = "M10.1 18.3 L13.9 18.3 L12 25 Z";

interface JetMarkProps {
  className?: string;
  /** Render the afterburner flame (default true). */
  flame?: boolean;
}

export function JetMark({ className = "", flame = true }: JetMarkProps) {
  // Unique per instance so gradient ids never collide across <svg>s.
  const gid = useId();

  return (
    <svg
      className={`jetmark ${className}`.trim()}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gid}
          x1="12"
          y1="18.3"
          x2="12"
          y2="25"
          gradientUnits="userSpaceOnUse"
        >
          {/* Hottest at the nozzle, cooling to the tip. */}
          <stop offset="0%" stopColor="var(--jl-flame-hot)" />
          <stop offset="100%" stopColor="var(--jl-flame-warm)" />
        </linearGradient>
      </defs>

      {/* Flame first, so the hull sits over the nozzle. */}
      {flame && (
        <path className="jetmark__flame" d={JET_FLAME_PATH} fill={`url(#${gid})`} />
      )}
      <path className="jetmark__dart" d={JET_DART_PATH} />
      <path className="jetmark__tail" d={JET_TAIL_PATH} />
    </svg>
  );
}
