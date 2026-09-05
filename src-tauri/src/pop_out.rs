//! "Pop out to Ghostty" — hands a session off to an external terminal
//! process. If agent-tarmac owns a running PTY for the session, it's stopped
//! first (two processes must never share a session). A small shell script is
//! written to disk and launched in Ghostty, falling back to Terminal.app if
//! Ghostty isn't installed. The session id is then tracked as "external" so
//! `status_loop` can keep showing it as running while its transcript is
//! still being written to.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::pty_manager::{claude_program, PtyManager};
use crate::session_index::SessionIndexState;
use crate::workspace_store::{self, WorkspaceState};

/// Ids of sessions currently running in an external terminal (popped out),
/// as opposed to under agent-tarmac's own PtyManager.
#[derive(Default)]
pub struct ExternalSessions(pub Mutex<HashSet<String>>);

impl ExternalSessions {
    pub fn insert(&self, session_id: &str) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(session_id.to_string());
    }

    pub fn remove(&self, session_id: &str) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(session_id);
    }

    pub fn contains(&self, session_id: &str) -> bool {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.contains(session_id)
    }
}

/// Which app ended up hosting the popped-out session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PopOutApp {
    Ghostty,
    Terminal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopOutResult {
    pub app: PopOutApp,
}

/// Escapes `s` for embedding inside single quotes in a POSIX shell command:
/// `it's` -> `it'"'"'s`, so the surrounding `'...'` stays a single literal
/// argument even when `s` itself contains a `'`.
fn shell_single_quote_escape(s: &str) -> String {
    s.replace('\'', "'\"'\"'")
}

/// Builds the contents of the resume script written to disk for a popped-out
/// session: `cd` into the session's working directory, then exec `claude
/// --resume <id>` in place (so the shell's pid is claude's pid, and closing
/// the terminal window kills the right process).
pub fn pop_out_script(cwd: &str, id: &str) -> String {
    format!(
        "#!/bin/sh\ncd '{cwd}' && exec {program} --resume '{id}'\n",
        cwd = shell_single_quote_escape(cwd),
        program = claude_program(),
        id = shell_single_quote_escape(id),
    )
}

/// Escapes `s` for embedding inside a double-quoted AppleScript string
/// literal: backslash and double-quote both need escaping.
fn applescript_string_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Session ids are either UUIDs (resumed sessions) or `new-<uuid>`
/// placeholders (freshly started ones) — both are `[A-Za-z0-9_-]` only.
/// Rejecting anything else closes the injection path in the Terminal.app
/// fallback: `osascript ... do script "<script_path>"` is evaluated by
/// Terminal as a *shell command*, not just an AppleScript string, so a
/// script path built from an id containing backticks or `$(...)` would
/// otherwise execute arbitrary shell even after AppleScript-string-escaping.
fn validate_session_id(session_id: &str) -> Result<(), String> {
    let valid = !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(format!("invalid session id: {session_id}"))
    }
}

/// A single external-process invocation, captured rather than executed, so
/// the launch logic can be unit-tested without actually spawning Ghostty or
/// Terminal.app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
}

impl Invocation {
    fn new(program: &str, args: Vec<String>) -> Self {
        Self {
            program: program.to_string(),
            args,
        }
    }
}

fn ghostty_invocation(script_path: &str) -> Invocation {
    Invocation::new(
        "open",
        vec![
            "-na".into(),
            "Ghostty".into(),
            "--args".into(),
            "-e".into(),
            script_path.into(),
        ],
    )
}

