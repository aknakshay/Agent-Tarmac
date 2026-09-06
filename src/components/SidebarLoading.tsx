import { useEffect, useId, useRef, useState } from "react";
import "./SidebarLoading.css";

/**
 * Jet-launch loading state for the sidebar, shown while the session list
 * loads asynchronously on startup.
 *
 * A delta-wing dart — the brand mark from `assets/brand/logo.svg`, the same
 * geometry JetIcon.tsx uses — taxis on a foreshortened runway with a
 * streaming dashed centerline beneath it and a red->yellow afterburner
 * trailing (the app's afterburner treatment, matching JetIcon). When
 * `phase` flips to "done" the dart climbs out and the scene fades, then
 * `onComplete` fires (~600ms) so the parent can unmount.
 *
 * Motion is transform/opacity only; a `prefers-reduced-motion` resting
 * frame (static parked dart, no streaming/flame/climb-out) lives in
 * SidebarLoading.css.
 *
 * Prop contract (kept deliberately small for the wiring step):
 *
 *   phase       "loading"  jet taxis / stripes stream / afterburner idles.
 *               "done"     one-shot climb-out flourish, then the scene
 *                          fades and `onComplete` (if given) is called.
 *   count?      when provided, a quiet "N sessions inbound" line builds
 *               up beneath the primary caption. Omit it and only the
 *               ATC-flavored primary line shows.
 *   onComplete? called once, ~600ms after `phase` becomes "done" (or
 *               almost immediately under reduced motion), when the exit
 *               flourish has played. Safe to omit if the parent instead
 *               relies on the ~600ms CSS transition.
 */
export interface SidebarLoadingProps {
  phase: "loading" | "done";
  count?: number;
  onComplete?: () => void;
}

/** Matches the takeoff timing in SidebarLoading.css (--jl-takeoff-ms). */
const TAKEOFF_MS = 620;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function SidebarLoading({ phase, count, onComplete }: SidebarLoadingProps) {
  const flameGradientId = useId();
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Fire onComplete once, after the climb-out has had time to play.
  useEffect(() => {
    if (phase !== "done") return;
    const delay = prefersReducedMotion() ? 60 : TAKEOFF_MS;
    const timer = window.setTimeout(() => onCompleteRef.current?.(), delay);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const caption =
    phase === "done" ? "Cleared for takeoff" : "Clearing the tower…";

  return (
    <div className="jl" data-phase={phase} role="status" aria-live="polite">
      <div className="jl__viewport" aria-hidden="true">
        <div className="jl__ground">
          <div className="jl__stripes" />
        </div>

        <div className="jl__jet">
          <div className="jl__craft">
            <svg viewBox="0 0 24 24" width="100%" height="100%">
              <defs>
                <linearGradient
                  id={flameGradientId}
                  x1="12"
                  y1="16"
                  x2="12"
                  y2="23"
                  gradientUnits="userSpaceOnUse"
                >
                  {/* Hottest at the nozzle, cooling to the tip — same ramp
                      as JetIcon.tsx, sourced from the --jl-flame-* vars. */}
                  <stop offset="0%" stopColor="var(--jl-flame-hot)" />
                  <stop offset="100%" stopColor="var(--jl-flame-warm)" />
                </linearGradient>
              </defs>

              {/* Afterburner, drawn first so the hull sits over the nozzle. */}
              <path
                className="jl__flame"
                d="M9.6 16.4 L14.4 16.4 L12 23 Z"
                fill={`url(#${flameGradientId})`}
              />

              {/* Delta-wing dart (logo.svg geometry) + its accent tail. */}
              <path className="jl__dart" d="M12 1.6 L21.2 17.1 L12 13.3 L2.8 17.1 Z" />
              <path className="jl__tail" d="M9.3 18.6 L14.7 18.6 L14 20 L10 20 Z" />
            </svg>
          </div>
        </div>
      </div>

      <p className="jl__caption">
        {caption}
        {typeof count === "number" && phase !== "done" && (
          <>
            <br />
            <span className="jl__count">
              <CountUp value={count} /> {count === 1 ? "session" : "sessions"} inbound
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/** Small count-up flourish for the optional session tally; snaps to the
 *  final value immediately under reduced motion. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(() =>
    prefersReducedMotion() ? value : 0,
  );

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    if (value <= 0) {
      setShown(value);
      return;
    }
    const durationMs = Math.min(600, 120 + value * 40);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out-quart to settle onto the final count.
      const eased = 1 - Math.pow(1 - t, 4);
      setShown(Math.round(eased * value));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{shown}</>;
}
