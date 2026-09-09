# Git Changes — "what did this agent do?" (v1 spec)

## Goal
For **any** session, show the files it changed in its `cwd` and the per-file diff,
read-only, refreshed the moment the agent stops. This is the "the agent says it's
done — what did it actually change?" moment, and it works for every session on the
machine (not just app-created worktrees) — our differentiator vs. Conductor/Crystal,
which own the worktree and center on a review→merge→PR flow.

## Non-goals (v1)
Staging/commit/merge/PR, worktree creation, and strict per-session attribution.
Those are v2 (see bottom).

## Decision: use the `git` CLI (shell-out), NOT the `git2` crate
**Yes — we use `git`.** Rationale:
- Zero new heavy dependency; matches Agent Tarmac's existing "spawn the real CLI"
  model (PTYs, `claude`, `codex`).
- Exact parity with the user's own git — config, aliases, `.gitignore`, `includeIf`,
  submodules, hooks-free read commands — no libgit2 behavioral drift.
- `git diff` text feeds `@git-diff-view/react` directly.
- Requires `git` on PATH (a given for this audience). Non-git `cwd` → clean empty state.
- `git2` stays a v2 option if/when we need structured ops (staging, worktrees).

## Backend — `src-tauri/src/git.rs`
All commands **async + `spawn_blocking`** (never block the main thread — same lesson
as the token_stats freeze). Always invoke as `git -C <cwd> …` with argument arrays
(no shell interpolation of paths).

- `git_changes(cwd) -> Option<ChangeSet>`
  - `git -C <cwd> rev-parse --show-toplevel` → `None` if not a repo (drives empty state).
  - `git -C <cwd> status --porcelain=v2 --branch -z` → branch, ahead/behind, and each
    file's staged/worktree status + untracked.
  - `git -C <cwd> diff --numstat -z` and `--cached --numstat -z` → +/− per file.
  - Returns `{ repo_root, branch, ahead, behind, files: [{ path, status, staged,
    additions, deletions, binary }], total_add, total_del }`.
- `git_file_diff(cwd, path, staged) -> FileDiff`
  - Tracked: `git -C <cwd> diff [--cached] -- <path>` (unified).
  - Untracked: `git -C <cwd> diff --no-index -- /dev/null <path>` (renders as all-adds).
  - **Cap output** (~2 MB); over the cap → return a "diff too large" marker, not the bytes.
  - Detect binary (numstat `-`/`-`) → return a `binary` marker, skip the text.

## Frontend
- Add dep **`@git-diff-view/react`** (GitHub-style, unified/split, syntax highlight,
  word-level, handles large diffs) + its CSS.
- New `ChangesPanel`: left = changed-file list (path, status dot reusing our tokens,
  ± counts); right = `DiffView` fed the `git diff` string. **Unified default, split
  toggle.** Per-file diff loaded **on demand** when a file is selected.
- Session view: a segmented **Terminal | Changes** toggle in the pane header
  (`TerminalPane`), so it never competes with the terminal for space.
- Empty/edge states: not-a-repo; clean (no changes); loading skeleton; binary/large
  file placeholder.

## Live updates
- Refresh on: panel open, a manual refresh button, and **auto when the active
  session's status flips to `idle`/`needsYou`** (we already emit
  `session_status_changed` from `status_loop` — that's the "agent just stopped" signal).
- Debounce; only ever act on the **active** session (don't fan out to 300 cwds).
- Defer a `notify` fs-watch on the cwd to v2 (noisy: `.git/`, `node_modules`, builds).

## Edge cases to handle
- Multiple sessions sharing a `cwd` → both show the same repo state (documented; v2
  attribution fixes it).
- No commits yet (diff vs empty tree), detached HEAD, renames (`R`), a file both
  staged and modified (show both), submodules (single entry), `cwd` deleted → empty state.

## Performance
`status`/`numstat` are O(changes) and cheap; per-file diff is on-demand and capped;
everything on `spawn_blocking`; no polling loop.

## v2+ (later)
- Stage / unstage / commit (and discard-file) from the panel.
- **"Changes since this session started"**: snapshot the base commit + dirty state when
  we attach, diff against now → true per-session attribution.
- Only if we choose to compete head-on with Conductor: a merge flow.

## Open product decisions (need your call)
1. **Layout:** Terminal⇄Changes *toggle* (rec for v1) vs. a persistent *split* pane.
2. **Auto-refresh on idle** on by default (rec) vs. manual-refresh-only to start.
3. **Scope:** show staged + unstaged grouped together (rec) vs. working-tree only.
