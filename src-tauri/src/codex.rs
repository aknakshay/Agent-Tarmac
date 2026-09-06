//! OpenAI Codex CLI seam module: discovery, transcript parse, and token-usage
//! extraction for `~/.codex/sessions`. The pure functions here are what
//! [`crate::backend::CodexBackend`] delegates to, mirroring how the Claude
//! backend delegates to `transcript`/`token_stats`/`session_index`.
//!
//! Two structural differences from Claude drive everything in this file
//! (observed against 250+ real rollout files, see `docs/codex-spike.md`):
//!
//!   1. **Date-sharded, not cwd-sharded.** Codex writes
//!      `~/.codex/sessions/YYYY/MM/DD/rollout-<iso8601>-<uuid>.jsonl`, so the
//!      cwd is *not* recoverable from a directory name and discovery must be a
//!      recursive walk (Claude is one level of `<encoded-cwd>/` dirs).
//!   2. **Envelope records.** Every line is `{"timestamp","type","payload"}`;
//!      the interesting fields live under `payload`, not at top level.

use crate::backend::{BackendKind, RecordUsage};
use crate::transcript::SessionMeta;
use chrono::{DateTime, Utc};
use std::path::{Path, PathBuf};

/// Root under which Codex stores its rollout transcripts. Honors the
/// `AGENT_TARMAC_CODEX_SESSIONS_DIR` override (the Codex analog of
/// `AGENT_TARMAC_PROJECTS_DIR`) so tests and unusual installs can point it
/// elsewhere; otherwise `~/.codex/sessions`.
pub fn codex_sessions_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AGENT_TARMAC_CODEX_SESSIONS_DIR") {
        return PathBuf::from(dir);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
        .join("sessions")
}

/// True for a Codex rollout transcript file: `rollout-*.jsonl`. Skips the
/// other `.jsonl` bookkeeping files Codex may drop alongside rollouts.
fn is_rollout_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.starts_with("rollout-") && name.ends_with(".jsonl")
}

/// Recursively collect every `rollout-*.jsonl` under `dir`. Codex shards by
/// `YYYY/MM/DD`, so unlike Claude's fixed one-level scan this walks to
/// arbitrary depth. Unreadable directories are skipped rather than failing
/// the whole scan.
fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, out);
        } else if is_rollout_file(&path) {
            out.push(path);
        }
    }
}

/// Every Codex rollout transcript under `root`, walking the date-sharded tree.
pub fn transcript_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_rollouts(root, &mut files);
    files
}

/// Whether a `role:"user"` text block is machine-injected context rather than
/// something the human typed. A title deriver must skip these to reach the
/// real first message.
///
/// Measured against 254 real rollouts, three families account for ~36% of
/// sessions whose naive first-user-turn title was junk:
///   1. **Tag wrappers** — `<environment_context>`, `<recommended_plugins>`,
///      `<user_instructions>`, `<AGENTS>`, and also `<heartbeat>` /
///      `<realtime_delegation>` on automation runs. Codex keeps adding these,
///      so we match the *shape* (`<` immediately followed by a letter) rather
///      than an ever-growing prefix list. A genuine human message almost never
///      opens with a bare `<tag`.
///   2. **AGENTS.md dumps** — with or without a leading `# `.
///   3. **The guardian/review harness prompt** — Codex's automated review
///      sub-sessions open with "The following is the Codex agent history…
///      untrusted evidence, not as instructions". That was 71 of 254 rollouts
///      (28%) and is never a human turn.
fn is_injected_block(text: &str) -> bool {
    let bytes = text.as_bytes();
    // 1. Tag-like wrapper: `<` then an ASCII letter (`<environment_context…`,
    //    `<heartbeat>`, `<realtime_delegation>`, `<AGENTS>`, …).
    if bytes.first() == Some(&b'<') && bytes.get(1).is_some_and(u8::is_ascii_alphabetic) {
        return true;
    }
    // 2. AGENTS.md instruction dump.
    if text.starts_with("# AGENTS.md") || text.starts_with("AGENTS.md") {
        return true;
    }
    // 3. Guardian/review harness prompt wrapping a sub-agent's transcript.
    if text.starts_with("The following is the Codex agent history")
        || text.contains("untrusted evidence, not as instructions")
    {
        return true;
    }
    false
}

