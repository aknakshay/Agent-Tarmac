# Agent Tarmac — project instructions

Mission control for coding agents. Tauri 2 (Rust) + React/TS/Tailwind + xterm.js. macOS full support; Linux compiles (CI-checked, runtime untested — issue #13). Repo: github.com/aknakshay/Agent-Tarmac.

## Gates (all must be green before any commit)

```sh
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"   # node + cargo aren't on the default PATH
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
npx vitest run && npx tsc --noEmit && npm run build
```

## Dev loop (never spend real Claude tokens in tests)

```sh
export AGENT_TARMAC_PROJECTS_DIR="$PWD/src-tauri/tests/fixtures/projects"
export AGENT_TARMAC_CLAUDE_BIN="$PWD/scripts/fake-claude.sh"
npm run tauri dev
```

## Hard rules

- **Never write into `~/.claude`** — read-only territory. App state lives in the workspace store (app data dir) or localStorage.
- **Two processes must never share a session** — every resume/pop-out/bring-back path guards this (spawn no-op guard, poll_until_stopped, ExternalSessions tracking). Don't weaken it.
- Session ids entering any shell/AppleScript path go through `validate_session_id` ([A-Za-z0-9_-] allowlist). Terminal.app/iTerm strings are double-escaped (shell layer inside AppleScript layer) — see pop_out.rs comments before touching.
- Locks are poison-tolerant (`unwrap_or_else(|e| e.into_inner())`); never hold a lock across `app.emit` or blocking I/O.
- Frontend listeners use the StrictMode-safe promise-cleanup pattern (see App.tsx).
- Workspace read-modify-writes go through the serialized queue in `src/lib/workspaceMeta.ts` — never raw get/set_workspace pairs.
- Pure logic gets table tests (activity.rs, should_notify, tarmacDefenseEngine.ts are the pattern).
- UI work loads the `impeccable` + `ui-ux-pro-max` skills first; design tokens live in src/index.css (OKLCH, dark-first). Status color language: green=working, amber=needsYou (+solid/hollow shape distinction for color-blind safety), blue=unread.

## Release ritual

Bump version in **three** files (src-tauri/Cargo.toml, src-tauri/tauri.conf.json, package.json) → full gates → `npm run tauri build` → commit bump (Cargo.lock updates too) → push → `gh release create vX.Y.Z <dmg> --title ... --notes ...` → the in-app update checker (update_check.rs, checks GitHub releases 10s after launch + every 24h) notifies users. Sign builds with the local "Agent Tarmac Dev Signing" identity (APPLE_SIGNING_IDENTITY env) so macOS TCC grants persist across updates.

## Process

- Subagent-per-task with review between tasks built this app; keep per-task reviews for non-trivial changes.
- Marketing/launch playbook lives at `~/Dev/agent-tarmac-marketing.md` — NEVER commit it to this public repo. Same for PRODUCT.md (gitignored).
- The fixture generator for dense-fleet demos/GIFs: scratchpad `gen_fixtures.py` pattern — generate into a temp dir, never into src-tauri/tests/fixtures (other tests own those).
