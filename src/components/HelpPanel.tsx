import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { JetIcon } from "./JetIcon";

interface HelpPanelProps {
  onClose(): void;
}

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: "⌘K", description: "Jump to / search sessions" },
  { keys: "⌘N", description: "New session" },
  { keys: "⌘0", description: "Home" },
  { keys: "⌘1–9", description: "Jump to the Nth open session" },
  { keys: "⌘⇧U", description: "Toggle unread on the active session" },
  { keys: "⌘/", description: "Open this help anytime" },
];

const JUMP_BAR_SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: "↑ / ↓", description: "Move selection" },
  { keys: "Enter", description: "Open" },
  { keys: "Esc", description: "Close" },
];

/**
 * Reference-card modal explaining the app: what it does, the status legend,
 * what you can do, and the keyboard shortcuts. Mirrors CommandBar's overlay
 * + centered card pattern, but doesn't need list navigation, so Esc/backdrop
 * click/close-button are the only interactions.
 */
export function HelpPanel({ onClose }: HelpPanelProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const openLink = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    openUrl(url).catch((err) => console.error("Failed to open link", err));
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[10vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        className="z-50 max-h-[78vh] w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Agent Tarmac</h2>
            <p className="text-xs text-ink-faint">Mission control for your coding agents.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-surface-hover hover:text-ink-muted"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="thin-scrollbar max-h-[calc(78vh-52px)] overflow-y-auto px-4 py-4 text-sm text-ink-muted">
          <Section title="The idea">
            <p>
              The sidebar lists every Claude Code and Codex session on your machine — even ones you
              started in another terminal — grouped by project. The status dot on each tells you
              which one needs you.
            </p>
          </Section>

          <Section title="Status legend">
            <ul className="space-y-1.5">
              <LegendRow status="working" label="Working" description="Actively running." />
              <LegendRow
                status="needsYou"
                label="Needs you"
                description="Blocked on you — shows a badge + optional notification."
              />
              <LegendRow status="idle" label="Idle" description="Finished, no input required." />
              <LegendRow status="dormant" label="Dormant" description="Hasn't run in a while." />
            </ul>
          </Section>

          <Section title="What you can do">
            <ul className="list-disc space-y-1 pl-4">
              <li>Click a session to open its terminal right in the app.</li>
              <li>Start a new one with ⌘N.</li>
              <li>Pop a session out to a real terminal (Ghostty/iTerm2/Terminal) and it keeps tracking it.</li>
              <li>After a reboot, Restore brings everything back.</li>
              <li>See your all-time token usage on Home.</li>
            </ul>
          </Section>

          <Section title="Keyboard shortcuts">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {SHORTCUTS.map((row) => (
                  <ShortcutRow key={row.keys} {...row} />
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ink-faint">Inside the jump bar:</p>
            <table className="w-full border-collapse text-xs">
              <tbody>
                {JUMP_BAR_SHORTCUTS.map((row) => (
                  <ShortcutRow key={row.keys} {...row} />
                ))}
              </tbody>
            </table>
          </Section>

          <div className="mt-4 flex items-center gap-3 border-t border-border pt-3 text-xs text-ink-faint">
            <a
              href="https://github.com/aknakshay/Agent-Tarmac"
              onClick={openLink("https://github.com/aknakshay/Agent-Tarmac")}
              target="_blank"
              rel="noreferrer"
              className="hover:text-ink-muted"
            >
              GitHub repo
            </a>
            <span aria-hidden="true">·</span>
            <a
              href="https://github.com/aknakshay/Agent-Tarmac/issues"
              onClick={openLink("https://github.com/aknakshay/Agent-Tarmac/issues")}
              target="_blank"
              rel="noreferrer"
              className="hover:text-ink-muted"
            >
              Report an issue
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}

function LegendRow({
  status,
  label,
  description,
}: {
  status: "working" | "needsYou" | "idle" | "dormant";
  label: string;
  description: string;
}) {
  return (
    <li className="flex items-start gap-2">
      <JetIcon status={status} className="mt-0.5 h-3 w-3" />
      <span>
        <span className="font-medium text-ink">{label}</span>
        <span className="text-ink-faint"> — {description}</span>
      </span>
    </li>
  );
}

function ShortcutRow({ keys, description }: { keys: string; description: string }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="w-24 py-1.5 pr-3 align-top">
        <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-ink-faint">{keys}</kbd>
      </td>
      <td className="py-1.5 text-ink-muted">{description}</td>
    </tr>
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
