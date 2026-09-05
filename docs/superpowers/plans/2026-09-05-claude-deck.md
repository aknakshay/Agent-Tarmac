# Claude Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-window macOS Tauri app that lists every Claude Code session on disk, embeds live terminals for them, shows per-session activity status, and can stop/resume/restore sessions.

**Architecture:** Rust core (Tauri 2) owns state: transcript parsing + file-watching (`SessionIndex`), PTY spawning (`PtyManager` streaming output via Tauri events), a pure status state machine (`ActivityMonitor`), and an app-owned `WorkspaceStore` JSON. React frontend (sidebar + xterm.js panes) is purely visual, talking over a small set of Tauri commands/events.

**Tech Stack:** Tauri 2, Rust (portable-pty 0.8, notify 6, serde_json, chrono, base64), React 18 + TypeScript + Vite, Tailwind CSS, shadcn/ui, zustand, @xterm/xterm + fit + webgl addons.

**Spec:** `docs/superpowers/specs/2026-09-05-claude-deck-design.md` (read it first; this plan implements it).

## Global Constraints

- The app NEVER writes into `~/.claude` (spec §4). No exceptions in this plan (the opt-in hook install, spec §5 Tier 3, is deliberately **post-v1** and not in this plan).
- All filesystem paths to Claude data go through one function (`claude_projects_dir()`), overridable via env var `CLAUDE_DECK_PROJECTS_DIR` so tests use fixtures.
- Rust: `cargo fmt` + `cargo clippy -- -D warnings` clean at every commit.
- Frontend tasks (8–12) MUST begin by loading the `ui-ux-pro-max` and `impeccable` skills before writing any UI code (spec §6). Dark-first UI.
- Never spawn the real `claude` binary in tests; use the fake script from Task 6 or `echo`/`sh`.
- License MIT. Commit after every green test cycle, message style `feat:`/`fix:`/`test:`/`chore:`.
- macOS is the only supported target for v1; don't add cfg branches for other platforms.

---

### Task 1: Scaffold Tauri 2 + React + Tailwind repo

**Files:**
- Create: entire scaffold at repo root `~/Dev/claude-deck` (already a git repo with `docs/`)
- Create: `LICENSE` (MIT, copyright "Claude Deck contributors"), `.gitignore`

**Interfaces:**
- Produces: a building Tauri app; `src-tauri/src/lib.rs` with a `run()` that later tasks register commands into; Vite dev server on 1420.

- [ ] **Step 1: Scaffold**

```bash
cd ~/Dev/claude-deck
npm create tauri-app@latest . -- --template react-ts --manager npm --yes
npm install
npm install -D tailwindcss @tailwindcss/vite
npm install zustand @xterm/xterm @xterm/addon-fit @xterm/addon-webgl
```

If `npm create tauri-app` refuses a non-empty dir, scaffold into `/tmp/cd-scaffold` and move everything except `docs/` and `.git/` into the repo root.

Add to `vite.config.ts` plugins: `tailwindcss()` from `@tailwindcss/vite`. Replace `src/App.css`/`index.css` content with a single `src/index.css` containing `@import "tailwindcss";`.

- [ ] **Step 2: Rust deps**

In `src-tauri/Cargo.toml` add:

```toml
[dependencies]
portable-pty = "0.8"
notify = "6"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", features = ["serde"] }
base64 = "0.22"
dirs = "5"
```

- [ ] **Step 3: Verify it builds and runs**

Run: `cargo check` in `src-tauri/`, then `npm run tauri dev` briefly (window opens, then Ctrl-C). Run `cargo test` (0 tests, passes).

- [ ] **Step 4: Identity + license**

Set `productName: "Claude Deck"`, `identifier: "dev.claudedeck.app"` in `src-tauri/tauri.conf.json`. Write MIT `LICENSE`. Ensure `.gitignore` covers `node_modules/`, `dist/`, `src-tauri/target/`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold Tauri 2 + React + Tailwind app"
```

---

### Task 2: Transcript parser (`transcript.rs`)

**Files:**
- Create: `src-tauri/src/transcript.rs`, register `mod transcript;` in `lib.rs`
- Create: `src-tauri/tests/fixtures/projects/-Users-me-proj-a/11111111-1111-1111-1111-111111111111.jsonl`
- Test: inline `#[cfg(test)]` module in `transcript.rs`

