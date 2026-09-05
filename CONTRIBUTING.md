# Contributing to Agent Tarmac

## Setup

```sh
npm install
```

Rust toolchain (stable, with `clippy` and `rustfmt` components) is required for `src-tauri`; install via [rustup](https://rustup.rs) if you don't have it.

## Running tests

```sh
npm test                        # frontend: vitest
cd src-tauri && cargo test      # backend: Rust unit + integration tests
```

Before opening a PR, also run what CI runs:

```sh
cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cd ..
npm run tauri build -- --no-bundle
```

For interactive development without spending real Claude Code turns, use the fake-`claude` dev loop described in [README.md](README.md#dev-loop-with-a-fake-claude).

## Commit style

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, ...). Keep commits scoped to one logical change — a rename and a bug fix are two commits, not one.

## Post-v1 backlog

These are deliberately out of scope for v1 and will be filed as GitHub issues once this repo is public:

- Git-worktree isolation per session
- Codex / Gemini backend support (beyond Claude Code)
- tmux backend
- Tier-3 hooks integration
- Token/cost telemetry
- Signed auto-update
- Settings pane (notification toggle, clear-metadata action)
- Web/mobile remote access
- Linux/Windows support
- Persist which session tabs were open across a restart and reopen them without auto-resuming dormant ones (the `open_session_ids` field was in `Workspace` but never wired up — dropped for v1 rather than shipped half-implemented; see Task 13 review)

If you want to pick one of these up, open an issue first to discuss the approach — several depend on the `SessionBackend` trait boundary landing cleanly.
