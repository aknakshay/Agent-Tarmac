import { useEffect, useRef } from "react";
import { JetMark } from "./jetMark";
import "./SplashScreen.css";

/**
 * Full-screen launch splash: the app "taking off". A large delta-wing dart
 * (the shared JetMark) sits centered on a dark tarmac, spools up, ignites
 * its afterburner, then climbs up and out the top of the frame while the
 * runway centerline streams past beneath. Plays once (~1.8s), then calls
 * `onComplete` so the container can reveal the main window.
 *
 * Prop contract:
 *
 *   onComplete       required. Fired exactly once when the climb-out
 *                    finishes (or after a short hold under reduced motion).
 *   minDurationMs?   floor on how long the splash stays up, so it never
 *                    flashes by if the app is ready instantly. Default
 *                    1600ms. onComplete fires at max(launch length,
 *                    minDurationMs).
 *
 * Pure CSS/SVG transforms + opacity; a `prefers-reduced-motion` branch
 * shows a still, lit jet and a brief hold instead of the takeoff.
 */
export interface SplashScreenProps {
  onComplete: () => void;
  minDurationMs?: number;
}

/** Matches --splash-launch-ms in SplashScreen.css (the climb-out length). */
const LAUNCH_MS = 1800;
const DEFAULT_MIN_MS = 1600;
/** Reduced-motion: a short, calm hold on the static jet, then reveal. */
const REDUCED_MS = 600;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function SplashScreen({
  onComplete,
  minDurationMs = DEFAULT_MIN_MS,
}: SplashScreenProps) {
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const reduced = prefersReducedMotion();

  useEffect(() => {
    const delay = reduced
      ? Math.max(REDUCED_MS, minDurationMs)
      : Math.max(LAUNCH_MS, minDurationMs);
    const timer = window.setTimeout(() => onCompleteRef.current(), delay);
    return () => window.clearTimeout(timer);
  }, [reduced, minDurationMs]);

  return (
    <div
      className="splash"
      data-reduced={reduced ? "true" : undefined}
      role="status"
      aria-label="Launching Agent Tarmac"
    >
      <div className="splash__runway" aria-hidden="true">
        <div className="splash__stripes" />
      </div>

      <div className="splash__stage" aria-hidden="true">
        <div className="splash__jet">
          <JetMark className="splash__mark" />
        </div>
        <p className="splash__wordmark">Agent Tarmac</p>
      </div>
    </div>
  );
}