**Interfaces:**
- Produces: `pub struct SessionMeta { pub id: String, pub cwd: Option<String>, pub title: String, pub last_activity: chrono::DateTime<chrono::Utc>, pub last_role: Option<String> }` and `pub fn parse_transcript(path: &Path) -> Option<SessionMeta>`. Task 3 consumes both.

Claude Code transcripts are JSONL. Relevant line shapes (parse defensively with `serde_json::Value` — real files contain many other types and occasional garbage):

```json
{"type":"summary","summary":"Fix events cold start","leafUuid":"..."}
{"type":"user","cwd":"/Users/me/proj-a","sessionId":"1111...","timestamp":"2026-09-05T10:00:00Z","message":{"role":"user","content":"hello"}}
{"type":"assistant","timestamp":"2026-09-05T10:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}
```

- [ ] **Step 1: Write fixture + failing tests**

Fixture file content (exactly the 3 lines above plus one garbage line `not json` between lines 2 and 3).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/projects/-Users-me-proj-a/11111111-1111-1111-1111-111111111111.jsonl")
    }

    #[test]
    fn parses_id_cwd_title_and_last_role() {
        let m = parse_transcript(&fixture()).unwrap();
        assert_eq!(m.id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(m.cwd.as_deref(), Some("/Users/me/proj-a"));
        assert_eq!(m.title, "Fix events cold start"); // summary wins over first user msg
        assert_eq!(m.last_role.as_deref(), Some("assistant"));
        assert_eq!(m.last_activity.to_rfc3339(), "2026-09-05T10:00:05+00:00");
    }

    #[test]
    fn missing_file_returns_none() {
        assert!(parse_transcript(std::path::Path::new("/nope/x.jsonl")).is_none());
    }

    #[test]
    fn falls_back_to_first_user_text_when_no_summary() {
        // second fixture: same dir, id 2222...jsonl, only the user+assistant lines
        let p = fixture().parent().unwrap().join("22222222-2222-2222-2222-222222222222.jsonl");
        let m = parse_transcript(&p).unwrap();
        assert_eq!(m.title, "hello");
    }
}
```

Create the second fixture too (user line + assistant line only, no summary).

- [ ] **Step 2: Run to verify failure** — `cargo test` in `src-tauri/`: FAIL (unresolved `parse_transcript`).

- [ ] **Step 3: Implement**

```rust
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionMeta {
    pub id: String,
    pub cwd: Option<String>,
    pub title: String,
    pub last_activity: DateTime<Utc>,
    pub last_role: Option<String>,
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn extract_user_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    match content {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(items) => items.iter().find_map(|i| {
            (i.get("type")?.as_str()? == "text").then(|| i.get("text")?.as_str().map(String::from))?
        }),
        _ => None,
    }
}

pub fn parse_transcript(path: &Path) -> Option<SessionMeta> {
    let id = path.file_stem()?.to_str()?.to_string();
    let content = std::fs::read_to_string(path).ok()?;
    let (mut cwd, mut summary, mut first_user, mut last_ts, mut last_role) =
        (None, None, None, None, None);
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(|c| c.as_str()).map(String::from);
        }
        match v.get("type").and_then(|t| t.as_str()) {
            Some("summary") => {
                summary = v.get("summary").and_then(|s| s.as_str()).map(String::from)
            }
            Some(t @ ("user" | "assistant")) => {
                last_role = Some(t.to_string());
                if t == "user" && first_user.is_none() {
                    first_user = extract_user_text(&v);
                }
            }
            _ => {}
        }
        if let Some(ts) = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(|t| t.parse::<DateTime<Utc>>().ok())
        {
            last_ts = Some(ts);
        }
    }
    let mtime: DateTime<Utc> = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(Into::into)
        .unwrap_or_else(Utc::now);
    let title = summary.or(first_user).unwrap_or_else(|| id.clone());
    Some(SessionMeta {
        id,
        cwd,
        title: truncate(&title, 80),
        last_activity: last_ts.unwrap_or(mtime),
        last_role,
    })
}
```

- [ ] **Step 4: Run tests** — `cargo test`: 3 PASS. `cargo clippy -- -D warnings` clean.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: transcript parser with fixture tests"`

---

### Task 3: SessionIndex — scan + watch `~/.claude/projects`

**Files:**
- Create: `src-tauri/src/session_index.rs`, register in `lib.rs`
- Test: inline `#[cfg(test)]` using the Task 2 fixture tree

