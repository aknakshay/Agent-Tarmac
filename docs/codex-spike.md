# Spike: OpenAI Codex CLI as a second session backend

Investigation only — no feature code written. Verdict, per-seam map, and effort
estimate below.

## TL;DR

- **Codex CLI installed on this machine?** No binary (`which codex` fails), but a
  **real, populated `~/.codex/sessions/` rollout store exists** (252 rollout
  JSONL files, Feb–Sep 2026), written by the ChatGPT Desktop app's bundled
  codex (`cli_version` 0.145–0.153, `originator: "Codex Desktop"`). So we have
  genuine on-disk format evidence, just not a runnable `codex resume` to smoke
  test.
- **Verdict: GO WITH CAVEATS.** Every one of the 6 Claude-welded seams has a
  clean Codex analog and none is architecturally blocking. The cost is real but
  bounded: a format-adapter rewrite per seam, plus one genuinely unknown
  (resume-id semantics, untestable here without the binary).
- **Effort estimate: ~5 agent-tasks** (trait extraction, codex transcript
  parser, codex backend wiring, token-stats adapter, activity/prompt tuning +
  UI badge). See the estimate section.
- **Biggest risk:** the `codex resume <id>` identity + interactive-resume
  behavior is unverifiable on this machine (no binary) and the rollout schema we
  observed is the *Desktop-bundled* codex, which may drift from the standalone
  public CLI a user would install. Everything downstream keys off getting that
  one command right.

---

## 1. Codex on-disk format (observed on this machine)

All findings below are **observed** from real files unless tagged *(docs)*.

### Storage layout — date-sharded, NOT project-sharded

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl
e.g. ~/.codex/sessions/2026/09/06/rollout-2026-09-06T14-47-26-01a076f9-…c5975d2b.jsonl
```

This is the single most important structural difference from Claude. Claude
shards by **encoded cwd**: `~/.claude/projects/<-Users-me-proj>/<uuid>.jsonl`, so
the cwd is recoverable from the *directory name*. Codex shards by **date** and
puts cwd *inside the file* (`session_meta.payload.cwd`). Discovery must be a
recursive walk; cwd must come from file content.

### Record envelope

Every line is `{"timestamp", "type", "payload"}`. Observed `type` values in one
86-line session:

| type                 | count | role in a Codex session |
|----------------------|-------|-------------------------|
| `session_meta`       | 1 (first line) | id, cwd, cli_version, git, model_provider |
| `response_item`      | 23    | the actual turns (message/reasoning) |
| `event_msg`          | 47    | high-level UI events (see activity) |
| `token_usage_record` | 7     | per-response token usage |
| `turn_context`       | 7     | model, cwd, sandbox/approval policy per turn |
| `world_state`        | 1     | workspace snapshot |

### session_meta (first line) — real example (keys)

```json
{"timestamp":"2026-09-06T13:47:26.848Z","type":"session_meta","payload":{
  "session_id":"019faaa6-2856-7300-87e3-80a90eacc69d",
  "id":"01a076f9-5475-7e22-8d0a-218ce5975d2b",
  "cwd":"/Users/akshaynagpal/Documents/New project",
  "originator":"Codex Desktop","cli_version":"0.153.4",
  "timestamp":"2026-09-06T13:47:26.755Z","git":{…},"model_provider":"openai"}}
```

Note the **two ids**: `id` (matches the filename uuid) and `session_id` (a
different, stable-across-resume uuid). Which one `codex resume` wants is the
crux unknown (see risks).

### A turn (response_item) — real example

```json
{"type":"response_item","payload":{
  "type":"message","role":"user",
  "content":[{"type":"input_text","text":"…"}]}}