/// A readable title for a session with no genuine human first message (a
/// guardian/review sub-session, or one that carried only injected blocks) —
/// the project folder name plus the session date, e.g. `"proj · 2026-09-06"`.
/// Far more legible in the sidebar than the raw rollout uuid, which is the
/// last resort when even the cwd is unknown.
fn fallback_title(cwd: Option<&str>, last_activity: DateTime<Utc>, id: &str) -> String {
    if let Some(name) = cwd
        .and_then(|c| Path::new(c).file_name())
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
    {
        return format!("{name} · {}", last_activity.format("%Y-%m-%d"));
    }
    id.to_string()
}

/// The first meaningful (non-injected, non-blank) text in a `role:"user"`
/// `response_item` payload, or `None` if the message carried only injected
/// blocks (so the caller advances to the next user turn).
fn first_meaningful_user_text(payload: &serde_json::Value) -> Option<String> {
    let content = payload.get("content")?;
    match content {
        // Observed shape: an array of `{type:"input_text", text:"..."}` blocks.
        serde_json::Value::Array(blocks) => {
            for block in blocks {
                let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let trimmed = text.trim();
                if trimmed.is_empty() || is_injected_block(trimmed) {
                    continue;
                }
                return Some(trimmed.to_string());
            }
            None
        }
        // Defensive: a plain-string content, should it ever appear.
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty() && !is_injected_block(trimmed)).then(|| trimmed.to_string())
        }
        _ => None,
    }
}

/// Extract the resumable session uuid from a rollout filename as a fallback,
/// when the `session_meta` record's `id` is unreadable. The filename is
/// `rollout-<iso8601 timestamp>-<uuid>.jsonl`; the uuid is the trailing 36
/// chars of the stem (a canonical `8-4-4-4-12` uuid).
fn uuid_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    if stem.len() < 36 {
        return None;
    }
    let uuid = &stem[stem.len() - 36..];
    // Cheap sanity check: canonical uuid hyphen positions.
    let bytes = uuid.as_bytes();
    (bytes[8] == b'-' && bytes[13] == b'-' && bytes[18] == b'-' && bytes[23] == b'-')
        .then(|| uuid.to_string())
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Parse one Codex rollout file into a [`SessionMeta`] tagged
/// [`BackendKind::Codex`], or `None` if the file is unreadable / has no
/// identifiable session id.
///
/// Field sourcing (all from the `{timestamp,type,payload}` envelope):
///   - **id** — `session_meta.payload.id`. This is the per-rollout uuid that
///     matches the filename; it is the id `codex resume <id>` must target. See
///     the note on [`session id choice`](self) below.
///   - **cwd** — `session_meta.payload.cwd` (NOT the directory name).
///   - **title** — first meaningful text of the first `role:"user"`
///     `response_item`, skipping injected AGENTS.md/env/plugin blocks.
///   - **last_activity** — the last record's top-level `timestamp`.
///   - **last_role** — the role of the last *role-bearing* `response_item`
///     (reasoning items have a null role and are skipped, so a trailing
///     reasoning block doesn't erase the last assistant/user role).
///
/// ## Session id choice: `id`, not `session_id`
///
/// A `session_meta` payload carries two uuids. `id` matches the rollout
/// filename and uniquely identifies *this one resumable rollout*. `session_id`
/// is a broader conversation/thread grouping: it is shared across multiple
/// rollout files (observed on subagent/`guardian_review` rollouts and on
/// resumed threads, where each rollout has its own distinct `id` but they all
/// carry one common `session_id`). Since `codex resume <id>` must attach to a
/// single specific rollout, we key off `id`. (Task 3 runtime-verifies this
/// against a live `codex` binary.)
pub fn parse_transcript(path: &Path) -> Option<SessionMeta> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    let mut last_ts: Option<DateTime<Utc>> = None;
    let mut last_role: Option<String> = None;

    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let payload = v.get("payload");
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session_meta") => {
                if let Some(p) = payload {
                    if id.is_none() {
                        id = p.get("id").and_then(|x| x.as_str()).map(String::from);
                    }
                    if cwd.is_none() {
                        cwd = p.get("cwd").and_then(|x| x.as_str()).map(String::from);
                    }
                }
            }
            Some("response_item") => {
                if let Some(p) = payload {
                    // Reasoning items have no `role`; only role-bearing turns
                    // update last_role and can seed the title.
                    if let Some(role) = p.get("role").and_then(|r| r.as_str()) {
                        last_role = Some(role.to_string());
                        if role == "user" && title.is_none() {
                            title = first_meaningful_user_text(p);
                        }
                    }
                }
            }
            _ => {}
        }
        if let Some(ts) = record_timestamp(&v) {
            last_ts = Some(ts);
        }
    }

    // `id` from the meta record is authoritative; fall back to the filename
    // uuid, then the whole stem, so a truncated/meta-less file still yields a
    // stable identifier rather than being dropped.
    let id = id
        .or_else(|| uuid_from_filename(path))
        .or_else(|| path.file_stem().and_then(|s| s.to_str()).map(String::from))?;

    let mtime: DateTime<Utc> = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(Into::into)
        .unwrap_or_else(Utc::now);
    let last_activity = last_ts.unwrap_or(mtime);

    // A real human first message wins; otherwise a legible cwd+date label
    // rather than the boilerplate harness prompt or a bare uuid.
    let title = match title {
        Some(t) => truncate(&t, 80),
        None => fallback_title(cwd.as_deref(), last_activity, &id),
    };
    Some(SessionMeta {
        id,
        cwd,
        title,
        last_activity,
        last_role,
        backend: BackendKind::Codex,
    })
}

