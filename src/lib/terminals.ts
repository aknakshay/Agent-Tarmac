/** Display names for the terminal keys the backend's `detect_terminals`
 * command can return. The backend deals only in keys; this map is the single
 * place that knows what to print on buttons and menus. */
export const TERMINAL_LABELS: Record<string, string> = {
  ghostty: "Ghostty",
  iterm: "iTerm2",
  wezterm: "WezTerm",
  kitty: "kitty",
  alacritty: "Alacritty",
  terminal: "Terminal",
};

export function terminalLabel(key: string): string {
  return TERMINAL_LABELS[key] ?? key;
}

/** The terminal a bare pop-out click should use: the first detected one
 * (backend returns them in preference order, Terminal.app always last). */
export function defaultTerminal(available: string[]): string {
  return available[0] ?? "terminal";
}
