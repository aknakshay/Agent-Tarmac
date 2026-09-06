//! "Pop out to Ghostty" — hands a session off to an external terminal
//! process. If agent-tarmac owns a running PTY for the session, it's stopped
//! first (two processes must never share a session). A small shell script is
//! written to disk and launched in Ghostty, falling back to Terminal.app if
//! Ghostty isn't installed. The session id is then tracked as "external" so
//! `status_loop` can keep showing it as running while its transcript is
//! still being written to.
//!
//! Platform note: the launch mechanics (which terminal binaries exist, and
//! how each one is invoked) are inherently OS-specific and live behind
//! `#[cfg(target_os = "...")]`. Everything else in this module — script
//! generation, the external-session tracking set, the stop/bring-back
//! lifecycle — is shared.

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

    /// Defense-in-depth guard for `bring_back_session`: only a session this
    /// app itself popped out (tracked here) may be SIGTERM'd back. Without
    /// this, the command would pgrep+kill by argv substring on the frontend's
    /// say-so alone — the same trust-nothing posture `pop_out_to_ghostty`
    /// takes with its `manager.is_running` check.
    pub fn ensure_tracked(&self, session_id: &str) -> Result<(), String> {
        if self.contains(session_id) {
            Ok(())
        } else {
            Err(format!(
                "session {session_id} is not tracked as external — nothing to bring back"
            ))
        }
    }
}

/// Which app ended up hosting the popped-out session — one of the keys in
/// [`TERMINAL_KEYS`] on macOS (plus `"terminal"` for Terminal.app), or one of
/// [`LINUX_TERMINAL_KEYS`] on Linux. A plain string so the frontend's label
/// map is the single place that knows display names.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PopOutResult {
    pub app: String,
}

/// Supported third-party terminals as `(key, .app bundle name)`. Terminal.app
/// is not listed — it ships with macOS and is always offered as the floor.
#[cfg(target_os = "macos")]
pub const TERMINAL_KEYS: &[(&str, &str)] = &[
    ("ghostty", "Ghostty"),
    ("iterm", "iTerm"),
    ("wezterm", "WezTerm"),
    ("kitty", "kitty"),
    ("alacritty", "Alacritty"),
];

/// Supported Linux terminal emulators as `(key, binary name)`, probed via
/// `PATH` rather than an `/Applications`-style bundle check. Listed in the
/// order they're tried when no terminal is explicitly requested. Unlike
/// macOS, there's no universally-installed floor terminal, so a system with
/// none of these on `PATH` simply has no pop-out option — see issue #13 for
/// the porting guide on adding more.
#[cfg(target_os = "linux")]
pub const LINUX_TERMINAL_KEYS: &[(&str, &str)] = &[
    ("gnome-terminal", "gnome-terminal"),
    ("konsole", "konsole"),
    ("xfce4-terminal", "xfce4-terminal"),
    ("kitty", "kitty"),
    ("alacritty", "alacritty"),
    ("wezterm", "wezterm"),
    ("foot", "foot"),
];

/// Returns the keys of installed terminals, in [`TERMINAL_KEYS`] priority
/// order, with `"terminal"` (always present on macOS) appended last. The
/// existence probe is injected so the ordering logic is testable without a
/// filesystem.
#[cfg(target_os = "macos")]
pub fn detect_installed_terminals(app_exists: impl Fn(&str) -> bool) -> Vec<String> {
    let mut found: Vec<String> = TERMINAL_KEYS
        .iter()
        .filter(|(_, bundle)| app_exists(bundle))
        .map(|(key, _)| (*key).to_string())
        .collect();
    found.push("terminal".to_string());
    found
}

/// Linux counterpart of [`detect_installed_terminals`]: returns the keys of
/// [`LINUX_TERMINAL_KEYS`] whose binary the injected probe finds, in priority
/// order. No unconditional floor entry is appended — there's no terminal
/// guaranteed to exist the way Terminal.app is on macOS.
#[cfg(target_os = "linux")]
pub fn detect_installed_terminals_linux(bin_exists: impl Fn(&str) -> bool) -> Vec<String> {
    LINUX_TERMINAL_KEYS
        .iter()
        .filter(|(_, bin)| bin_exists(bin))
        .map(|(key, _)| (*key).to_string())
        .collect()
}

