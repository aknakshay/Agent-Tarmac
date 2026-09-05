//! Pure activity status derivation for a Claude Code session.
//!
//! Nothing here touches Tauri, threads, or I/O — `status_loop` wires this
//! into the session poller.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Working,
    NeedsYou,
    Idle,
    Dormant,
}

#[derive(Debug, Clone, Copy)]
pub struct StatusInputs {
    pub running: bool,
    pub secs_since_activity: u64,
    pub last_role_assistant: bool,
    pub prompt_at_tail: bool,
    pub idle_after_secs: u64,
}

/// How long the assistant's last message can sit quiet before we call it
/// `NeedsYou` instead of `Working`.
///
/// History: this used to be 3s (same as the tool-running fast path below),
/// but a genuinely-working `claude` routinely pauses longer than 3s between
/// pty writes (tool execution, thinking), so the old threshold made status
/// flap Working <-> NeedsYou on every such pause, spamming notifications. A
/// real "Claude finished and is waiting on you" state stays quiet for good,
/// so 20s is long enough to absorb normal tool-run pauses while still being
/// short relative to `idle_after_secs`.
const ASSISTANT_QUIET_NEEDS_YOU_SECS: u64 = 20;

/// Direct transcription of the decision table in spec §5 (Tiers 1-2 unified).
/// Rows are evaluated in order; the first match wins.
///
/// For the `last_role_assistant` branch specifically:
///   - `< ASSISTANT_QUIET_NEEDS_YOU_SECS` -> Working (still settling)
///   - `ASSISTANT_QUIET_NEEDS_YOU_SECS .. idle_after_secs` -> NeedsYou
///   - `>= idle_after_secs` -> Idle
pub fn derive_status(i: &StatusInputs) -> Status {
    if !i.running {
        return Status::Dormant;
    }
    if i.prompt_at_tail {
        return Status::NeedsYou;
    }
    if i.secs_since_activity < 3 {
        return Status::Working;
    }
    if i.last_role_assistant {
        if i.secs_since_activity >= i.idle_after_secs {
            return Status::Idle;
        }
        if i.secs_since_activity < ASSISTANT_QUIET_NEEDS_YOU_SECS {
            return Status::Working;
        }
        return Status::NeedsYou;
    }
    // secs_since_activity >= 3, last message wasn't from the assistant: a
    // tool is running quietly (e.g. a long shell command).
    Status::Working
}

/// Substrings that, when present in the stripped tail of pty output, signal
/// Claude Code is waiting on the user rather than working.
///
/// This is a heuristic, not a terminal parser: it does not understand ANSI
/// cursor movement, so a pattern that happens to scroll out of the visible
/// tail (or one printed inside a code block/log dump) can produce a false
/// positive or negative. Extend the list as new prompt shapes are found.
const PROMPT_PATTERNS: &[&str] = &["Do you want", "❯ 1.", "Waiting for your input"];

pub fn tail_looks_like_prompt(tail: &str) -> bool {
    PROMPT_PATTERNS.iter().any(|p| tail.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_table() {
        let cases: Vec<(StatusInputs, Status)> = vec![
            (
                StatusInputs {
                    running: false,
                    secs_since_activity: 0,
                    last_role_assistant: false,
                    prompt_at_tail: false,
                    idle_after_secs: 300,
                },
                Status::Dormant,
            ),
            (
                StatusInputs {
                    running: true,
                    secs_since_activity: 100,
                    last_role_assistant: false,
                    prompt_at_tail: true,
                    idle_after_secs: 300,
                },
                Status::NeedsYou,
            ),
            (
                StatusInputs {
                    running: true,
                    secs_since_activity: 1,
                    last_role_assistant: true,
                    prompt_at_tail: false,
                    idle_after_secs: 300,
                },
                Status::Working,
            ),
            (
                StatusInputs {
                    running: true,
                    secs_since_activity: 19,
                    last_role_assistant: true,
                    prompt_at_tail: false,
                    idle_after_secs: 300,
                },
                Status::Working,
            ),
            (
                StatusInputs {
                    running: true,
                    secs_since_activity: 20,
                    last_role_assistant: true,
                    prompt_at_tail: false,
                    idle_after_secs: 300,
                },
                Status::NeedsYou,
            ),
            (
                StatusInputs {
                    running: true,
                    secs_since_activity: 30,
                    last_role_assistant: true,
                    prompt_at_tail: false,
                    idle_after_secs: 300,
                },
                Status::NeedsYou,
            ),
            (
                StatusInputs {
                    running: true,
                    secs_since_activity: 3000,
                    last_role_assistant: true,
                    prompt_at_tail: false,
                    idle_after_secs: 300,
                },
                Status::Idle,
            ),
            (
                StatusInputs {
                    running: true,
                    secs_since_activity: 30,
                    last_role_assistant: false,
                    prompt_at_tail: false,
                    idle_after_secs: 300,
                },
                Status::Working,
            ),
        ];
        for (i, expected) in cases {
            assert_eq!(derive_status(&i), expected, "inputs: {i:?}");
        }
    }

    #[test]
    fn prompt_detection() {
        assert!(tail_looks_like_prompt(
            "blah\nDo you want to make this edit?\n❯ 1. Yes"
        ));
        assert!(!tail_looks_like_prompt("Compiling foo v0.1.0"));
    }
}
