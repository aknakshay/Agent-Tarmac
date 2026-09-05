# Agent Tarmac — design-element kit

Companion spec for the brand identity in this directory (`logo.svg`, `wordmark.svg`, `icon-1024.png`). For Task 13's polish pass: what to reuse, and where the ATC vocabulary can carry into copy.

## a. Runway centerline divider

The dashed centerline stripe from the mark, used flat and un-perspective as a horizontal rule.

- Section dividers: a short dashed line (2–3 segments, 4px gap) in `--color-border`, optionally `--color-accent` at low opacity for a divider that separates two *live* sections (e.g. between an active session group and a queued one).
- Empty-state ground line: the same stripe, wider, sitting under an illustration — see `empty-state.svg` for the receding version.
- Don't use it as a side-stripe accent on cards or list rows (that reads as a scrollbar/status bar, not a runway, and the shared design conventions already ban side-stripe borders as a card accent).

## b. "On approach" empty state

`empty-state.svg` — a radar sweep centered on a ground station, with the dart shown small and distant on the centerline above it. Reads as "something is inbound," which fits Claude Deck's empty state better than a static "nothing here" illustration, since a fresh session is usually one keystroke away.

Usage notes:

- The sweep wedge is decorative motion cued in a still frame; if this becomes a live component, animate the wedge rotating slowly (8–12s per revolution, `prefers-reduced-motion` swaps it for a static half-opacity wedge) rather than looping the whole illustration.
- Swap the three hardcoded colors (`#282b33` arcs, `#3a4150` stripe, `#a1a5ac` dart, `#6ba5fb` beacon/sweep) for the matching CSS custom properties (`--color-border`, `--color-ink-faint`, `--color-ink-muted`, `--color-accent`) once it's a real component and can inherit the cascade.
- For a *populated but empty-filtered* state (e.g. "no sessions match this filter"), don't reuse this illustration; it should read as "nothing is happening," not "results filtered out." Use the divider motif with plain copy instead.

## c. Status-dot language (beacon lights)

Claude Deck already has a status-dot vocabulary in the palette (`--color-working` green, `--color-needs-you` amber). Naming them against the brand metaphor, for copy and for anyone building a legend/tooltip:

| Token | Metaphor | UI meaning |
|---|---|---|
| `--color-working` | **taxi light** — green, steady, aircraft is moving under its own power | session is actively running |
| `--color-needs-you` | **beacon light** — amber, the universal "hold, something needs a decision" signal on an aircraft | session is blocked on user input |
| (idle / no dot) | **parked, engines off** | session exists but nothing pending |
| accent-colored ring around a dot | **runway lights, active frequency** | session currently focused/selected in the UI |

Keep the metaphor to two colors (green/amber) plus neutral. Don't add a third semantic color without a matching real-world beacon (red is tempting for "error," but reserve it — a red light on a real tarmac means stop/obstruction, which is a much stronger claim than "this session crashed").

## d. Accent usage and ATC vocabulary (options, not copy changes)

Recommended color-to-meaning mapping, extending the beacon-light table above:

- **Amber (`--color-needs-you`) = hold short.** It's already the "needs a decision" color; "hold short" is the literal ATC instruction for "stop and wait for clearance," which maps exactly to a session blocked on user input. Lean into it for tooltip copy, not just the dot.
- **Green (`--color-working`) = wheels up / cleared for takeoff.** Active, in motion, under its own power.
- **Blue (`--color-accent`) = tower / ground control.** Neutral, structural, the app's own chrome and selection state, not a session-status color, so it stays a safe default for anything that isn't a beacon.

ATC-flavored copy options for Task 13 to pick from (pick a consistent register, don't mix all of these into one screen):

| UI moment | Literal / generic | ATC option |
|---|---|---|
| Session actively running | "Running" | "Wheels up" / "On the roll" |
| Session blocked, needs input | "Needs attention" | "Holding short" / "Requesting clearance" |
| Session queued, not yet started | "Queued" | "Taxiing" / "On the ramp" |
| Session finished cleanly | "Done" | "Cleared to gate" |
| Session crashed / errored | "Failed" | "Go-around" (a failed approach that circles back — implies retry, not dead-end, which is the right connotation for a crash you can rerun) |
| New session about to start | "Starting…" | "On approach" |
| Empty state, no sessions | "No sessions" | "Tower's clear" / "Nothing on the board" |

Use ATC phrasing for short, glanceable UI strings (status labels, empty states, tooltips) where the metaphor adds personality without adding a decoding step. Don't push it into anything load-bearing or unfamiliar to a non-aviation reader (error message bodies, onboarding copy that needs to be immediately literal) — a screen that's ATC-flavored *and* the reader's first contact with the app should still say what actually happened in plain language, with the callsign as flavor, not as the only signal.

## Files in this kit

- `logo.svg` — primary mark, `currentColor` + accent-variant custom property
- `wordmark.svg` — mark + wordmark lockup
- `icon-1024.png` (+ `icon-source-1024.svg`) — macOS app icon source, colors baked in for standalone rasterization
- `empty-state.svg` — the "on approach" illustration described in (b)
- `previews/` — rendered PNGs of the above for quick visual reference