/// True if `<name>.app` exists in /Applications or ~/Applications.
#[cfg(target_os = "macos")]
fn macos_app_exists(bundle: &str) -> bool {
    if Path::new(&format!("/Applications/{bundle}.app")).exists() {
        return true;
    }
    if let Ok(home) = std::env::var("HOME") {
        return Path::new(&format!("{home}/Applications/{bundle}.app")).exists();
    }
    false
}

/// True if an executable named `bin` exists in any directory on `PATH` — the
/// same lookup a shell does for a bare command name, reused here to probe for
/// terminal emulator binaries rather than `claude` (see
/// `claude_bin::resolve_claude_program` for that one).
#[cfg(target_os = "linux")]
fn binary_on_path(bin: &str) -> bool {
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path_var).any(|dir| dir.join(bin).is_file())
}

#[tauri::command]
pub fn detect_terminals() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        detect_installed_terminals(macos_app_exists)
    }
    #[cfg(target_os = "linux")]
    {
        detect_installed_terminals_linux(binary_on_path)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Vec::new()
    }
}

/// The currently-tracked external (popped-out) session ids — lets the
/// frontend restore its "Bring back" affordance after a relaunch, where the
/// panes' local popped-out state has reset but startup reconciliation found
/// the external processes still running.
#[tauri::command]
pub fn list_external_sessions(external: State<ExternalSessions>) -> Vec<String> {
    let guard = external.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.iter().cloned().collect()
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
#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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

/// iTerm2's `write text` — like Terminal's `do script` — hands the string to
/// a shell, so it gets the same two-layer escaping as `terminal_invocation`.
#[cfg(target_os = "macos")]
fn iterm_invocation(script_path: &str) -> Invocation {
    let shell_quoted = format!("'{}'", shell_single_quote_escape(script_path));
    let escaped = applescript_string_escape(&shell_quoted);
    Invocation::new(
        "osascript",
        vec![
            "-e".into(),
            "tell application \"iTerm\" to create window with default profile".into(),
            "-e".into(),
            format!(
                "tell current session of current window of application \"iTerm\" to write text \"{escaped}\""
            ),
            "-e".into(),
            "tell application \"iTerm\" to activate".into(),
        ],
    )
}

/// Builds the launch invocation for a specific terminal key (see
/// [`TERMINAL_KEYS`] + `"terminal"`). The `open -na <App> --args ...` forms
/// pass the script path as a plain argv element (no shell layer), so they
/// need no extra escaping; the two AppleScript-based terminals get the
/// two-layer treatment inside their builders.
#[cfg(target_os = "macos")]
pub fn invocation_for(terminal: &str, script_path: &str) -> Result<Invocation, String> {
    match terminal {
        "ghostty" => Ok(ghostty_invocation(script_path)),
        "terminal" => Ok(terminal_invocation(script_path)),
        "iterm" => Ok(iterm_invocation(script_path)),
        "wezterm" => Ok(Invocation::new(
            "open",
            vec![
                "-na".into(),
                "WezTerm".into(),
                "--args".into(),
                "start".into(),
                "--".into(),
                script_path.into(),
            ],
        )),
        "kitty" => Ok(Invocation::new(
            "open",
            vec![
                "-na".into(),
                "kitty".into(),
                "--args".into(),
                script_path.into(),
            ],
        )),
        "alacritty" => Ok(Invocation::new(
            "open",
            vec![
                "-na".into(),
                "Alacritty".into(),
                "--args".into(),
                "-e".into(),
                script_path.into(),
            ],
        )),
        other => Err(format!("unsupported terminal: {other}")),
    }
}

/// Linux counterpart of [`invocation_for`]. Each of these launches the
/// terminal binary directly (no `open`-style app-bundle indirection), passing
/// the pop-out script as the command to run. Verified against each emulator's
/// CLI contract at the time of writing; if a given install's flag dialect has
/// since drifted, that's exactly the kind of thing issue #13 is tracking.
#[cfg(target_os = "linux")]
pub fn invocation_for_linux(terminal: &str, script_path: &str) -> Result<Invocation, String> {
    match terminal {
        "gnome-terminal" => Ok(Invocation::new(
            "gnome-terminal",
            vec!["--".into(), script_path.into()],
        )),
        "konsole" => Ok(Invocation::new(
            "konsole",
            vec!["-e".into(), script_path.into()],
        )),
        "xfce4-terminal" => Ok(Invocation::new(
            "xfce4-terminal",
            vec!["-e".into(), script_path.into()],
        )),
        "kitty" => Ok(Invocation::new("kitty", vec![script_path.into()])),
        "alacritty" => Ok(Invocation::new(
            "alacritty",
            vec!["-e".into(), script_path.into()],
        )),
        "wezterm" => Ok(Invocation::new(
            "wezterm",
            vec!["start".into(), "--".into(), script_path.into()],
        )),
        "foot" => Ok(Invocation::new("foot", vec![script_path.into()])),
        other => Err(format!(
            "unsupported terminal on Linux: {other} — see issue #13"
        )),
    }
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
#[cfg(target_os = "macos")]
fn launch_via(
    script_path: &str,
    mut launch: impl FnMut(&Invocation) -> Result<(), String>,
) -> Result<String, String> {
    let ghostty = ghostty_invocation(script_path);
    if launch(&ghostty).is_ok() {
        return Ok("ghostty".to_string());
    }

    let terminal = terminal_invocation(script_path);
    launch(&terminal).map(|()| "terminal".to_string())
}

/// Linux counterpart of [`launch_via`]: tries every [`LINUX_TERMINAL_KEYS`]
/// entry in priority order, returning the first that launches successfully.
/// Unlike macOS there's no guaranteed floor, so exhausting the list is a
/// real (if unusual) failure mode — surfaced with a pointer to issue #13.
#[cfg(target_os = "linux")]
fn launch_via_linux(
    script_path: &str,
    mut launch: impl FnMut(&Invocation) -> Result<(), String>,
) -> Result<String, String> {
    for (key, _) in LINUX_TERMINAL_KEYS {
        let Ok(invocation) = invocation_for_linux(key, script_path) else {
            continue;
        };
        if launch(&invocation).is_ok() {
            return Ok((*key).to_string());
        }
    }
    Err("no supported terminal found on this system — see issue #13".to_string())
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

/// Parses `pgrep` stdout (one pid per line) into a `Vec<u32>`. Lines that
/// don't parse as u32 are silently skipped (e.g. a trailing newline). Returns
/// an empty vec when no processes match.
pub fn parse_pids(output: &str) -> Vec<u32> {
    output
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

/// Runs `pgrep -f "claude --resume <session_id>"` and returns the matching
/// pids. An empty list means the session is not currently running externally.
fn find_external_pids(session_id: &str) -> Vec<u32> {
    let pattern = format!("claude --resume {session_id}");
    let output = std::process::Command::new("pgrep")
        .arg("-f")
        .arg(&pattern)
        .output();
    match output {
        Ok(out) => parse_pids(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => vec![],
    }
}

/// Sends SIGTERM to a single pid. Returns an error string if `kill(2)` fails.
#[cfg(unix)]
fn sigterm_pid(pid: u32) -> Result<(), String> {
    let ret = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if ret == 0 {
        Ok(())
    } else {
        Err(format!(
            "kill({pid}, SIGTERM) failed: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[tauri::command]
pub fn pop_out_to_ghostty(
    app: AppHandle,
    manager: State<PtyManager>,
    session_index: State<SessionIndexState>,
    workspace: State<WorkspaceState>,
    external: State<ExternalSessions>,
    session_id: String,
    terminal: Option<String>,
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

    // An explicitly chosen terminal launches exactly that terminal (no
    // fallback — a user who picked WezTerm should get an error, not
    // Terminal.app). No choice keeps the historical Ghostty→Terminal chain
    // on macOS, or tries every detected terminal in order on Linux.
    let app_used = match terminal.as_deref() {
        Some(key) => {
            #[cfg(target_os = "macos")]
            let invocation = invocation_for(key, &script_path_str)?;
            #[cfg(target_os = "linux")]
            let invocation = invocation_for_linux(key, &script_path_str)?;
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            let invocation: Invocation = return Err(format!(
                "pop-out is not supported on this platform — see issue #13"
            ));
            run(&invocation)?;
            key.to_string()
        }
        None => {
            #[cfg(target_os = "macos")]
            {
                launch_via(&script_path_str, run)?
            }
            #[cfg(target_os = "linux")]
            {
                launch_via_linux(&script_path_str, run)?
            }
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            {
                return Err("pop-out is not supported on this platform — see issue #13".to_string());
            }
        }
    };

    external.insert(&session_id);
    // Persisted so a relaunch remembers this session lives in an external
    // terminal (startup reconciles the list against real pgrep results).
    workspace_store::set_external_session(&app, &workspace, &session_id, true)?;

    Ok(PopOutResult { app: app_used })
}

/// Startup reconciliation for the persisted external set: a session that
/// still has a live external `claude --resume` process stays tracked (so the
/// sidebar shows it running and resume-in-app is blocked from double-writing
/// its transcript); one whose process is gone is dropped from the workspace.
pub fn reconcile_external_on_startup(app: &AppHandle) {
    let Some(workspace) = app.try_state::<WorkspaceState>() else {
        return;
    };
    let Some(external) = app.try_state::<ExternalSessions>() else {
        return;
    };
    let persisted: Vec<String> = {
        let guard = workspace.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.external_session_ids.clone()
    };
    for id in persisted {
        // Ids reaching the workspace passed validate_session_id at pop-out
        // time, but re-validate before handing anything to pgrep anyway.
        let still_running = validate_session_id(&id).is_ok() && !find_external_pids(&id).is_empty();
        if still_running {
            external.insert(&id);
        } else if let Err(err) = workspace_store::set_external_session(app, &workspace, &id, false)
        {
            eprintln!("failed to drop stale external session {id}: {err}");
        }
    }
}

/// Outcome of `bring_back_session`: the session either had an active external
/// process (which was SIGTERM'd and waited out) or was already gone (the
/// frontend can just call `resume_session` directly).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BringBackOutcome {
    /// External claude process was found, SIGTERM'd, and confirmed stopped.
    Stopped,
    /// No external claude process was found; session can be resumed immediately.
    NotRunning,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BringBackResult {
    pub outcome: BringBackOutcome,
}

/// Brings a popped-out session back into agent-tarmac:
/// 1. Validates the session id, and refuses ids not tracked in
///    `ExternalSessions` (only sessions this app popped out may be killed).
/// 2. Finds any external `claude --resume <id>` processes via `pgrep -f`.
/// 3. SIGTERMs each found pid (plain SIGTERM to the pid; NOT killpg).
/// 4. Polls until `pgrep` finds no more matching pids (reusing `poll_until_stopped`).
/// 5. Removes the id from `ExternalSessions` so the frontend can resume normally.
///
/// Returns `Ok(BringBackResult { outcome: NotRunning })` when no external
/// process was found — the frontend should still call `resume_session`.
///
/// Returns `Err` on timeout ("external session didn't exit — close it in
/// Ghostty first") or if SIGTERM itself fails.
#[tauri::command]
pub fn bring_back_session(
    app: AppHandle,
    workspace: State<WorkspaceState>,
    external: State<ExternalSessions>,
    session_id: String,
) -> Result<BringBackResult, String> {
    validate_session_id(&session_id)?;
    external.ensure_tracked(&session_id)?;

    let pids = find_external_pids(&session_id);

    if pids.is_empty() {
        external.remove(&session_id);
        let _ = workspace_store::set_external_session(&app, &workspace, &session_id, false);
        return Ok(BringBackResult {
            outcome: BringBackOutcome::NotRunning,
        });
    }

    // SIGTERM each matching pid.
    #[cfg(unix)]
    for pid in &pids {
        // A pid that has already exited between pgrep and now is fine to
        // ignore: ESRCH (no such process) just means it's already gone.
        if let Err(e) = sigterm_pid(*pid) {
            // Only hard-fail on unexpected errors, not "already gone".
            if !e.contains("No such process") {
                return Err(e);
            }
        }
    }

    // Poll until pgrep finds no more matches.
    poll_until_stopped(
        || !find_external_pids(&session_id).is_empty(),
        STOP_POLL_INTERVAL,
        STOP_POLL_TIMEOUT,
        std::thread::sleep,
    )
    .map_err(|_| "external session didn't exit — close it in Ghostty first".to_string())?;

    external.remove(&session_id);
    let _ = workspace_store::set_external_session(&app, &workspace, &session_id, false);

    Ok(BringBackResult {
        outcome: BringBackOutcome::Stopped,
    })
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
    fn ensure_tracked_rejects_untracked_and_accepts_tracked() {
        // The bring_back_session guard: an id never popped out must be
        // refused before any pgrep/SIGTERM happens; a tracked one passes,
        // and passes no longer once removed.
        let ext = ExternalSessions::default();
        let err = ext.ensure_tracked("s1").unwrap_err();
        assert!(
            err.contains("not tracked as external"),
            "unexpected error message: {err}"
        );
        ext.insert("s1");
        assert_eq!(ext.ensure_tracked("s1"), Ok(()));
        ext.remove("s1");
        assert!(ext.ensure_tracked("s1").is_err());
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

    // ── bring_back_session pure-logic tests ──────────────────────────────────

    #[test]
    fn parse_pids_parses_one_per_line() {
        let output = "1234\n5678\n";
        assert_eq!(parse_pids(output), vec![1234u32, 5678u32]);
    }

    #[test]
    fn parse_pids_skips_blank_lines() {
        let output = "42\n\n99\n";
        assert_eq!(parse_pids(output), vec![42u32, 99u32]);
    }

    #[test]
    fn parse_pids_returns_empty_for_empty_output() {
        assert_eq!(parse_pids(""), Vec::<u32>::new());
    }

    #[test]
    fn parse_pids_skips_non_numeric_lines() {
        // pgrep -f can occasionally return a header on some platforms.
        let output = "PID\n1234\n";
        assert_eq!(parse_pids(output), vec![1234u32]);
    }

    /// When no external process exists (empty pids), bring_back logic via
    /// injected poll: should immediately return NotRunning.
    #[test]
    fn bring_back_logic_not_running_when_no_pids() {
        // Simulate: pgrep finds nothing → poll sees "not running" immediately.
        let mut poll_calls = 0u32;
        let result = poll_until_stopped(
            || {
                poll_calls += 1;
                false // already stopped
            },
            std::time::Duration::from_millis(100),
            std::time::Duration::from_secs(6),
            |_| {},
        );
        assert_eq!(result, Ok(()));
        // The first check returned false immediately → 0 sleeps, 1 poll call.
        assert_eq!(poll_calls, 1);
    }

    /// When an external process is running, poll_until_stopped eventually
    /// drains it — using the same injected pattern as the existing tests.
    #[test]
    fn bring_back_logic_waits_for_pids_to_drain() {
        let mut remaining = 2u32;
        let sleeps = std::cell::RefCell::new(0u32);
        let result = poll_until_stopped(
            || {
                if remaining > 0 {
                    remaining -= 1;
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
        assert_eq!(*sleeps.borrow(), 2);
    }

    #[test]
    fn bring_back_logic_times_out_when_pids_never_drain() {
        let result = poll_until_stopped(
            || true, // never clears
            std::time::Duration::from_millis(1),
            std::time::Duration::from_millis(5),
            |_| {},
        );
        assert!(result.is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;

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
    fn launch_via_uses_ghostty_when_it_succeeds() {
        let mut calls: Vec<Invocation> = Vec::new();
        let result = launch_via("/tmp/script.sh", |inv| {
            calls.push(inv.clone());
            Ok(())
        });
        assert_eq!(result, Ok("ghostty".to_string()));
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
        assert_eq!(result, Ok("terminal".to_string()));
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
    fn detect_installed_terminals_orders_and_always_includes_terminal() {
        // Only kitty + Ghostty "installed": priority order preserved,
        // Terminal.app appended last unconditionally.
        let found = detect_installed_terminals(|b| b == "kitty" || b == "Ghostty");
        assert_eq!(found, vec!["ghostty", "kitty", "terminal"]);

        // Nothing installed: Terminal.app is still the floor.
        let none = detect_installed_terminals(|_| false);
        assert_eq!(none, vec!["terminal"]);
    }

    #[test]
    fn invocation_for_covers_every_supported_key() {
        for (key, _) in TERMINAL_KEYS {
            assert!(invocation_for(key, "/tmp/s.sh").is_ok(), "key {key}");
        }
        assert!(invocation_for("terminal", "/tmp/s.sh").is_ok());
        assert!(invocation_for("emacs-shell", "/tmp/s.sh").is_err());
    }

    #[test]
    fn wezterm_and_kitty_pass_script_as_plain_argv() {
        // `open --args` forms carry the path as an argv element — no shell
        // layer, so a hostile-looking path must appear verbatim, unescaped.
        let hostile = "/tmp/it's a `dir`/s.sh";
        let wez = invocation_for("wezterm", hostile).unwrap();
        assert_eq!(wez.program, "open");
        assert_eq!(wez.args.last().unwrap(), hostile);
        let kitty = invocation_for("kitty", hostile).unwrap();
        assert_eq!(kitty.args.last().unwrap(), hostile);
    }

    #[test]
    fn iterm_invocation_stays_inert_for_a_path_with_spaces_and_quotes() {
        // Same double-layer contract as terminal_invocation: shell-quoted
        // innermost, then AppleScript-escaped.
        let inv = invocation_for("iterm", "/tmp/it's a `dir`/s.sh").unwrap();
        assert_eq!(inv.program, "osascript");
        let write_text = inv
            .args
            .iter()
            .find(|a| a.contains("write text"))
            .expect("write text arg present");
        assert!(
            write_text.contains("'\\\"'\\\"'"),
            "single-quote escape survives both layers: {write_text}"
        );
        assert!(
            !write_text.contains("write text \"/tmp"),
            "path must not be bare in the shell layer"
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;

    #[test]
    fn detect_installed_terminals_linux_orders_and_has_no_floor() {
        let found = detect_installed_terminals_linux(|b| b == "kitty" || b == "gnome-terminal");
        assert_eq!(found, vec!["gnome-terminal", "kitty"]);

        // Unlike macOS, nothing installed means no options at all.
        let none = detect_installed_terminals_linux(|_| false);
        assert!(none.is_empty());
    }

    #[test]
    fn invocation_for_linux_covers_every_supported_key() {
        for (key, _) in LINUX_TERMINAL_KEYS {
            assert!(invocation_for_linux(key, "/tmp/s.sh").is_ok(), "key {key}");
        }
        assert!(invocation_for_linux("emacs-shell", "/tmp/s.sh").is_err());
    }

    #[test]
    fn gnome_terminal_and_konsole_pass_script_as_plain_argv() {
        // Direct-exec launches carry the path as an argv element — no shell
        // layer, so a hostile-looking path must appear verbatim, unescaped.
        let hostile = "/tmp/it's a `dir`/s.sh";
        let gnome = invocation_for_linux("gnome-terminal", hostile).unwrap();
        assert_eq!(gnome.program, "gnome-terminal");
        assert_eq!(gnome.args.last().unwrap(), hostile);

        let konsole = invocation_for_linux("konsole", hostile).unwrap();
        assert_eq!(konsole.program, "konsole");
        assert_eq!(konsole.args.last().unwrap(), hostile);
    }

    #[test]
    fn launch_via_linux_uses_first_success_in_priority_order() {
        let mut calls: Vec<String> = Vec::new();
        let result = launch_via_linux("/tmp/script.sh", |inv| {
            calls.push(inv.program.clone());
            if inv.program == "gnome-terminal" {
                Err("not installed".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(result, Ok("konsole".to_string()));
        assert_eq!(calls, vec!["gnome-terminal", "konsole"]);
    }

    #[test]
    fn launch_via_linux_errors_with_issue_pointer_when_all_fail() {
        let result = launch_via_linux("/tmp/script.sh", |_| Err("nope".into()));
        let err = result.unwrap_err();
        assert!(err.contains("issue #13"), "unexpected error: {err}");
    }
}
