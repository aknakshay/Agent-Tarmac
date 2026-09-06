use crate::backend::BackendKind;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionMeta {
    pub id: String,
    pub cwd: Option<String>,
    pub title: String,
    pub last_activity: DateTime<Utc>,
    pub last_role: Option<String>,
    /// Which agent CLI owns this session. Defaults to Claude; set by the
    /// parsing backend so the orchestration layer can dispatch resume/prompt
    /// logic to the right [`crate::backend::SessionBackend`].
    #[serde(default)]
    pub backend: BackendKind,
    /// True only for a Codex session from a ChatGPT **app** surface — the
    /// Desktop app or the Chrome extension side panel, as opposed to the
    /// terminal `codex` CLI (see `codex::is_codex_app_originator`). The index
    /// carries every session, but the UI hides these unless the "show ChatGPT
    /// Codex sessions" setting is on — Agent Tarmac is a terminal-CLI cockpit.
    /// Always false for Claude.
    #[serde(default)]
    pub codex_app: bool,
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn extract_user_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    match content {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(items) => items.iter().find_map(|i| {
            if i.get("type")?.as_str()? == "text" {
                i.get("text")?.as_str().map(String::from)
            } else {
                None
            }
        }),
        _ => None,
    }
}

pub fn parse_transcript(path: &Path) -> Option<SessionMeta> {
    let id = path.file_stem()?.to_str()?.to_string();
    // Read only the file edges: `cwd`/`summary`/first user turn live in the
    // head, `last_activity`/`last_role` in the tail. For every small fixture
    // the window covers the whole file, so this walks the exact same lines a
    // full read would and the extracted meta is identical. See `bounded_read`.
    let chunks = crate::bounded_read::read_head_tail(path)?;
    let (mut cwd, mut summary, mut first_user, mut last_ts, mut last_role) =
        (None, None, None, None, None);
    for line in chunks.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
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
        backend: BackendKind::Claude,
        codex_app: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "tests/fixtures/projects/-Users-me-proj-a/11111111-1111-1111-1111-111111111111.jsonl",
        )
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
    fn large_file_parses_edges_without_reading_middle() {
        use std::io::Write;
        // Head (first 128 KB): real cwd + summary + first user turn, then benign
        // pad. Deep middle: a valid `summary` line that — since `summary`
        // overwrites on every occurrence — WOULD win the title if the middle
        // were read. Tail (last 64 KB): benign pad + the final assistant record.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        let pad = format!(r#"{{"pad":"{}"}}"#, "p".repeat(200));
        let mut written = 0u64;
        let w = |f: &mut std::fs::File, line: &str| {
            writeln!(f, "{line}").unwrap();
            line.len() as u64 + 1
        };
        written += w(
            &mut f,
            r#"{"type":"summary","summary":"Real Title","cwd":"/Users/me/proj"}"#,
        );
        written += w(
            &mut f,
            r#"{"type":"user","timestamp":"2026-09-01T00:00:00Z","message":{"content":"hi"}}"#,
        );
        // Pad past the head window so the poison lands in the untouched middle.
        let head_target = written + 160 * 1024;
        while written < head_target {
            written += w(&mut f, &pad);
        }
        written += w(
            &mut f,
            r#"{"type":"summary","summary":"WRONG-FROM-MIDDLE"}"#,
        );
        // Pad past the tail window so the poison also clears the tail.
        let tail_target = written + 96 * 1024;
        while written < tail_target {
            written += w(&mut f, &pad);
        }
        w(
            &mut f,
            r#"{"type":"assistant","timestamp":"2026-09-06T10:00:05Z","message":{"content":"done"}}"#,
        );
        f.flush().unwrap();
        drop(f);

        let m = parse_transcript(&p).unwrap();
        // Head summary wins — the middle poison summary was never read.
        assert_eq!(m.title, "Real Title");
        // Tail record supplies last_role + last_activity.
        assert_eq!(m.last_role.as_deref(), Some("assistant"));
        assert_eq!(m.last_activity.to_rfc3339(), "2026-09-06T10:00:05+00:00");
    }

    #[test]
    fn falls_back_to_first_user_text_when_no_summary() {
        // second fixture: same dir, id 2222...jsonl, only the user+assistant lines
        let p = fixture()
            .parent()
            .unwrap()
            .join("22222222-2222-2222-2222-222222222222.jsonl");
        let m = parse_transcript(&p).unwrap();
        assert_eq!(m.title, "hello");
    }
}