fn terminal_invocation(script_path: &str) -> Invocation {
    // `do script "<string>"` is evaluated TWICE: AppleScript parses the
    // double-quoted string literal, then Terminal hands the resulting text
    // to a shell to run. So the path needs two layers of escaping: first
    // POSIX single-quoting for the shell layer, then AppleScript-string
    // escaping of that (already-quoted) text for the literal layer. Quoting
    // for the shell here is defense in depth on top of validate_session_id
    // rejecting anything but `[A-Za-z0-9_-]` ids upstream.
    let shell_quoted = format!("'{}'", shell_single_quote_escape(script_path));
    let escaped = applescript_string_escape(&shell_quoted);
    Invocation::new(
        "osascript",
        vec![
            "-e".into(),
            format!("tell application \"Terminal\" to do script \"{escaped}\"",),
            "-e".into(),
            "tell application \"Terminal\" to activate".into(),
        ],
    )
}

/// Runs `invocation` and reports whether it succeeded (spawned and exited
/// with a success status). Separated from the invocation-building logic
/// above so tests can build+assert on invocations without ever calling this.
fn run(invocation: &Invocation) -> Result<(), String> {
    std::process::Command::new(&invocation.program)
        .args(&invocation.args)
        .status()
        .map_err(|e| e.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "{} exited with status {status}",
                    invocation.program
                ))
            }
        })
}

/// Tries Ghostty first, falls back to Terminal.app on failure. `launch_via`
/// is injected so tests can observe which invocations would run without
/// actually spawning any process.
fn launch_via(
    script_path: &str,
    mut launch: impl FnMut(&Invocation) -> Result<(), String>,
) -> Result<PopOutApp, String> {
    let ghostty = ghostty_invocation(script_path);
    if launch(&ghostty).is_ok() {
        return Ok(PopOutApp::Ghostty);
    }

    let terminal = terminal_invocation(script_path);
    launch(&terminal).map(|()| PopOutApp::Terminal)
}

/// Outlasts PtyManager::kill's 5s SIGKILL escalation, so a stubborn process
/// always gets a chance to actually die before we give up.
const STOP_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
const STOP_POLL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// Bounded-polls `is_running` until it reports false, sleeping `interval`
/// between checks, up to `timeout` total. Two processes must never share a
/// session, so callers must not launch the external terminal until this
/// returns `Ok`.
fn poll_until_stopped(
    mut is_running: impl FnMut() -> bool,
    interval: std::time::Duration,
    timeout: std::time::Duration,
    sleep: impl Fn(std::time::Duration),
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !is_running() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err("session did not exit in time".to_string());
        }
        sleep(interval);
    }
}

fn write_script(dir: &Path, session_id: &str, contents: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{session_id}.sh"));
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(contents.as_bytes())
        .map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }

    Ok(path)
}