**Interfaces:**
- Consumes: `transcript::parse_transcript`, `transcript::SessionMeta`
- Produces:
  - `pub fn claude_projects_dir() -> PathBuf` (env `CLAUDE_DECK_PROJECTS_DIR` override, else `dirs::home_dir()/.claude/projects`)
  - `pub fn scan(dir: &Path) -> Vec<SessionMeta>` (all `*.jsonl`, sorted by `last_activity` desc)
  - `pub fn start_watcher(app: tauri::AppHandle)` — notify watcher (recursive, 500ms debounce via collecting events) that re-scans and emits Tauri event `"sessions_updated"` with payload `Vec<SessionMeta>`; also stores latest scan in a `tauri::State<SessionIndexState>` (`pub struct SessionIndexState(pub Mutex<Vec<SessionMeta>>)`)
  - Tauri command `#[tauri::command] pub fn list_sessions(state: State<SessionIndexState>) -> Vec<SessionMeta>`

- [ ] **Step 1: Failing tests for `scan`**

```rust
#[test]
fn scan_finds_both_fixture_sessions_sorted_desc() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/projects");
    let all = scan(&dir);
    assert_eq!(all.len(), 2);
    assert!(all[0].last_activity >= all[1].last_activity);
}

#[test]
fn scan_of_missing_dir_is_empty() {
    assert!(scan(Path::new("/nope")).is_empty());
}
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement `scan`** with `walkdir`-free manual recursion (`fs::read_dir` two levels: project dirs → `.jsonl` files), filter extension, map through `parse_transcript`, sort by `last_activity` desc. **Step 4: Run** — PASS.

- [ ] **Step 5: Implement watcher + command (no unit test; covered by E2E later)**

`start_watcher` spawns a thread: `notify::recommended_watcher` on `claude_projects_dir()` (if it exists), on any event drain further events for 500ms (`std::sync::mpsc::Receiver::recv_timeout`), then `scan` + update state + `app.emit("sessions_updated", &sessions)`. Register in `lib.rs`:

```rust
.manage(session_index::SessionIndexState(Mutex::new(session_index::scan(&session_index::claude_projects_dir()))))
.invoke_handler(tauri::generate_handler![session_index::list_sessions])
.setup(|app| { session_index::start_watcher(app.handle().clone()); Ok(()) })
```

- [ ] **Step 6: Verify** — `cargo test` PASS, `cargo clippy -- -D warnings` clean, `npm run tauri dev` launches without panic.

- [ ] **Step 7: Commit** — `git commit -am "feat: session index with fs watcher and list_sessions command"`

---

### Task 4: WorkspaceStore

**Files:**
- Create: `src-tauri/src/workspace_store.rs`, register in `lib.rs`
- Test: inline, using `tempfile` (add `tempfile = "3"` to `[dev-dependencies]`)

**Interfaces:**
- Produces:
  - `#[derive(Default, Serialize, Deserialize, Clone, PartialEq, Debug)] pub struct Workspace { pub live_session_ids: Vec<String>, pub open_session_ids: Vec<String>, pub favorites: Vec<String> }`
  - `pub fn load(path: &Path) -> Workspace` (missing/corrupt file → `Workspace::default()`)
  - `pub fn save(path: &Path, ws: &Workspace) -> std::io::Result<()>` (create parent dirs, write pretty JSON atomically: write `.tmp` then rename)
  - Commands `get_workspace` / `set_workspace(ws: Workspace)` using `tauri::State<WorkspaceState>` (`Mutex<Workspace>`) + path from `app.path().app_data_dir()?.join("workspace.json")`

- [ ] **Step 1: Failing tests**

```rust
#[test]
fn roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("ws.json");
    let ws = Workspace { live_session_ids: vec!["a".into()], open_session_ids: vec![], favorites: vec!["b".into()] };
    save(&p, &ws).unwrap();
    assert_eq!(load(&p), ws);
}

#[test]
fn corrupt_file_loads_default() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("ws.json");
    std::fs::write(&p, "{{{").unwrap();
    assert_eq!(load(&p), Workspace::default());
}
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** load/save exactly per interface (atomic rename). **Step 4: Run** — PASS, clippy clean.

- [ ] **Step 5: Wire commands + state into `lib.rs`** (extend `generate_handler!` list; save on every `set_workspace`).

- [ ] **Step 6: Commit** — `git commit -am "feat: workspace store with atomic JSON persistence"`

---

### Task 5: ActivityMonitor state machine (pure logic)

**Files:**
- Create: `src-tauri/src/activity.rs`, register in `lib.rs`
- Test: inline table-driven tests

**Interfaces:**
- Produces:
  - `#[derive(Debug, Clone, Copy, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub enum Status { Working, NeedsYou, Idle, Dormant }`
  - `pub struct StatusInputs { pub running: bool, pub secs_since_activity: u64, pub last_role_assistant: bool, pub prompt_at_tail: bool, pub idle_after_secs: u64 }`
  - `pub fn derive_status(i: &StatusInputs) -> Status`
  - `pub fn tail_looks_like_prompt(tail: &str) -> bool` — true if the stripped tail contains any of: `"Do you want"`, `"❯ 1."`, `"Waiting for your input"`, `"esc to interrupt"` is ABSENT while a `"│ >"` prompt box is present. Keep the pattern list a `const PROMPT_PATTERNS: &[&str]` so it's tweakable.

