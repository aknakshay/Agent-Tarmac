import { useEffect, useState } from "react";
import { JetMark } from "./jetMark";
import "./SidebarLoading.css";

/**
 * Sidebar loading state — the launch continued. This is the SAME dart from
 * SplashScreen, now shown still climbing inside the narrow session column
 * while the background session scan finishes: it ascends with the runway
 * centerline and thin cloud wisps streaming down past it and the
 * afterburner lit, looping. Splash = takeoff; this = still ascending while
 * sessions come aboard.
 *
 * Shape is tuned for the ~280px sidebar column: one prominent jet, quiet
 * ATC-flavored microcopy, an optional session tally.
 *
 * Prop contract:
 *
 *   phase   "loading"  jet climbs and the sky streams, on a loop.
 *           "done"     a quick settle — the climb steadies and the caption
 *                      resolves. (No unmount signal; the parent swaps this
 *                      out for the real list when it's ready.)
 *   count?  optional. When given, an "N sessions" tally builds up beneath
 *           the caption (count-up flourish; snaps to final under reduced
 *           motion).
 *
 * Motion is transform/opacity only; a `prefers-reduced-motion` resting
 * frame (static climbing jet, still sky, no flame flicker) lives in
 * SidebarLoading.css.
 */
export interface SidebarLoadingProps {
  phase: "loading" | "done";
  count?: number;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function SidebarLoading({ phase, count }: SidebarLoadingProps) {
  const caption = phase === "done" ? "Wheels up" : "Climbing out…";

  return (
    <div className="jls" data-phase={phase} role="status" aria-live="polite">
      <div className="jls__sky" aria-hidden="true">
        <div className="jls__stripes" />
        <span className="jls__wisp jls__wisp--a" />
        <span className="jls__wisp jls__wisp--b" />
        <span className="jls__wisp jls__wisp--c" />

        <div className="jls__jet">
          <JetMark className="jls__mark" />
        </div>
      </div>

      <p className="jls__caption">
        {caption}
        {typeof count === "number" && (
          <span className="jls__count">
            <CountUp value={count} /> {count === 1 ? "session" : "sessions"}{" "}
            {phase === "done" ? "aboard" : "inbound"}
          </span>
        )}
      </p>
    </div>
  );
}

/** Small count-up flourish for the session tally; snaps to the final value
 *  immediately under reduced motion. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(() =>
    prefersReducedMotion() ? value : 0,
  );

  useEffect(() => {
    if (prefersReducedMotion() || value <= 0) {
      setShown(value);
      return;
    }
    const durationMs = Math.min(600, 120 + value * 40);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 4); // ease-out-quart
      setShown(Math.round(eased * value));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{shown}</>;
}
