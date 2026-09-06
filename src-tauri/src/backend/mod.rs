//! Session backends.
//!
//! A [`SessionBackend`] is the seam between "how a particular agent CLI stores
//! and resumes its sessions" and the rest of the app (discovery watcher,
//! status loop, resume command, token stats). Today there is exactly one
//! implementor — [`ClaudeBackend`], wrapping the Claude Code CLI — but every
//! Claude-specific behavior the app used to hardcode now flows through this
//! trait so a second backend (OpenAI Codex CLI) can slot in behind the same
//! interface without touching the orchestration layer.
//!
//! The trait captures the six seams the Codex spike identified
//! (`docs/codex-spike.md`):
//!   1. discovery      — [`SessionBackend::transcripts_root`] + [`transcript_files`]
//!   2. transcript parse — [`SessionBackend::parse_transcript`]
//!   3. resume command — [`SessionBackend::resume_argv`]
//!   4. binary resolve — [`SessionBackend::resolve_binary`]
//!   5. activity/prompt — [`SessionBackend::tail_looks_like_prompt`]
//!   6. token usage    — [`SessionBackend::usage_from_record`] + [`record_timestamp`]
//!
//! [`transcript_files`]: SessionBackend::transcript_files
//! [`record_timestamp`]: SessionBackend::record_timestamp

use crate::transcript::SessionMeta;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Which agent CLI owns a session. Stored on every [`SessionMeta`] so the
/// orchestration layer can dispatch back to the right backend (e.g. resume
/// picks the correct program + args, the status loop uses the right prompt
/// patterns). Serialized lowercase (`"claude"`) on the wire; `#[serde(default)]`
/// at the use site keeps a transcript/workspace written before this field
/// existed loading as [`BackendKind::Claude`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    #[default]
    Claude,
    // Codex, // added in a later task
}

/// Per-record token usage pulled from one transcript line:
/// `(input_tokens, output_tokens, cache_read_tokens)`. A tuple rather than a
/// named struct to keep it byte-identical to `token_stats`'s existing return
/// shape (zero-behavior-change refactor); a later backend that needs richer
/// fields (Codex adds `reasoning_output_tokens`) can widen this then.
pub type RecordUsage = (u64, u64, u64);

/// The seam between one agent CLI's on-disk/resume conventions and the app.
///
/// Implementors are stateless, zero-sized dispatch handles held as `'static`
/// singletons (see [`all_backends`] / [`backend_for`]); all per-session state
/// lives in [`SessionMeta`] / the PTY manager, not the backend.
pub trait SessionBackend: Send + Sync {
    /// Stable identity, stamped onto every [`SessionMeta`] this backend parses.
    fn kind(&self) -> BackendKind;

    /// Root directory under which this backend stores its transcripts.
    fn transcripts_root(&self) -> PathBuf;

    /// Every transcript file under `root`, in this backend's on-disk layout.
    /// (Claude shards one level deep by encoded cwd; Codex will shard by date
    /// and walk recursively — this method is where that topology lives.)
    fn transcript_files(&self, root: &Path) -> Vec<PathBuf>;

    /// Parse one transcript file into a [`SessionMeta`] tagged with this
    /// backend's [`kind`](SessionBackend::kind), or `None` if unreadable.
    fn parse_transcript(&self, path: &Path) -> Option<SessionMeta>;

    /// Discover + parse every session under `root`, newest-activity first.
    ///
    /// Default impl composes [`transcript_files`](SessionBackend::transcript_files)
    /// and [`parse_transcript`](SessionBackend::parse_transcript); a backend
    /// only needs to override this if its discovery isn't one-file-per-session.
    fn scan(&self, root: &Path) -> Vec<SessionMeta> {
        let mut sessions: Vec<SessionMeta> = self
            .transcript_files(root)
            .iter()
            .filter_map(|p| self.parse_transcript(p))
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.last_activity));
        sessions
    }

    /// The `(program, args)` to spawn to resume `session_id` interactively
    /// (Claude: `claude --resume <id>`; Codex: `codex resume <id>`).
    fn resume_argv(&self, session_id: &str) -> (String, Vec<String>);

    /// The `(program, args)` to spawn a fresh session (no id yet).
    fn start_argv(&self) -> (String, Vec<String>);

    /// Resolve the backend CLI binary to an absolute path (or the bare name,
    /// as a last resort, when every probe fails).
    fn resolve_binary(&self) -> String;

    /// Whether the PTY output tail indicates the agent is waiting on the user
    /// rather than working. Backend-specific because each CLI's TUI prints
    /// different prompt strings.
    fn tail_looks_like_prompt(&self, tail: &str) -> bool;

    /// `(input, output, cache_read)` for one transcript record, or `None` if
    /// the record carries no usage.
    fn usage_from_record(&self, v: &serde_json::Value) -> Option<RecordUsage>;

    /// The timestamp of one transcript record, if present. Used to bucket
    /// token usage into "today" vs all-time.
    fn record_timestamp(&self, v: &serde_json::Value) -> Option<DateTime<Utc>>;
}