Decision table (spec §5, Tiers 1–2 unified; `secs_since_activity` = seconds since the most recent of {pty output, transcript append}):

| running | prompt_at_tail | secs_since_activity | last_role_assistant | → Status |
|---|---|---|---|---|
| false | – | – | – | Dormant |
| true | true | – | – | NeedsYou |
| true | false | < 3 | – | Working |
| true | false | 3..idle_after | true | NeedsYou |
| true | false | ≥ idle_after | true | Idle |
| true | false | ≥ 3 | false | Working (tool running quietly) |

- [ ] **Step 1: Failing table test**

```rust
#[test]
fn status_table() {
    let cases: Vec<(StatusInputs, Status)> = vec![
        (StatusInputs { running: false, secs_since_activity: 0, last_role_assistant: false, prompt_at_tail: false, idle_after_secs: 300 }, Status::Dormant),
        (StatusInputs { running: true, secs_since_activity: 100, last_role_assistant: false, prompt_at_tail: true, idle_after_secs: 300 }, Status::NeedsYou),
        (StatusInputs { running: true, secs_since_activity: 1, last_role_assistant: true, prompt_at_tail: false, idle_after_secs: 300 }, Status::Working),
        (StatusInputs { running: true, secs_since_activity: 30, last_role_assistant: true, prompt_at_tail: false, idle_after_secs: 300 }, Status::NeedsYou),
        (StatusInputs { running: true, secs_since_activity: 3000, last_role_assistant: true, prompt_at_tail: false, idle_after_secs: 300 }, Status::Idle),
        (StatusInputs { running: true, secs_since_activity: 30, last_role_assistant: false, prompt_at_tail: false, idle_after_secs: 300 }, Status::Working),
    ];
    for (i, expected) in cases {
        assert_eq!(derive_status(&i), expected, "inputs: {i:?}");
    }
}

#[test]
fn prompt_detection() {
    assert!(tail_looks_like_prompt("blah\nDo you want to make this edit?\n❯ 1. Yes"));
    assert!(!tail_looks_like_prompt("Compiling foo v0.1.0"));
}
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `derive_status` as a direct transcription of the table (match/if-chain in table order). **Step 4: Run** — PASS, clippy clean. **Step 5: Commit** — `git commit -am "feat: activity status state machine with table tests"`

---

### Task 6: PtyManager + fake-claude E2E harness

**Files:**
- Create: `src-tauri/src/pty_manager.rs`, register in `lib.rs`
- Create: `scripts/fake-claude.sh` (`chmod +x`)
- Test: `src-tauri/tests/pty_integration.rs`

**Interfaces:**
- Consumes: nothing from other modules (standalone).
- Produces:
  - `pub struct PtyManager { inner: Mutex<HashMap<String, PtyHandle>> }` managed as `tauri::State`
  - `pub struct SpawnSpec { pub session_id: String, pub cwd: PathBuf, pub program: String, pub args: Vec<String> }`
  - Methods: `spawn(&self, emitter: impl Fn(PtyEvent) + Send + 'static, spec: SpawnSpec) -> Result<(), String>`, `write(&self, session_id: &str, data: &[u8]) -> Result<(), String>`, `resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), String>`, `kill(&self, session_id: &str) -> Result<(), String>` (SIGTERM to child, SIGKILL via `child.kill()` after 5s in a thread), `is_running(&self, session_id: &str) -> bool`, `last_output_tail(&self, session_id: &str) -> String` (rolling 2KB buffer), `secs_since_output(&self, session_id: &str) -> Option<u64>`
  - `pub enum PtyEvent { Output { session_id: String, data_b64: String }, Exited { session_id: String } }`
  - Tauri commands: `resume_session(session_id)` (spawns `claude --resume <id>` with cwd from SessionIndex state; error if no cwd), `start_new_session(cwd: String)` (spawns `claude`, session id = `"new-"+uuid` until the watcher picks up the real one), `stop_session(session_id)`, `write_stdin(session_id, data_b64)`, `resize_pty(session_id, rows, cols)`. Command layer converts `PtyEvent` to `app.emit("pty_output", …)` / `app.emit("pty_exited", …)`. Program name comes from `fn claude_program() -> String` (env `CLAUDE_DECK_CLAUDE_BIN` override, default `"claude"`).

`scripts/fake-claude.sh`:

```bash
#!/bin/sh
echo "fake claude starting session ${2:-none}"
sleep 1
echo "Do you want to continue?"
# stay alive reading stdin; exit on "q"
while read -r line; do
  [ "$line" = "q" ] && echo "bye" && exit 0
  echo "got: $line"
done
```

- [ ] **Step 1: Failing integration test**

```rust
// src-tauri/tests/pty_integration.rs
use claude_deck_lib::pty_manager::{PtyManager, PtyEvent, SpawnSpec};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[test]
fn spawn_stream_write_kill() {
    let mgr = PtyManager::default();
    let events: Arc<Mutex<Vec<PtyEvent>>> = Arc::default();
    let sink = events.clone();
    let script = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-claude.sh");
    mgr.spawn(
        move |e| sink.lock().unwrap().push(e),
        SpawnSpec { session_id: "s1".into(), cwd: std::env::temp_dir(), program: script.to_string_lossy().into(), args: vec!["--resume".into(), "s1".into()] },
    ).unwrap();
    std::thread::sleep(Duration::from_millis(2000));
    assert!(mgr.is_running("s1"));
    assert!(mgr.last_output_tail("s1").contains("Do you want"));
    mgr.write("s1", b"hello\n").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(mgr.last_output_tail("s1").contains("got: hello"));
    mgr.kill("s1").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(!mgr.is_running("s1"));
    assert!(events.lock().unwrap().iter().any(|e| matches!(e, PtyEvent::Output { .. })));
}
```

(Requires `lib.rs` to expose modules publicly: name the lib crate `claude_deck_lib` in `Cargo.toml` `[lib]` and `pub mod pty_manager;` etc.)

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** with `portable_pty::native_pty_system()`, `openpty(PtySize { rows: 30, cols: 100, ..Default::default() })`, `CommandBuilder`, reader thread that loops `read()`, updates tail buffer + `last_output_at: Instant`, base64-encodes chunks, calls the emitter; on EOF emits `Exited` and marks dead. **Step 4: Run** — `cargo test` PASS (all tasks so far), clippy clean. **Step 5: Wire the Tauri commands** into `generate_handler!`. **Step 6: Commit** — `git commit -am "feat: PTY manager with fake-claude integration test"`

---

### Task 7: Status loop — wiring ActivityMonitor to real signals

**Files:**
- Create: `src-tauri/src/status_loop.rs`, register in `lib.rs`
- Modify: `lib.rs` setup to start the loop

**Interfaces:**
- Consumes: `SessionIndexState`, `PtyManager` (via `AppHandle::state`), `activity::{derive_status, tail_looks_like_prompt, Status, StatusInputs}`, `transcript::SessionMeta.last_role`
- Produces: background thread ticking every 2s; for each session in the index computes `StatusInputs`:
  - `running` = `pty_manager.is_running(id)` OR (external pop-out tracking, Task 12: transcript mtime < 15s ago)
  - `secs_since_activity` = min(pty `secs_since_output`, secs since transcript `last_activity`)
  - `prompt_at_tail` = `tail_looks_like_prompt(&pty.last_output_tail(id))`
  - `idle_after_secs` = 300
  - On change from the previous tick's map, `app.emit("session_status_changed", StatusChange { session_id, status })` with `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct StatusChange { pub session_id: String, pub status: Status }`
- No unit tests here (pure plumbing over Task 5's tested logic); verified in Task 11's manual smoke.

- [ ] **Step 1: Implement** the loop exactly as above (a `thread::spawn` in setup; keep a `HashMap<String, Status>` of previous values).
- [ ] **Step 2: Verify** — `cargo clippy -- -D warnings` clean; `npm run tauri dev` runs; with `CLAUDE_DECK_PROJECTS_DIR` pointed at the fixtures dir, log line prints statuses (add a `#[cfg(debug_assertions)] println!` for the smoke check).
- [ ] **Step 3: Commit** — `git commit -am "feat: 2s status loop emitting session_status_changed"`

---

### Task 8: Frontend shell — store, layout, sidebar

**REQUIRED FIRST:** load skills `ui-ux-pro-max` and `impeccable` before writing any code in Tasks 8–12. Dark-first design.

**Files:**
- Create: `src/store.ts`, `src/types.ts`, `src/components/Sidebar.tsx`, `src/components/SessionRow.tsx`, `src/App.tsx` (rewrite scaffold)
- Test: `src/store.test.ts` (add `npm i -D vitest`, script `"test": "vitest run"`)

**Interfaces:**
- Consumes Tauri commands `list_sessions`, events `sessions_updated`, `session_status_changed` (via `@tauri-apps/api/core` `invoke` and `@tauri-apps/api/event` `listen`)
- Produces (Tasks 9–12 rely on these exact names):

```ts
// src/types.ts
export type Status = 'working' | 'needsYou' | 'idle' | 'dormant';
export interface Session {
  id: string;
  cwd: string | null;
  title: string;
  lastActivity: string;   // ISO
  status: Status;
  favorite: boolean;
  badge: boolean;         // finished/needsYou while unfocused
}
```

```ts
// src/store.ts — zustand
interface DeckState {
  sessions: Record<string, Session>;
  openIds: string[];        // sessions with a terminal pane created
  activeId: string | null;
  setSessions(metas: SessionMeta[]): void;      // merge, preserve status/badge
  setStatus(id: string, status: Status): void;  // sets badge=true if needsYou && id!==activeId
  focus(id: string): void;                      // sets activeId, clears badge, adds to openIds
  closePane(id: string): void;
}
export const useDeck = create<DeckState>()(...);
```

Note: Rust `SessionMeta` serializes snake_case (`last_activity`); map it in `setSessions`. Sidebar groups by `cwd` (project), sorts groups by most recent activity, sessions desc within; dormant sessions beyond the 15 most recent hidden behind a "Show history" toggle; favorites pinned in a top group.

- [ ] **Step 1: Failing store tests** (vitest, no Tauri — call the store's actions directly):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useDeck } from './store';

beforeEach(() => useDeck.setState({ sessions: {}, openIds: [], activeId: null }));

it('setStatus on unfocused session sets badge', () => {
  useDeck.getState().setSessions([{ id: 'a', cwd: '/p', title: 't', last_activity: '2026-09-05T10:00:00Z', last_role: 'assistant' }]);
  useDeck.getState().setStatus('a', 'needsYou');
  expect(useDeck.getState().sessions['a'].badge).toBe(true);
});

it('focus clears badge and opens pane', () => {
  useDeck.getState().setSessions([{ id: 'a', cwd: '/p', title: 't', last_activity: '2026-09-05T10:00:00Z', last_role: null }]);
  useDeck.getState().setStatus('a', 'needsYou');
  useDeck.getState().focus('a');
  const s = useDeck.getState();
  expect(s.sessions['a'].badge).toBe(false);
  expect(s.activeId).toBe('a');
  expect(s.openIds).toContain('a');
});
```

- [ ] **Step 2: Run** — `npm test` FAIL. **Step 3: Implement** store, then App layout (left sidebar 280px + main pane placeholder), `Sidebar` with status dots: `working` = pulsing green (`animate-pulse bg-emerald-400`), `needsYou` = solid amber, `idle` = dim, `dormant` = ring only. Wire `invoke('list_sessions')` on mount + both `listen`ers. **Step 4: Run** — `npm test` PASS; `npm run tauri dev` against fixture dir shows grouped sessions. **Step 5: Commit** — `git commit -am "feat: frontend store and activity-aware sidebar"`

---

### Task 9: Terminal pane — xterm.js wiring

**Files:**
- Create: `src/components/TerminalPane.tsx`, `src/terminals.ts`
- Modify: `src/App.tsx` (render panes for `openIds`, show/hide by `activeId`)

**Interfaces:**
- Consumes: commands `resume_session`, `write_stdin`, `resize_pty`, events `pty_output`, `pty_exited`; store `focus/openIds/activeId`
- Produces: `src/terminals.ts` module-level registry `getOrCreateTerminal(id: string): Terminal` — one xterm `Terminal` per session id for the app's lifetime (scrollback survives pane switches, spec §6). `scrollback: 10000`, WebGL addon with canvas fallback (webgl addon `onContextLoss` → dispose addon), FitAddon on container resize via `ResizeObserver`, fit → `invoke('resize_pty', …)`.

Data flow: `pty_output {sessionId, dataB64}` → `atob` → `Uint8Array` → `term.write(bytes)`. `term.onData(d => invoke('write_stdin', { sessionId, dataB64: btoa(d) }))`. Focusing a `dormant` session first calls `invoke('resume_session', { sessionId })`, then opens the pane. All panes stay mounted; inactive ones get `display:none` (xterm keeps buffering).

- [ ] **Step 1: Implement** per above (no meaningful unit test — this is glue over xterm; the fake-claude smoke in Step 2 is the test).
- [ ] **Step 2: Smoke test with fake claude** — run `CLAUDE_DECK_PROJECTS_DIR=src-tauri/tests/fixtures/projects CLAUDE_DECK_CLAUDE_BIN=$PWD/scripts/fake-claude.sh npm run tauri dev`; click fixture session → terminal shows "fake claude starting session", typing echoes `got: …`, status dot goes amber on the "Do you want to continue?" prompt within ~4s. Fix until this works.
- [ ] **Step 3: Commit** — `git commit -am "feat: embedded xterm terminal panes with pty wiring"`

---

### Task 10: Stop, New Session, ⌘K command bar, shortcuts

**Files:**
- Create: `src/components/CommandBar.tsx`, `src/components/NewSessionDialog.tsx`
- Modify: `src/App.tsx`, `src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `stop_session`, `start_new_session`; `@tauri-apps/plugin-dialog` for directory picker (`npm i @tauri-apps/plugin-dialog` + Rust `tauri-plugin-dialog`, register in `lib.rs`)
- Produces: header bar per spec §6 mock — session title · project · Stop button (only when running). ⌘K opens fuzzy search over ALL sessions (match on title + cwd, simple `includes`-based scoring is fine for v1); Enter focuses (resuming if dormant). ⌘1–9 focus the nth of `openIds`. ⌘N opens NewSessionDialog: directory picker + "recent dirs" list (distinct `cwd`s of the 10 most recent sessions) → `start_new_session`.

- [ ] **Step 1: Implement** (keyboard handling via a single `keydown` listener in App; guard `e.metaKey`).
- [ ] **Step 2: Smoke test** — with fake-claude env: ⌘K finds fixture session, ⌘N starts a fake session in a picked dir, Stop kills it (dot → hollow, `pty_exited` received).
- [ ] **Step 3: Commit** — `git commit -am "feat: stop, new session dialog, command bar, shortcuts"`

---

### Task 11: Restore workspace + liveness reconciliation

**Files:**
- Modify: `src-tauri/src/workspace_store.rs` (persist `live_session_ids` whenever PtyManager spawns/kills — do this in the command layer of Task 6's commands), `src/App.tsx`
- Create: `src/components/RestoreBanner.tsx`

**Interfaces:**
- Consumes: `get_workspace`, `set_workspace`, `resume_session`
- Produces: on frontend mount, `get_workspace`; if `live_session_ids` is non-empty and none are currently running (`sessions[id].status === 'dormant'` for all), show banner "Restore workspace (N sessions)" → sequentially `resume_session` each (250ms apart to avoid a spawn stampede) → dismiss. A "Dismiss" button clears `live_session_ids` via `set_workspace`.
- Rust side: `resume_session`/`start_new_session` add the id to `live_session_ids` and save; `stop_session` and `pty_exited` remove it. Since Task 6 predates this, this task modifies those command bodies.

- [ ] **Step 1: Rust test for reconciliation helper**

```rust
#[test]
fn reconcile_removes_dead_ids() {
    let ws = Workspace { live_session_ids: vec!["a".into(), "b".into()], ..Default::default() };
    let running = |id: &str| id == "a";
    assert_eq!(reconcile(&ws, running).live_session_ids, vec!["a".to_string()]);
}
```

`pub fn reconcile(ws: &Workspace, is_running: impl Fn(&str) -> bool) -> Workspace` — called once on startup before the frontend loads (in setup, after PtyManager init: nothing is running yet after a reboot, so ids survive into the banner; the point is defense against stale state when the app restarts while PTYs died).

- [ ] **Step 2: Run** — FAIL → implement → PASS. **Step 3: Frontend banner + wiring.** **Step 4: Smoke** — fake-claude env: start 2 sessions, quit app, relaunch, banner offers 2, restore respawns both. **Step 5: Commit** — `git commit -am "feat: restore workspace after restart"`

---

### Task 12: Pop out to Ghostty + external session tracking

**Files:**
- Create: `src-tauri/src/pop_out.rs`, register in `lib.rs`
- Modify: `src/components/Sidebar.tsx` or header (Pop out button), `src-tauri/src/status_loop.rs`

**Interfaces:**
- Produces: command `pop_out_to_ghostty(session_id: String)`:
  1. `stop_session` semantics first if app owns the PTY (can't have two processes on one session).
  2. Launch: write a temp script `#!/bin/sh\ncd '<cwd>' && exec claude --resume '<id>'` to the app data dir, `chmod +x`, then `Command::new("open").args(["-na", "Ghostty", "--args", "-e", script_path])`. If `open -na Ghostty` fails (Ghostty not installed), fall back to Terminal.app via `osascript -e 'tell app "Terminal" to do script "<cd … && claude --resume …>"'` and return which app was used.
  3. Mark session external: `pub struct ExternalSessions(pub Mutex<HashSet<String>>)` state; status_loop treats `external && transcript mtime < 15s` as `running=true` (spec Tier 1 only), and clears the external flag when mtime goes stale > 10 min.
- [ ] **Step 1: Unit test** the script-content builder (`pub fn pop_out_script(cwd: &str, id: &str) -> String` — assert it contains `cd '` + cwd and `--resume '` + id; quote single-quotes in cwd by `'"'"'` substitution). Run FAIL → implement → PASS.
- [ ] **Step 2: Wire command + button; manual smoke** with real Ghostty and a real dormant session (this one manual test may touch real `claude`; use a throwaway session in `/tmp`).
- [ ] **Step 3: Commit** — `git commit -am "feat: pop out sessions to Ghostty with external tracking"`

---

### Task 13: CI, README, polish pass

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`, `CONTRIBUTING.md`
- Modify: whatever the polish pass touches

**Interfaces:** none (terminal task).

- [ ] **Step 1: CI**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { components: "clippy, rustfmt" }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm test
      - run: cargo fmt --check
        working-directory: src-tauri
      - run: cargo clippy -- -D warnings
        working-directory: src-tauri
      - run: cargo test
        working-directory: src-tauri
      - run: npm run tauri build -- --no-bundle
```

- [ ] **Step 2: README** — what/why (one paragraph from spec §2), screenshot placeholder to be replaced with a real capture, install (build-from-source for now), the fake-claude dev loop env vars, comparison table vs FleetCode/opcode (from spec §2), MIT badge. CONTRIBUTING: run tests, conventional commits, post-v1 issue list (worktrees, Codex, tmux backend, hooks tier, telemetry — file these as GitHub issues when publishing).
- [ ] **Step 3: Polish pass** — re-load `impeccable` + `ui-ux-pro-max`; sweep: empty states (no sessions found → friendly setup hint incl. `claude` not on PATH detection via `claude --version` check command `check_claude() -> Option<String>`), focus rings, reduced motion respect, window min-size 900×600, app icon placeholder.
- [ ] **Step 4: Full verification** — `cargo test && npm test`, fake-claude smoke of the whole loop (list → resume → status → stop → restore), real-`claude` smoke on one throwaway `/tmp` session.
- [ ] **Step 5: Commit** — `git commit -am "chore: CI, README, polish pass"`

---

## Self-review notes (done at write time)

- Spec coverage: §2 features 1–6 → Tasks 3, 9, 5/7/8, 11, 12, 10(stop). §5 Tier 3 hooks intentionally deferred post-v1 (recorded in Global Constraints). §7 edge cases: binary check (Task 13), stale liveness (Task 11), parse errors (Task 2), SIGTERM→SIGKILL (Task 6), backpressure = bounded tail buffer + xterm scrollback cap (Tasks 6/9).
- Naming consistency: `resume_session`/`stop_session`/`write_stdin`/`resize_pty`/`list_sessions`/`get_workspace`/`set_workspace`/`pop_out_to_ghostty` used identically across Tasks 3–12; `Status` serde camelCase matches the TS union.
- Known risk flagged for executors: exact JSONL field names in Task 2 fixtures are modeled on real transcripts, but verify against a real file in `~/.claude/projects` before trusting the parser (adjust fixtures if reality differs — the test structure stands).