/// `(input, output, cache_read)` for one Codex transcript record, or `None`
/// if the record carries no per-response usage.
///
/// Selects **`token_usage_record`** and reads `payload.usage` — the
/// *per-response* usage. Deliberately ignores the `event_msg`/`token_count`
/// record (its `info.last_token_usage` duplicates the same numbers) so that a
/// caller summing `usage_from_record` across every line does not double-count
/// on newer rollouts that emit both. It also ignores `payload.thread_token_usage`
/// (cumulative) for the same reason — see the double-count trap in the spike.
///
/// Field rename vs Claude: Codex's `cached_input_tokens` maps to the
/// `cache_read` slot.
///
/// **`reasoning_output_tokens` is deliberately NOT added to `output`.** Codex
/// records usage in OpenAI's Responses shape, where `output_tokens` *already
/// includes* the reasoning tokens — `reasoning_output_tokens` is a breakdown
/// detail of `output_tokens`, not a sibling to be summed on top. The fixture
/// encodes the invariant that proves this: `total_tokens (150) == input_tokens
/// (100) + output_tokens (50)`, with `reasoning_output_tokens (5)` sitting
/// *inside* the 50. Folding reasoning into `output` here would double-count it
/// against the billed total. So reasoning is not "dropped" from the fleet total
/// — it is counted once, as part of `output_tokens`. (If real Codex data ever
/// shows `total == input + output + reasoning`, revisit this; the invariant
/// check would fail and the fold would then be correct.)
pub fn usage_from_record(v: &serde_json::Value) -> Option<RecordUsage> {
    if v.get("type").and_then(|t| t.as_str()) != Some("token_usage_record") {
        return None;
    }
    let usage = v.get("payload")?.get("usage")?;
    let input = usage
        .get("input_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    // Already includes reasoning_output_tokens (see doc comment) — do not add.
    let output = usage
        .get("output_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let cache_read = usage
        .get("cached_input_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    Some((input, output, cache_read))
}

/// The wall-clock timestamp of one Codex record — the top-level `timestamp`
/// on the envelope (present on every record kind).
pub fn record_timestamp(v: &serde_json::Value) -> Option<DateTime<Utc>> {
    v.get("timestamp")?.as_str()?.parse().ok()
}

/// Substrings that, in the stripped tail of Codex pty output, suggest the CLI
/// is waiting on the user (an approval / choice prompt) rather than working.
///
/// Tuned against a **live `codex` 0.153.4 TUI** (task 3 smoke test): the
/// directory-trust gate ("Do you trust…" + "Press enter to continue") and
/// numbered choice lists were observed verbatim on a real `codex resume`.
/// Note the selection arrow is `›` (U+203A), NOT Claude's `❯` (U+276F) —
/// both are listed so a numbered prompt matches whichever a given codex
/// build renders. The approval-dialog strings ("Allow command", "Do you
/// want", "Yes, and don't ask again") match Codex's documented exec/patch
/// approval shapes; kept as-is pending a live approval to confirm.
///
/// This tail scrape is the fast path for *blocking* prompts. The slower
/// "assistant finished, now waiting" signal rides on `last_role` instead:
/// a completed Codex turn leaves the last role-bearing `response_item` as
/// `assistant`, which `derive_status` turns into `NeedsYou` after the quiet
/// window — so no dedicated `task_complete` transcript hook is needed.
const PROMPT_PATTERNS: &[&str] = &[
    "Do you trust",
    "Press enter to continue",
    "Allow command",
    "Allow Codex",
    "Do you want",
    "❯ 1.",
    "› 1.",
    "Yes, and don't ask again",
];

pub fn tail_looks_like_prompt(tail: &str) -> bool {
    PROMPT_PATTERNS.iter().any(|p| tail.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex")
    }

    fn fixture_a() -> PathBuf {
        fixtures_root()
            .join("2026/09/06")
            .join("rollout-2026-09-06T14-47-26-019f0000-0000-7000-8000-00000000aaaa.jsonl")
    }

    fn fixture_b() -> PathBuf {
        fixtures_root()
            .join("2026/08/15")
            .join("rollout-2026-08-15T09-01-19-019f1111-1111-7111-8111-00000000bbbb.jsonl")
    }

    // A guardian/review sub-session: its first user turn is a `<heartbeat>`
    // wrapper, its second the "The following is the Codex agent history…"
    // harness prompt. No genuine human message anywhere.
    fn fixture_guardian() -> PathBuf {
        fixtures_root()
            .join("2026/09/05")
            .join("rollout-2026-09-05T08-00-00-019f2222-2222-7222-8222-00000000cccc.jsonl")
    }

    // ----- discovery -----

    #[test]
    fn transcript_files_walks_date_shards_and_skips_non_rollouts() {
        let files = transcript_files(&fixtures_root());
        // All three rollouts found across different YYYY/MM/DD dirs; the decoy
        // `notes.jsonl` and `rollout-*.txt` are not.
        assert_eq!(files.len(), 3, "found: {files:?}");
        assert!(files.iter().all(|p| is_rollout_file(p)));
        assert!(files
            .iter()
            .any(|p| p.to_string_lossy().contains("2026/09/06")));
        assert!(files
            .iter()
            .any(|p| p.to_string_lossy().contains("2026/08/15")));
        assert!(files
            .iter()
            .any(|p| p.to_string_lossy().contains("2026/09/05")));
    }

    #[test]
    fn transcript_files_of_missing_root_is_empty() {
        assert!(transcript_files(Path::new("/nope/not-here")).is_empty());
    }

    // ----- parse -----

    #[test]
    fn parses_id_cwd_title_last_role_and_activity() {
        let m = parse_transcript(&fixture_a()).unwrap();
        // id comes from session_meta.payload.id (== filename uuid), NOT session_id.
        assert_eq!(m.id, "019f0000-0000-7000-8000-00000000aaaa");
        assert_eq!(m.cwd.as_deref(), Some("/Users/me/proj"));
        // Title skips the injected recommended_plugins + environment_context
        // blocks of the first user turn and lands on the real second message.
        assert_eq!(m.title, "can you connect my slack?");
        // Last role-bearing response_item is the trailing assistant message.
        assert_eq!(m.last_role.as_deref(), Some("assistant"));
        // last_activity is the final record's timestamp.
        assert_eq!(m.last_activity.to_rfc3339(), "2026-09-06T14:50:00+00:00");
        assert_eq!(m.backend, BackendKind::Codex);
    }

    #[test]
    fn picks_id_not_session_id_and_skips_agents_block_and_trailing_reasoning() {
        let m = parse_transcript(&fixture_b()).unwrap();
        // `id` (per-rollout) is chosen over the shared `session_id`.
        assert_eq!(m.id, "019f1111-1111-7111-8111-00000000bbbb");
        assert_eq!(m.cwd.as_deref(), Some("/Users/me/other-proj"));
        // First user turn leads with an AGENTS.md dump + env block; title is
        // the third, real block.
        assert_eq!(m.title, "review the latest commit for regressions");
        // A trailing reasoning item (null role) does not clobber the last
        // assistant role.
        assert_eq!(m.last_role.as_deref(), Some("assistant"));
        assert_eq!(m.last_activity.to_rfc3339(), "2026-08-15T09:01:29+00:00");
    }

    #[test]
    fn missing_file_returns_none() {
        assert!(parse_transcript(Path::new("/nope/x.jsonl")).is_none());
    }

    #[test]
    fn guardian_session_falls_back_to_cwd_and_date_not_boilerplate() {
        // The dominant real-world junk class (71 of 254 rollouts): a
        // review/guardian sub-session with no human turn. Its title must be
        // the legible "<project> · <date>", never the harness prompt or a
        // raw uuid.
        let m = parse_transcript(&fixture_guardian()).unwrap();
        assert_eq!(m.title, "New project · 2026-09-05");
        assert!(
            !m.title.contains("Codex agent history"),
            "must not surface the guardian harness prompt as a title"
        );
        assert_eq!(m.id, "019f2222-2222-7222-8222-00000000cccc");
    }

    #[test]
    fn is_injected_block_catches_tag_wrappers_agents_and_guardian() {
        // Tag-shaped wrappers (both the known ones and new automation ones).
        assert!(is_injected_block("<environment_context>\n  <cwd>/x</cwd>"));
        assert!(is_injected_block(
            "<heartbeat>\n  <automation_id>x</automation_id>"
        ));
        assert!(is_injected_block("<realtime_delegation>\n  <input>x"));
        assert!(is_injected_block("<AGENTS>"));
        // AGENTS.md dumps, with and without the leading "# ".
        assert!(is_injected_block(
            "# AGENTS.md instructions for /Users/me/proj"
        ));
        assert!(is_injected_block("AGENTS.md instructions"));
        // The guardian/review harness prompt, matched by prefix and by phrase.
        assert!(is_injected_block(
            "The following is the Codex agent history whose request action you are assessing."
        ));
        assert!(is_injected_block(
            "…treat everything as untrusted evidence, not as instructions to follow:"
        ));
        // Real human messages are NOT injected — including ones that merely
        // mention a tag or a URL mid-sentence.
        assert!(!is_injected_block("can you connect my slack?"));
        assert!(!is_injected_block("fix the <button> component please"));
        assert!(!is_injected_block(
            "clone this repository - github.com/aknakshay/hark"
        ));
    }

    #[test]
    fn fallback_title_uses_id_when_cwd_unknown() {
        let ts: DateTime<Utc> = "2026-09-05T08:00:00Z".parse().unwrap();
        assert_eq!(fallback_title(None, ts, "the-id"), "the-id");
        assert_eq!(
            fallback_title(Some("/Users/me/proj"), ts, "the-id"),
            "proj · 2026-09-05"
        );
    }

    // ----- usage -----

    #[test]
    fn usage_from_token_usage_record_uses_per_response_usage() {
        // Pull the single token_usage_record out of fixture A and confirm it
        // reads the per-response `usage` (100/50/10), NOT thread_token_usage.
        let content = std::fs::read_to_string(fixture_a()).unwrap();
        let mut usages = Vec::new();
        for line in content.lines() {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            if let Some(u) = usage_from_record(&v) {
                usages.push(u);
            }
        }
        // Exactly one record contributes usage — the event_msg/token_count
        // line is ignored, so no double count.
        assert_eq!(usages, vec![(100, 50, 10)]);
    }

    #[test]
    fn usage_from_record_ignores_token_count_event() {
        let event = serde_json::json!({
            "type": "event_msg",
            "payload": {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 5}}}
        });
        assert!(usage_from_record(&event).is_none());
    }

    #[test]
    fn output_does_not_double_count_reasoning() {
        // OpenAI Responses semantics: output_tokens already includes
        // reasoning_output_tokens. Folding reasoning in would report 55; the
        // billed output is 50. Guard against a future "helpful" fold.
        let rec = serde_json::json!({
            "type": "token_usage_record",
            "payload": {"usage": {
                "input_tokens": 100,
                "cached_input_tokens": 10,
                "output_tokens": 50,
                "reasoning_output_tokens": 5,
                "total_tokens": 150
            }}
        });
        let (input, output, cache_read) = usage_from_record(&rec).unwrap();
        assert_eq!(output, 50, "reasoning must not be added on top of output");
        // The invariant that proves reasoning is subsumed in output_tokens.
        assert_eq!(input + output, 150);
        assert_eq!((input, cache_read), (100, 10));
    }

    #[test]
    fn desktop_bundled_session_without_usage_record_reads_zero() {
        // Desktop-bundled rollouts emit only event_msg/token_count, never a
        // token_usage_record. We intentionally do NOT add a token_count
        // fallback (standalone CLI — the target — writes the proper record,
        // and a fallback would risk double-counting files that have both).
        // Such a session must therefore degrade cleanly to zero usage, not
        // crash. Fixture B is exactly this shape (no token_usage_record).
        let content = std::fs::read_to_string(fixture_b()).unwrap();
        let any_usage = content.lines().any(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|v| usage_from_record(&v))
                .is_some()
        });
        assert!(
            !any_usage,
            "desktop-bundled session yields no usage records"
        );
    }

    #[test]
    fn record_timestamp_reads_envelope_timestamp() {
        let v = serde_json::json!({"timestamp": "2026-09-06T14:47:34.000Z", "type": "x"});
        assert_eq!(
            record_timestamp(&v).unwrap().to_rfc3339(),
            "2026-09-06T14:47:34+00:00"
        );
        assert!(record_timestamp(&serde_json::json!({"type": "x"})).is_none());
    }

    // ----- prompt patterns -----

    #[test]
    fn prompt_detection_matches_codex_shapes() {
        assert!(tail_looks_like_prompt("Allow command `rm -rf`?\n❯ 1. Yes"));
        assert!(tail_looks_like_prompt("Do you want to apply this patch?"));
        // Verified verbatim against live codex 0.153.4 (task 3 smoke test):
        // the directory-trust gate and its `›`-arrow numbered choice list.
        assert!(tail_looks_like_prompt(
            "Do you trust the contents of this directory?\n› 1. Yes, continue  2. No, quit"
        ));
        assert!(tail_looks_like_prompt("Press enter to continue"));
        assert!(!tail_looks_like_prompt("Compiling foo v0.1.0"));
        // The idle input box ("› Ask Codex to do anything") must NOT trip the
        // prompt scrape — it's always present in the TUI, so matching it would
        // pin every running Codex session to NeedsYou.
        assert!(!tail_looks_like_prompt("› Ask Codex to do anything"));
    }

    #[test]
    fn uuid_from_filename_extracts_trailing_uuid() {
        let p = fixture_a();
        assert_eq!(
            uuid_from_filename(&p).as_deref(),
            Some("019f0000-0000-7000-8000-00000000aaaa")
        );
        assert!(uuid_from_filename(Path::new("rollout-short.jsonl")).is_none());
    }
}