// ---------------------------------------------------------------------------
// Claude backend
// ---------------------------------------------------------------------------

/// The Claude Code CLI backend — the only implementor today. Every method
/// delegates to the pre-existing seam module (`transcript`, `activity`,
/// `token_stats`, `claude_bin`, `session_index`), so this is pure dispatch:
/// the behavior is exactly what the app did before the trait existed.
pub struct ClaudeBackend;

impl SessionBackend for ClaudeBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Claude
    }

    fn transcripts_root(&self) -> PathBuf {
        crate::session_index::claude_projects_dir()
    }

    fn transcript_files(&self, root: &Path) -> Vec<PathBuf> {
        // `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` — one level of
        // project directories, each holding per-session jsonl files.
        let mut files = Vec::new();
        let Ok(project_dirs) = std::fs::read_dir(root) else {
            return files;
        };
        for project_entry in project_dirs.flatten() {
            let project_path = project_entry.path();
            if !project_path.is_dir() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&project_path) else {
                continue;
            };
            for file_entry in entries.flatten() {
                let file_path = file_entry.path();
                if file_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    files.push(file_path);
                }
            }
        }
        files
    }

    fn parse_transcript(&self, path: &Path) -> Option<SessionMeta> {
        crate::transcript::parse_transcript(path)
    }

    fn resume_argv(&self, session_id: &str) -> (String, Vec<String>) {
        (
            self.resolve_binary(),
            vec!["--resume".to_string(), session_id.to_string()],
        )
    }

    fn start_argv(&self) -> (String, Vec<String>) {
        (self.resolve_binary(), vec![])
    }

    fn resolve_binary(&self) -> String {
        crate::claude_bin::claude_program()
    }

    fn tail_looks_like_prompt(&self, tail: &str) -> bool {
        crate::activity::tail_looks_like_prompt(tail)
    }

    fn usage_from_record(&self, v: &serde_json::Value) -> Option<RecordUsage> {
        crate::token_stats::usage_from_record(v)
    }

    fn record_timestamp(&self, v: &serde_json::Value) -> Option<DateTime<Utc>> {
        crate::token_stats::record_timestamp(v)
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// The Claude backend singleton.
pub static CLAUDE: ClaudeBackend = ClaudeBackend;

/// Every backend the app knows about, in discovery order. Discovery (the
/// session watcher, token stats) iterates this; per-session dispatch uses
/// [`backend_for`]. Adding Codex is a one-line change here plus its impl.
pub fn all_backends() -> &'static [&'static dyn SessionBackend] {
    static BACKENDS: &[&dyn SessionBackend] = &[&CLAUDE];
    BACKENDS
}

/// The backend that owns sessions of `kind`, for per-session dispatch (resume,
/// prompt detection). Total over [`BackendKind`] so it can't fail.
pub fn backend_for(kind: BackendKind) -> &'static dyn SessionBackend {
    match kind {
        BackendKind::Claude => &CLAUDE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_kind_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&BackendKind::Claude).unwrap(),
            "\"claude\""
        );
    }

    #[test]
    fn backend_kind_defaults_to_claude() {
        assert_eq!(BackendKind::default(), BackendKind::Claude);
    }

    #[test]
    fn registry_dispatches_claude() {
        assert_eq!(backend_for(BackendKind::Claude).kind(), BackendKind::Claude);
        assert_eq!(all_backends().len(), 1);
    }

    #[test]
    fn claude_resume_argv_is_resume_flag() {
        let (_program, args) = CLAUDE.resume_argv("abc-123");
        assert_eq!(args, vec!["--resume".to_string(), "abc-123".to_string()]);
    }

    #[test]
    fn claude_scan_matches_fixture_topology() {
        // Same fixture + expectation as session_index::scan's own test — the
        // default scan() over the Claude topology is behavior-identical.
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/projects");
        let all = CLAUDE.scan(&dir);
        assert_eq!(all.len(), 2);
        assert!(all[0].last_activity >= all[1].last_activity);
        assert!(all.iter().all(|s| s.backend == BackendKind::Claude));
    }
}