```
- roles observed: `user`, `assistant`, `developer`; plus `type:"reasoning"` items (role null).
- assistant content uses `output_text`, user uses `input_text`.
- **first user message is polluted** with an injected `AGENTS.md` block and an
  `<environment_context>…<cwd>…</cwd></environment_context>` block — a title
  deriver must strip these.

### event_msg — the activity goldmine

Observed subtypes: `task_started`, `task_complete`, `user_message`,
`agent_message`, `agent_reasoning`, `token_count`, `thread_settings_applied`.
Unlike Claude (where "is it working / waiting" must be screen-scraped from the
PTY tail), Codex writes **explicit `task_started` / `task_complete` markers**
into the JSONL. Activity state can be derived from the transcript far more
robustly than for Claude.

### token_usage_record — real example

```json
{"type":"token_usage_record","payload":{
  "usage":{"input_tokens":27848,"cached_input_tokens":4864,
    "cache_write_input_tokens":0,"output_tokens":210,
    "reasoning_output_tokens":142,"total_tokens":28058},
  "turn_token_usage":{…same shape…},
  "thread_token_usage":{…cumulative…}}}
```
Field mapping vs Claude:
- `input_tokens` / `output_tokens` — same names ✅
- Claude's `cache_read_input_tokens` → Codex `cached_input_tokens` (rename)
- Codex adds `reasoning_output_tokens`, `cache_write_input_tokens`.
- **Double-count trap:** `usage` is per-response, `thread_token_usage` is
  cumulative. Summing the wrong one across records double counts. Use the
  per-response `usage`.

### Resume command *(docs — binary not installed here to verify)*

`codex resume <session>` (interactive picker with no arg), `codex resume --last`,
and `codex exec resume --last` for non-interactive. Interactive `codex resume
<id>` is the direct analog of `claude --resume <id>`. When resuming you cannot
re-specify model/effort — settings are retained.
Sources: [DeepWiki resume/review](https://deepwiki.com/openai/codex/4.2.2-resume-and-review-commands),
[Codex CLI cheat sheet](https://computingforgeeks.com/codex-cli-cheat-sheet/),
[openai/codex #1076](https://github.com/openai/codex/discussions/1076).

---

## 2. Per-seam map (6 seams)

Current state: **no `SessionBackend` trait exists** — grep for
`trait|backend|Backend` in `src-tauri/src/` returns nothing. All six seams are
inline free functions/Tauri commands hard-keyed to Claude. (The design spec
`docs/superpowers/specs/2026-09-05-claude-deck-design.md:45` *claims* PtyManager
is "implemented behind a `SessionBackend` trait" — that was never built.)

| # | Seam (file) | What's Claude-specific | Codex equivalent (evidence) | Difficulty |
|---|-------------|------------------------|------------------------------|------------|
| 1 | **Discovery** `session_index.rs` | Two-level scan `~/.claude/projects/<cwd>/*.jsonl`; cwd from dir name; `notify` recursive watch | Recursive walk `~/.codex/sessions/**/rollout-*.jsonl`; cwd from `session_meta.payload.cwd`. Watcher pattern reusable as-is | **Moderate** — different topology + recursive walk; the watcher/cache/sort logic is reusable |
| 2 | **Parse** `transcript.rs` | Flat records: top-level `type`,`cwd`,`message`,`timestamp`; `summary` record → title; `user`/`assistant` for last_role | Payload envelope; cwd+id from first `session_meta`; **no summary record** → title from first `user_message` (strip AGENTS.md/env blocks); last_role from `response_item.payload.role` or `event_msg` | **Moderate** — full parser rewrite, same `SessionMeta` output shape |
| 3 | **Spawn** `pty_manager.rs` | `resume_session` hardcodes `program: claude_program()`, `args: ["--resume", id]` | `program: codex_program()`, `args: ["resume", id]` — **subcommand not `--flag`**. PTY/kill/tail/resize all backend-agnostic | **Trivial** to change the two lines; needs a per-session backend tag on `SpawnSpec` so resume picks the right program+args |
| 4 | **Binary resolve** `claude_bin.rs` | `const BIN_NAME="claude"`; well-known dirs; login-shell env probe | Near-clone with `BIN_NAME="codex"`. Login-shell env logic (`pty_env_overrides`, `login_shell_env`) is 100% reusable | **Trivial–Moderate** — parameterize `BIN_NAME` (currently a module const baked into `resolve_claude_program`/`claude_program`) |
| 5 | **Activity** `activity.rs` | `PROMPT_PATTERNS = ["Do you want","❯ 1.","Waiting for your input"]` (Claude TUI screen-scrape) | Codex TUI prompt strings differ (unknown without running it) — needs its own patterns. **Bonus:** `task_started`/`task_complete` in JSONL give a more robust signal. `derive_status` table itself is backend-agnostic | **Moderate** — the unknown is tuning the new prompt strings; the state machine is reusable |
| 6 | **Token usage** `token_stats.rs` | Selects `type=="assistant"`, reads `message.usage.{input,output,cache_read_input_tokens}` | Select `type=="token_usage_record"`, read `payload.usage.{input_tokens,output_tokens,cached_input_tokens}`; per-response not cumulative | **Moderate** — rewrite `usage_from_record`+`record_timestamp` for the envelope; watch the cumulative-vs-delta double-count trap |

None are **hard** and none are **blocking**. Two lean on an unknown (resume-id
semantics; Codex prompt strings) that only running the binary resolves.

---

## 3. Trait-extraction assessment

- **Exists today:** nothing. Zero traits; six inline Claude implementations.
- **The refactor:** extract a `SessionBackend` trait with roughly:
  `projects_root()`, `scan()/parse_transcript() -> SessionMeta`,
  `resume_argv(id) -> (program, args)`, `resolve_binary()`,
  `usage_from_record()`, `prompt_patterns()`. Then a `Claude` and a `Codex`
  impl, dispatched by a per-session `backend` enum stored alongside cwd in
  `SessionMeta` / `SpawnSpec` / `WorkspaceState`.
- **Cost:** moderate. The files are small and clean (session_index 106,
  transcript 116, activity 182, token_stats 208, pty_manager 439, claude_bin
  515 lines) with good test coverage (fixtures + unit tests per seam), so the
  extraction is mechanical and each converted seam keeps its existing tests as a
  regression net. The frontend also needs a `backend` field threaded through
  (session list, badge). The one genuinely new surface is that **`SessionMeta`
  and the workspace persistence must carry which backend owns a session**, since
  the two stores now interleave Claude and Codex sessions.

Recommendation: **do the trait extraction as task 1**, refactoring Claude onto
it with no behavior change (tests stay green), *then* add Codex as the second
impl. Cheaper and safer than bolting Codex on inline and extracting later.

---

## 4. Verdict & effort estimate

**GO WITH CAVEATS.** No blocker; the architecture (PtyManager + pure
parse/derive functions) is already close to what a two-backend design wants, and
Codex's on-disk format is not just guessable but sitting on this machine. The
"caveats" are the two untestable-here unknowns, both cheap to resolve once a
`codex` binary is in hand.

**Estimate — ~5 agent-tasks:**
1. **Extract `SessionBackend` trait**, port Claude onto it, thread a `backend`
   tag through `SessionMeta`/`SpawnSpec`/workspace store — no behavior change,
   existing tests stay green. *(Moderate)*
2. **Codex transcript + discovery parser** — recursive `sessions/**` walk,
   payload-envelope parse, title-from-first-user-message with block stripping.
   New fixtures from real rollouts. *(Moderate)*
3. **Codex backend wiring** — `codex_bin.rs` (parameterized resolver) +
   `resume`/`resume_argv` (subcommand form). *(Trivial–Moderate)*
4. **Codex token-stats adapter** — `token_usage_record` selector, field rename,
   per-response (non-cumulative) summing. *(Moderate)*
5. **Activity/prompt tuning + UI backend badge** — Codex prompt strings (+
   optional `task_started/complete` transcript signal), frontend badge/filter.
   *(Moderate; needs the binary to tune prompts)*

## 5. Single biggest risk / unknown

**The resume contract is unverifiable on this machine.** `codex resume` takes
which of the two ids (`id` vs `session_id`)? Does interactive `codex resume <id>`
attach cleanly under a PTY the way `claude --resume <id>` does, or does it force
the picker / need `exec`? And the rollout schema we dissected is the
**Desktop-bundled** codex (`originator: "Codex Desktop"`, model `gpt-6-astra`,
cli 0.153) — a user's **standalone public `codex` CLI** may write a slightly
different schema/version to the same `~/.codex/sessions/`. Resolve both by
installing the standalone `codex`, starting a session, and reading back its
rollout + testing `codex resume <id>` before committing to task 3's argv.
