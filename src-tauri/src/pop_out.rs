//! "Pop out to Ghostty" — hands a session off to an external terminal
//! process. If claude-deck owns a running PTY for the session, it's stopped
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
/// as opposed to under claude-deck's own PtyManager.
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
    let escaped = applescript_string_escape(script_path);
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
    // claude-deck's own PTY (if any) before handing off to the external
    // terminal. Mirrors `stop_session` exactly rather than duplicating it.
    if manager.is_running(&session_id) {
        manager.kill(&session_id)?;
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
        let script = pop_out_script("/Users/akshay/proj", "abc-123");
        assert!(
            script.contains("cd '/Users/akshay/proj'"),
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
        let script = pop_out_script("/Users/akshay/it's a dir", "abc-123");
        assert!(
            script.contains("cd '/Users/akshay/it'\"'\"'s a dir'"),
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
        assert!(joined.contains("do script \"/tmp/pop_out/abc.sh\""));
        assert!(joined.contains("tell application \"Terminal\" to activate"));
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
}