#[tauri::command]
pub fn pop_out_to_ghostty(
    app: AppHandle,
    manager: State<PtyManager>,
    session_index: State<SessionIndexState>,
    workspace: State<WorkspaceState>,
    external: State<ExternalSessions>,
    session_id: String,
) -> Result<PopOutResult, String> {
    validate_session_id(&session_id)?;

    let cwd = {
        let sessions = session_index.0.lock().unwrap_or_else(|e| e.into_inner());
        let meta = sessions
            .iter()
            .find(|s| s.id == session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        meta.cwd
            .clone()
            .ok_or_else(|| format!("session {session_id} has no known cwd"))?
    };

    // A session can never be driven by two processes at once: stop
    // agent-tarmac's own PTY (if any) before handing off to the external
    // terminal. Mirrors `stop_session` exactly rather than duplicating it.
    // kill() only sends SIGTERM and returns immediately, so we must poll
    // until the process has actually exited before launching a second
    // `claude --resume` on the same session — otherwise both processes race
    // to own the same transcript.
    if manager.is_running(&session_id) {
        manager.kill(&session_id)?;
        poll_until_stopped(
            || manager.is_running(&session_id),
            STOP_POLL_INTERVAL,
            STOP_POLL_TIMEOUT,
            std::thread::sleep,
        )?;
        workspace_store::remove_live_session(&app, &workspace, &session_id)?;
    }

    let pop_out_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pop_out");
    let script_contents = pop_out_script(&cwd, &session_id);
    let script_path = write_script(&pop_out_dir, &session_id, &script_contents)?;
    let script_path_str = script_path.to_string_lossy().to_string();

    let app_used = launch_via(&script_path_str, run)?;

    external.insert(&session_id);

    Ok(PopOutResult { app: app_used })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pop_out_script_contains_cwd_and_resume_id() {
        let script = pop_out_script("/Users/me/proj", "abc-123");
        assert!(
            script.contains("cd '/Users/me/proj'"),
            "script should cd into cwd, got: {script}"
        );
        assert!(
            script.contains("--resume 'abc-123'"),
            "script should resume by id, got: {script}"
        );
        assert!(script.starts_with("#!/bin/sh\n"));
    }

    #[test]
    fn pop_out_script_escapes_single_quotes_in_cwd() {
        let script = pop_out_script("/Users/me/it's a dir", "abc-123");
        assert!(
            script.contains("cd '/Users/me/it'\"'\"'s a dir'"),
            "single quote in cwd should be escaped via '\"'\"', got: {script}"
        );
    }

    #[test]
    fn pop_out_script_escapes_single_quotes_in_id() {
        let script = pop_out_script("/tmp", "weird'id");
        assert!(
            script.contains("--resume 'weird'\"'\"'id'"),
            "single quote in id should be escaped, got: {script}"
        );
    }

    #[test]
    fn ghostty_invocation_shape() {
        let inv = ghostty_invocation("/tmp/pop_out/abc.sh");
        assert_eq!(inv.program, "open");
        assert_eq!(
            inv.args,
            vec!["-na", "Ghostty", "--args", "-e", "/tmp/pop_out/abc.sh"]
        );
    }

    #[test]
    fn terminal_invocation_shape() {
        let inv = terminal_invocation("/tmp/pop_out/abc.sh");
        assert_eq!(inv.program, "osascript");
        assert!(inv.args.contains(&"-e".to_string()));
        let joined = inv.args.join(" ");
        // The path must be shell-single-quoted INSIDE the AppleScript
        // string, since Terminal hands the do-script text to a shell.
        assert!(joined.contains("do script \"'/tmp/pop_out/abc.sh'\""));
        assert!(joined.contains("tell application \"Terminal\" to activate"));
    }

    #[test]
    fn terminal_invocation_stays_inert_for_a_path_with_spaces_and_quotes() {
        // A defense-in-depth check: even if validate_session_id ever let a
        // hostile character through, the generated do-script text should
        // still treat the whole path as one inert shell argument at BOTH
        // the AppleScript-string layer and the shell layer Terminal applies
        // on top of it.
        let hostile = "/tmp/pop_out/x`touch /tmp/pwned`'.sh";
        let inv = terminal_invocation(hostile);
        let joined = inv.args.join(" ");
        // Shell layer: the whole path sits inside a single-quoted argument
        // (with the embedded `'` escaped via '"'"'), so a shell evaluating
        // the do-script text would treat it as literal text, not run it as
        // a command substitution.
        assert!(joined.contains("do script \"'/tmp/pop_out/x`touch /tmp/pwned`'\\\"'\\\"'.sh'\""));
    }

    #[test]
    fn validate_session_id_accepts_uuids_and_new_placeholders() {
        assert!(validate_session_id("f47ac10b-58cc-4372-a567-0e02b2c3d479").is_ok());
        assert!(validate_session_id("new-f47ac10b-58cc-4372-a567-0e02b2c3d479").is_ok());
        assert!(validate_session_id("abc_123").is_ok());
    }

    #[test]
    fn validate_session_id_rejects_shell_metacharacters() {
        assert!(validate_session_id("x`touch /tmp/pwned`").is_err());
        assert!(validate_session_id("x$(touch /tmp/pwned)").is_err());
        assert!(validate_session_id("has space").is_err());
        assert!(validate_session_id("").is_err());
    }

    #[test]
    fn launch_via_uses_ghostty_when_it_succeeds() {
        let mut calls: Vec<Invocation> = Vec::new();
        let result = launch_via("/tmp/script.sh", |inv| {
            calls.push(inv.clone());
            Ok(())
        });
        assert_eq!(result, Ok(PopOutApp::Ghostty));
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].program, "open");
    }

    #[test]
    fn launch_via_falls_back_to_terminal_when_ghostty_fails() {
        let mut calls: Vec<Invocation> = Vec::new();
        let result = launch_via("/tmp/script.sh", |inv| {
            let is_ghostty = inv.program == "open";
            calls.push(inv.clone());
            if is_ghostty {
                Err("ghostty not installed".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(result, Ok(PopOutApp::Terminal));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].program, "open");
        assert_eq!(calls[1].program, "osascript");
    }

    #[test]
    fn launch_via_errors_when_both_fail() {
        let result = launch_via("/tmp/script.sh", |_| Err("nope".into()));
        assert!(result.is_err());
    }

    #[test]
    fn write_script_creates_executable_file() {
        let dir = tempfile::tempdir().unwrap();
        let pop_out_dir = dir.path().join("pop_out");
        let path = write_script(&pop_out_dir, "sess-1", "#!/bin/sh\necho hi\n").unwrap();
        assert!(path.exists());
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "#!/bin/sh\necho hi\n");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "script should be executable");
        }
    }

    #[test]
    fn external_sessions_tracks_and_untracks() {
        let ext = ExternalSessions::default();
        assert!(!ext.contains("s1"));
        ext.insert("s1");
        assert!(ext.contains("s1"));
        ext.remove("s1");
        assert!(!ext.contains("s1"));
    }

    #[test]
    fn poll_until_stopped_returns_ok_once_is_running_goes_false() {
        // No real sleeping: the injected `sleep` just counts calls, so this
        // test is instant regardless of interval/timeout values.
        let mut remaining_true = 3;
        let sleeps = std::cell::RefCell::new(0);
        let result = poll_until_stopped(
            || {
                if remaining_true > 0 {
                    remaining_true -= 1;
                    true
                } else {
                    false
                }
            },
            std::time::Duration::from_millis(100),
            std::time::Duration::from_secs(6),
            |_| *sleeps.borrow_mut() += 1,
        );
        assert_eq!(result, Ok(()));
        assert_eq!(*sleeps.borrow(), 3);
    }

    #[test]
    fn poll_until_stopped_errors_if_still_running_past_timeout() {
        let mut calls = 0u32;
        let result = poll_until_stopped(
            || {
                calls += 1;
                true // never stops
            },
            std::time::Duration::from_millis(1),
            std::time::Duration::from_millis(5),
            |_| {}, // fake sleep: don't actually wait
        );
        assert!(result.is_err());
        assert!(calls > 0);
    }

    /// End-to-end with the real `fake-claude.sh` fixture (same one
    /// pty_integration.rs uses): kill a running session, then confirm
    /// poll_until_stopped observes PtyManager's own is_running draining to
    /// false within the polling window, using REAL sleeps at short
    /// intervals so the test stays fast.
    #[test]
    fn poll_until_stopped_drains_a_real_killed_session() {
        use crate::pty_manager::{PtyManager, SpawnSpec};

        let mgr = PtyManager::default();
        let script =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-claude.sh");
        mgr.spawn(
            |_| {},
            SpawnSpec {
                session_id: "pop-out-test".into(),
                cwd: std::env::temp_dir(),
                program: script.to_string_lossy().into(),
                args: vec!["--resume".into(), "pop-out-test".into()],
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        assert!(mgr.is_running("pop-out-test"));

        mgr.kill("pop-out-test").unwrap();

        let result = poll_until_stopped(
            || mgr.is_running("pop-out-test"),
            std::time::Duration::from_millis(50),
            std::time::Duration::from_secs(6),
            std::thread::sleep,
        );
        assert_eq!(result, Ok(()));
        assert!(!mgr.is_running("pop-out-test"));
    }
}
