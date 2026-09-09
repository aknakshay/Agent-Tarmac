import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { JetIcon } from "./JetIcon";
import { JetMark } from "./jetMark";
import "./HelpPanel.css";

interface HelpPanelProps {
  onClose(): void;
}

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: "⌘K", description: "Jump to a session" },
  { keys: "⌘N", description: "New session" },
  { keys: "⌘0", description: "Home" },
  { keys: "⌘1–9", description: "Nth open session" },
  { keys: "⌘⇧U", description: "Toggle unread" },
  { keys: "⌘ + / −", description: "Zoom terminal" },
  { keys: "⌘/", description: "Open this help" },
];

const CAPABILITIES: Array<{ icon: React.ReactNode; title: string; body: string }> = [
  {
    icon: <GridIcon />,
    title: "Every session, one window",
    body: "Claude Code and Codex — each with its own pilot — even sessions you started in another terminal.",
  },
  {
    icon: <BellIcon />,
    title: "Know who needs you",
    body: "A live status on each session, with a badge for the one that's blocked on you.",
  },
  {
    icon: <EjectIcon />,
    title: "Pop out anytime",
    body: "Eject a session to Ghostty, iTerm2, or Terminal — it keeps tracking it.",
  },
  {
    icon: <RestoreIcon />,
    title: "Survive reboots",
    body: "After a restart, Restore brings every running session back in one click.",
  },
];

const LEGEND: Array<{ status: "working" | "needsYou" | "idle" | "dormant"; label: string }> = [
  { status: "working", label: "Working" },
  { status: "needsYou", label: "Needs you" },
  { status: "idle", label: "Idle" },
  { status: "dormant", label: "Dormant" },
];

/**
 * First-run welcome + reference card. Opens once on first launch and anytime
 * via ⌘/ or the sidebar ? button. Leans on the app's launch-splash language (a
 * JetMark on a tarmac gradient with a receding runway line) so the first thing
 * a new user sees after takeoff feels continuous. Esc / backdrop / the Get
 * started button all dismiss.
 */
export function HelpPanel({ onClose }: HelpPanelProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Capture phase + stopPropagation so Esc closes the panel even while a
        // terminal pane has focus (xterm would otherwise eat the keydown first).
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [onClose]);

  const openLink = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    openUrl(url).catch((err) => console.error("Failed to open link", err));
  };

  return (
    <div
      className="help-overlay fixed inset-0 z-40 flex items-start justify-center bg-black/60 pt-[8vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Agent Tarmac"
        className="help-card z-50 flex max-h-[84vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl ring-1 ring-black/20"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero */}
        <div className="help-hero shrink-0 px-6 pt-7 pb-6 text-center">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted"
          >
            <CloseIcon />
          </button>
          <div className="relative z-10 mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-app-bg/60 shadow-lg">
            <JetMark className="h-8 w-8" />
          </div>
          <p className="relative z-10 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
            Welcome aboard
          </p>
          <h2 className="relative z-10 mt-1 text-lg font-semibold text-ink">Agent Tarmac</h2>
          <p className="relative z-10 mt-0.5 text-sm text-ink-muted">
            Mission control for your coding agents.
          </p>
        </div>

        {/* Body */}
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-3">
            {CAPABILITIES.map((cap) => (
              <div key={cap.title} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-hover text-ink-muted">
                  {cap.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{cap.title}</p>
                  <p className="text-xs leading-relaxed text-ink-faint">{cap.body}</p>
                </div>
              </div>
            ))}
          </div>

          <Divider />

          <div>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              Status at a glance
            </h3>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {LEGEND.map((row) => (
                <span key={row.status} className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <JetIcon status={row.status} className="h-3 w-3" />
                  {row.label}
                </span>
              ))}
            </div>
          </div>

          <Divider />

          <div>
            <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              Keyboard shortcuts
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {SHORTCUTS.map((row) => (
                <div key={row.keys} className="flex items-center gap-2">
                  <kbd className="keycap">{row.keys}</kbd>
                  <span className="min-w-0 truncate text-xs text-ink-muted">{row.description}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-6 py-3.5">
          <div className="flex items-center gap-2.5 text-xs text-ink-faint">
            <a
              href="https://github.com/aknakshay/Agent-Tarmac"
              onClick={openLink("https://github.com/aknakshay/Agent-Tarmac")}
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink-muted"
            >
              GitHub
            </a>
            <span aria-hidden="true">·</span>
            <a
              href="https://github.com/aknakshay/Agent-Tarmac/issues"
              onClick={openLink("https://github.com/aknakshay/Agent-Tarmac/issues")}
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-ink-muted"
            >
              Report an issue
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-app-bg transition-opacity hover:opacity-90"
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <div className="my-4 h-px bg-border" />;
}

function GridIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth={1.5} aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 fill-none stroke-current"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7a4 4 0 0 1 8 0c0 3 1 4 1 4H3s1-1 1-4Z" />
      <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

function EjectIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 fill-none stroke-current"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 10H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v2" />
      <path d="M9 7l4-4M13 3v3.5M13 3H9.5" />
      <path d="M8 13H5" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 fill-none stroke-current"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8a5 5 0 1 1 1.6 3.7" />
      <path d="M3 12.5V9.5H6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 fill-none stroke-current"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
