# Claude Deck — Design Spec

**Date:** 2026-09-05
**Status:** Approved design, pre-implementation
**Working name:** Claude Deck (renamed to **Agent Tarmac** before publishing — see Task 13; this doc otherwise stands as the historical design record and isn't updated for the rename elsewhere)
**License / distribution:** MIT, open source on GitHub, macOS-first

## 1. Problem

Running many Claude Code sessions in parallel (often 20+) across Ghostty windows makes them impossible to track: no way to see which sessions need attention, fear of rebooting the laptop, no single place to resume or stop sessions.

Key insight: Claude Code already persists every session transcript to `~/.claude/projects/<encoded-project-dir>/<session-id>.jsonl`, and any session can be revived with `claude --resume <session-id>` from the right directory. Only running *processes* are lost on reboot — never the sessions themselves.

## 2. Product

A single-window macOS desktop app — "mission control for every Claude Code session on the machine":

1. **Dashboard** over `~/.claude/projects` — every session ever run, from any terminal, browsable and resumable. Not a walled garden of app-created sessions.
2. **Embedded terminals** — interact with live sessions inside the app (sidebar + terminal pane, like a chat app).
3. **Activity-aware sidebar** — per-session status: `Working` / `NeedsYou` / `Idle` / `Dormant`, with badges and optional macOS notifications. The differentiator: glance and know which of 20 sessions needs you.
4. **Restore workspace** — after reboot, one click respawns everything that was live via `--resume`.
5. **Pop out to Ghostty** — eject any session to a real terminal; the app keeps tracking it via transcript watching.
6. **Stop** — graceful SIGTERM to a session's process group.

### Prior art (researched 2026-09-05)

- **opcode** (22.4k★, Tauri 2): chat-style GUI + agent toolkit, not an embedded-terminal cockpit, no activity status.
- **FleetCode** (424★, TS/Node): closest competitor — multi-session embedded terminals, `--resume` persistence, git-worktree isolation. Manages only sessions it created; no activity status; no external-terminal interop.
- **claude-terminal**, **cc-pane** (Tauri): terminal grid/split layout managers, no session-history intelligence.
- **agent-session-manager** (GTK4): near-identical concept but Linux-only.

Positioning: *FleetCode is a launcher for sessions it owns; Claude Deck is mission control for every Claude session on the machine, with live status.*

### Out of scope for v1 (post-v1 GitHub issues)

Git-worktree isolation per session, Codex/other-agent support, tmux backend, token/cost telemetry, web/mobile remote access, Linux/Windows testing.

## 3. Architecture

**Stack:** Tauri 2 (Rust backend) + React + TypeScript + Tailwind + shadcn/ui + xterm.js (WebGL renderer) + `portable-pty`.

### Rust core (owns all state)

- **`SessionIndex`** — scans and file-watches `~/.claude/projects/**/*.jsonl`; builds the catalog (project path decoded from dir name, session UUID from filename, title/summary from transcript, last activity from mtime/last entry, model). Sessions started outside the app appear automatically.
- **`PtyManager`** — spawns `claude --resume <id>` (or new sessions) on PTYs via `portable-pty`; one PTY per live session; streams output to frontend via Tauri events; handles stdin, resize, kill. Implemented behind a `SessionBackend` trait so a tmux backend can be added post-v1 without touching callers.
- **`ActivityMonitor`** — derives per-session status (see §5). A state machine; the subtlest logic in the app.
- **`WorkspaceStore`** — app-owned JSON (in app data dir): which sessions were live, open tabs, favorites, tags, layout. Never writes into `~/.claude`.

### Frontend (owns all visuals)

Sidebar (grouped session list + status), terminal pane (xterm.js per open session, kept alive off-screen when switched), ⌘K command bar, restore banner, new-session dialog.

### Interface between layers

Tauri commands: `list_sessions`, `start_session`, `resume_session`, `stop_session`, `write_stdin`, `resize_pty`, `pop_out_to_ghostty`, `get_workspace`, `set_workspace`.
Tauri events: `pty_output(session_id, bytes)`, `session_status_changed(session_id, status)`, `sessions_updated`.

## 4. Session Model

```
Session {
  id: Uuid,             // from .jsonl filename
  project_path: PathBuf,// decoded from projects dir name
  title: String,        // summary line from transcript
  last_activity: Timestamp,
  status: Working | NeedsYou | Idle | Dormant,  // Dormant = not running, resumable
  liveness: Option<{ pid, pty_id, external: bool }>,
  favorite: bool, tags: Vec<String>,  // WorkspaceStore metadata, keyed by id
}
```

**Invariant: the app never writes into `~/.claude`** — read-only territory. Single consented exception: opt-in hook install (§5 Tier 3), reversible from app settings.

## 5. Activity Detection (three tiers)

- **Tier 1 — transcript watching** (every session, including external/Ghostty ones): `.jsonl` growing → `Working`; quiet with last record a completed assistant turn → `NeedsYou`; decays to `Idle` after a configurable timeout. ~80% of the value, uses the watcher SessionIndex already has.
- **Tier 2 — PTY stream heuristics** (app-owned only): output flowing → `Working`; quiet + tail matches known prompt patterns ("Do you want to…", input box) → `NeedsYou`; BEL character → immediate `NeedsYou` + macOS notification.
- **Tier 3 — hooks (opt-in, exact)**: first-run offer to add `Stop`/`Notification` hook entries to `~/.claude/settings.json` that write one line (`session_id`, `event`) to a unix socket the app listens on. Tiers 1–2 remain the fallback when declined.

Badges: transition to `NeedsYou` while unfocused → sidebar badge + optional macOS notification; clears on focus.

## 6. UI

Single window, **dark-first**, shadcn/ui. **The UI implementation MUST be built with the `ui-ux-pro-max` and `impeccable` design skills loaded by the implementing agents — no freestyle styling.** UI quality is an explicit product goal, not an afterthought.

```
┌────────────┬──────────────────────────────┐
│  ⌘K search │  session title · project · ⋮ │
│────────────│                              │
│ ▾ project-a│                              │
│  ● working │      xterm.js terminal       │
│  ◐ needs-u │      (WebGL renderer)        │
│  ○ dormant │                              │
│────────────│                              │
│ [Restore ▸]│  [Pop out to Ghostty] [Stop] │
└────────────┴──────────────────────────────┘
```

- Sidebar: grouped by project, collapsible; status dots (pulsing green `Working`, solid orange `NeedsYou` + badge, dim `Idle`, hollow `Dormant`); favorites pinned; "history" toggle reveals older dormant sessions (default recent-only).
- Terminal pane: one xterm.js per opened session, never destroyed on switch (scrollback survives); hidden renderers paused, data still buffered; scrollback capped ~10k lines.
- Shortcuts: ⌘1–9 switch open sessions, ⌘K fuzzy-find anything (dormant hit → resume), ⌘N new session (directory picker, recent dirs first).
- Launch: if last workspace had live sessions → banner **Restore workspace (n sessions)** → respawns all via `--resume`.
- Pop out: `claude --resume <id>` in a new Ghostty window (`open -a Ghostty` / `ghostty` CLI); session marked `external`, still tracked via Tier 1.

## 7. Error Handling & Edge Cases

- `claude` binary missing / version drift: detect on launch (`claude --version`), setup screen not crash; `--resume` behavior version-checked once.
- Stale liveness after app crash: reconcile WorkspaceStore against real processes on launch (pid + start-time to defeat pid reuse); non-running → `Dormant`, feeds Restore banner.
- Resume failure (deleted project dir, corrupt transcript): show real stderr in the terminal pane, keep session listed, no retry loop.
- Transcript parse errors: skip bad `.jsonl` lines, never fatal; index degrades to filename + mtime.
- Stop: SIGTERM to process group, SIGKILL after 5s. Transcript checkpointing means worst case loses only the in-flight response.
- Load: PTY reads backpressured in Rust; a session dumping megabytes of output must not freeze the UI.

## 8. Testing

- Rust: unit tests on fixture `~/.claude/projects` trees (parsing, status derivation, reconciliation); table-driven tests for the `ActivityMonitor` state machine.
- Frontend: Vitest for stores/logic; xterm.js internals not our test surface, wiring is.
- E2E smoke: fake `claude` shell script (prints, sleeps, prompts) exercises spawn → status transitions → stop in CI with no API cost.

## 9. Repo & Process

- MIT license, GitHub Actions: fmt + clippy + Rust tests + Vitest + macOS build. Linux/Windows CI compiled but flagged untested.
- README with hero screenshot, CONTRIBUTING.md.
- **Build process:** all code written by Sonnet subagents; Fable designs, reviews, certifies. UI phases load `ui-ux-pro-max` + `impeccable` skills.
