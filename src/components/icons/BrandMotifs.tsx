/**
 * Agent Tarmac brand motifs, ported from assets/brand/ (see motifs.md) into
 * themeable React components. Colors here use the app's CSS custom
 * properties (--color-*) instead of the hardcoded standalone-preview
 * palette in the source SVGs, so they inherit dark/light theming.
 */

/** The dart-over-runway mark, sized for inline use next to a wordmark. */
export function Logo({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="Agent Tarmac"
      className={className}
    >
      <path d="M12 1.6 L21.2 17.1 L12 13.3 L2.8 17.1 Z" fill="currentColor" />
      <path d="M8.6 19.6 L15.4 19.6 L14.7 21 L9.3 21 Z" fill="var(--color-accent)" />
    </svg>
  );
}

/**
 * Runway-centerline divider: a short dashed rule for separating live UI
 * sections (e.g. an active session group from a queued one). Not for use
 * as a card side-stripe accent — see motifs.md (a).
 */
export function RunwayDivider({ className = "" }: { className?: string }) {
  return (
    <div
      role="separator"
      aria-hidden="true"
      className={`h-px w-full bg-[repeating-linear-gradient(90deg,var(--color-border)_0,var(--color-border)_4px,transparent_4px,transparent_8px)] ${className}`}
    />
  );
}

/**
 * "On approach" empty-state illustration: a radar sweep over the ground
 * station with the dart shown small and distant on the centerline above
 * it. Used for "no sessions yet" / "nothing selected" panes, per
 * motifs.md (b) — not for a populated-but-filtered empty state.
 */
export function OnApproachIllustration({ className = "h-32 w-48" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 160"
      fill="none"
      role="img"
      aria-label="On approach, no active sessions"
      className={className}
    >
      <defs>
        <radialGradient id="tarmac-sweep" cx="50%" cy="100%" r="75%">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
          <stop offset="70%" stopColor="var(--color-accent)" stopOpacity="0.05" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g stroke="var(--color-border)" strokeWidth="1" fill="none">
        <circle cx="120" cy="150" r="40" />
        <circle cx="120" cy="150" r="72" />
        <circle cx="120" cy="150" r="104" />
      </g>

      <path d="M120 150 L120 46 A104 104 0 0 1 210 100 Z" fill="url(#tarmac-sweep)" />

      <g fill="var(--color-ink-faint)">
        <path d="M117.5 132 L122.5 132 L124.5 142 L115.5 142 Z" />
        <path d="M114.5 146 L125.5 146 L128.5 156 L111.5 156 Z" />
      </g>

      <path d="M120 70 L131 96 L120 91 L109 96 Z" fill="var(--color-ink-muted)" />

      <circle cx="120" cy="150" r="3" fill="var(--color-accent)" />
    </svg>
  );
}
