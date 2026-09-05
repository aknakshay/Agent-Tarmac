import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  /** Set once `term.open()` has been called for this session's pane. */
  opened: boolean;
}

const registry = new Map<string, TerminalEntry>();

/** Reads a design token from `:root` (Tailwind `@theme` custom property). */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildTheme() {
  const background = token("--color-app-bg");
  const foreground = token("--color-ink");
  return {
    background,
    foreground,
    cursor: token("--color-accent"),
    cursorAccent: background,
    selectionBackground: token("--color-surface-hover"),
    black: "#1e1e1e",
    red: "#e06c75",
    green: token("--color-working") || "#98c379",
    yellow: token("--color-needs-you") || "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  };
}

/** UTF-8 safe string -> base64, matching the byte encoding the Rust side expects. */
function toBase64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** base64 -> raw bytes, for writing PTY output straight into the terminal. */
export function fromBase64(dataB64: string): Uint8Array {
  const binary = atob(dataB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Returns the terminal for a session, creating it on first access. The
 * instance (and its scrollback) lives for the app's lifetime, independent of
 * whether the pane is currently mounted/visible.
 */
export function getOrCreateTerminal(id: string): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const term = new Terminal({
    scrollback: 10000,
    theme: buildTheme(),
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    cursorBlink: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  // Attached once per terminal (not per pane mount) so remounting a pane
  // never double-writes to write_stdin.
  term.onData((data) => {
    invoke("write_stdin", { sessionId: id, dataB64: toBase64(data) }).catch((err) => {
      console.error(`write_stdin failed for session ${id}`, err);
    });
  });

  const entry: TerminalEntry = { term, fit, opened: false };
  registry.set(id, entry);
  return entry;
}

/**
 * Opens the terminal into `container` the first time a pane mounts for this
 * session. Safe to call on every mount; a no-op after the first call.
 */
export function ensureOpened(id: string, container: HTMLDivElement): TerminalEntry {
  const entry = getOrCreateTerminal(id);
  if (entry.opened) return entry;

  entry.term.open(container);
  entry.opened = true;

  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
    });
    entry.term.loadAddon(webgl);
  } catch (err) {
    console.warn(`WebGL addon unavailable for session ${id}, falling back to canvas renderer`, err);
  }

  return entry;
}

/** Routes a `pty_output` event to the right terminal, if it exists. */
export function writeOutput(sessionId: string, dataB64: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.term.write(fromBase64(dataB64));
}

/** Routes a `pty_exited` event to the right terminal, if it exists. */
export function writeExited(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.term.write("\r\n\x1b[2m[session exited]\x1b[0m\r\n");
}

/** Writes a dim, non-PTY informational line into a session's terminal. */
export function writeInfoLine(sessionId: string, text: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.term.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
}
