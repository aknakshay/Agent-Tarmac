<p align="center">
  <img src="assets/brand/wordmark.svg" alt="Agent Tarmac" width="280" />
</p>

<p align="center">
  Mission control for your coding agents.
</p>

<p align="center">
  <a href="https://github.com/aknakshay/Agent-Tarmac/releases/latest"><img src="https://img.shields.io/github/v/release/aknakshay/Agent-Tarmac?label=download&color=2ea44f" alt="Latest release" /></a>
  <a href="https://github.com/aknakshay/Agent-Tarmac/actions/workflows/ci.yml"><img src="https://github.com/aknakshay/Agent-Tarmac/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
</p>

<p align="center">
  <b><a href="https://github.com/aknakshay/Agent-Tarmac/releases/latest">⬇&nbsp;&nbsp;Download for macOS</a></b> &nbsp;·&nbsp; Apple&nbsp;Silicon &nbsp;·&nbsp; free &amp; open source
</p>

Running many coding agents in parallel — often 20+ [Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex](https://openai.com/codex/) sessions spread across terminal windows — makes them impossible to track: no way to see which ones need you, no single place to resume or stop them, and every reboot feels risky. Agent Tarmac is a single-window macOS app that turns every session on your machine into a live dashboard: each one ever run, from any terminal, browsable and resumable, with per-session status so you can glance at twenty sessions and know which one is holding short for a decision.

It's agent-agnostic by design — it manages **Claude Code and Codex** today, with Gemini planned (see [Roadmap](#roadmap)) — and it only ever *reads* your local session transcripts, so it never spends your Claude or API usage.

![Agent Tarmac — activity-aware sidebar and embedded terminal, switching between sessions](assets/brand/hero.gif)

## Features

- **Dashboard over every session** — not a walled garden of app-created sessions. Any `claude --resume`-able or `codex resume`-able session shows up, regardless of where it was started.
- **Claude Code *and* Codex** — both agents in one cockpit, side by side, with a per-backend badge. ChatGPT-app Codex sessions are hidden by default and one toggle away.
- **Embedded terminals** — interact with live sessions inside the app, sidebar + terminal pane, like a chat client.
- **Activity-aware sidebar** — per-session status (`Working` / `NeedsYou` / `Idle` / `Dormant`), with badges and optional macOS notifications for the one thing you actually need to know: which session is blocked on you.
- **Token stats you can flex** — a live tally of every token your agents have burned across all sessions, plus a shareable "tokenmaxxing" card. Counted from your transcripts — Agent Tarmac never spends a token of its own.
- **Restore workspace** — after a reboot, one click respawns everything that was running.
- **Pop out to a real terminal** — eject any session to your terminal of choice (Ghostty, iTerm2, Terminal…); Agent Tarmac keeps tracking it via transcript watching.
- **Stop** — a graceful `SIGTERM` to a session's process group, no orphaned processes.

## Install

**[⬇ Download the latest release](https://github.com/aknakshay/Agent-Tarmac/releases/latest)** — grab the `.dmg` (Apple Silicon), open it, and drag Agent Tarmac to Applications.

> **First launch:** the app isn't notarized yet, so macOS won't open it on a double-click. Right-click it in Applications → **Open** → **Open** — once. After that it launches normally. (Notarized builds and one-click auto-update are on the [roadmap](#roadmap).)

You'll want the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`) and/or [Codex](https://openai.com/codex/) on your `PATH` — Agent Tarmac drives them; it checks for `claude` and tells you if it's missing.

### Build from source

For development, or an Intel Mac / Linux:

```sh
git clone https://github.com/aknakshay/Agent-Tarmac.git
cd agent-tarmac
npm install
npm run tauri build   # bundle lands in src-tauri/target/release/bundle/macos/
npm run tauri dev     # or run the dev build
```

## Development

### Dev loop with a fake `claude`

`scripts/fake-claude.sh` is a stand-in for the real CLI — it starts, prompts, and echoes stdin without touching a real Claude Code session, so you can develop and test the whole app loop without spending real agent turns:

```sh
export AGENT_TARMAC_PROJECTS_DIR="$PWD/src-tauri/tests/fixtures/projects"
export AGENT_TARMAC_CLAUDE_BIN="$PWD/scripts/fake-claude.sh"
npm run tauri dev
```

`AGENT_TARMAC_PROJECTS_DIR` points the session index at a fixture directory instead of the real `~/.claude/projects`; `AGENT_TARMAC_CLAUDE_BIN` swaps in the fake binary everywhere the app would otherwise spawn `claude`. Both env vars are read once at startup by the Rust backend (`session_index.rs`, `pty_manager.rs`).

### Tests

```sh
npm test               # vitest — frontend store, workspace metadata
cd src-tauri && cargo test   # Rust — PTY manager, activity state machine, session index
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full checklist before opening a PR.

## How it compares

|  | Agent Tarmac | [FleetCode](https://github.com/built-by-as/FleetCode) | [opcode](https://github.com/winfunc/opcode) | claude-terminal / cc-pane | agent-session-manager |
|---|---|---|---|---|---|
| Sessions started outside the app | ✅ any session in `~/.claude/projects` | ❌ app-created only | ❌ chat GUI, not a terminal cockpit | ❌ layout manager only | ✅ |
| Live activity status (Working/NeedsYou/etc.) | ✅ | ❌ | ❌ | ❌ | ➖ unclear |
| Embedded terminal | ✅ | ✅ | ❌ | ✅ | ✅ |
| Restore workspace after reboot | ✅ | ➖ persistence, not one-click restore | ❌ | ❌ | ➖ unclear |
| Pop out to a real terminal, keep tracking | ✅ | ❌ | ❌ | ❌ | ❌ |
| Platform | macOS (full support) · Linux (compiles, runtime untested — contributions welcome, see [#13](https://github.com/aknakshay/Agent-Tarmac/issues/13)) | Node/Electron | macOS/Linux/Windows (Tauri) | macOS (Tauri) | Linux only (GTK4) |

FleetCode is the closest competitor — multi-session embedded terminals with `--resume` persistence and git-worktree isolation — but it only manages sessions it created, is Claude-only, and has no activity status. Agent Tarmac is mission control for every session on the machine — Claude Code *and* Codex — with live status, regardless of what started it.

## Known limitations

- None currently blocking. Popped-out sessions now survive app restarts: the external set is persisted and reconciled against still-running processes at startup (v0.2.0). Found something? [Open an issue](https://github.com/aknakshay/Agent-Tarmac/issues).

## Roadmap

Tracked as GitHub issues:

- **Next up: notarized builds + signed auto-update** — no more right-click-to-open, and one-click in-place updates (the in-app check currently notifies and links to the GitHub release page)
- Gemini backend support (Claude Code and Codex ship today)
- Git-worktree isolation per session
- tmux backend (alternative to the native PTY manager)
- Tier-3 hooks integration
- Settings pane (notification toggle, clear-metadata action)
- Web/mobile remote access
- Linux runtime support (compiles + CI-checked today; see [#13](https://github.com/aknakshay/Agent-Tarmac/issues/13)) and Windows support
- Persist which session tabs were open across a restart (which panes were open, not just which were live) and reopen them without auto-resuming dormant ones

## Privacy

Agent Tarmac reads your local session transcripts and nothing leaves your machine — with one small, opt-out exception. On launch it makes a single anonymous request to a [tiny counter endpoint](telemetry/) that tells the maintainer how many people are running the app (the GitHub download badge only sees `.dmg` downloads, not source builds). That request contains only a **random install id the app generates locally**, the app **version**, and the **OS** — no account, no machine or user identifier, no file paths, no session content. The same request doubles as the update check.

Don't want even that? Set `AGENT_TARMAC_NO_TELEMETRY=1` and the app checks for updates against GitHub directly and sends nothing. (In source builds telemetry is off entirely unless a maintainer has configured an endpoint.)

## License

[MIT](LICENSE)
