//! Resolves the executable to invoke for `claude`.
//!
//! macOS GUI apps launched from Finder inherit only the bare system PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's login-shell PATH. On a
//! typical dev machine `claude` lives under `~/.local/bin` or
//! `/opt/homebrew/bin`, neither of which is on that bare PATH, so a naive
//! `CommandBuilder::new("claude")` fails to spawn once the app is launched
//! as a bundled `.app` rather than from a terminal. This module finds the
//! real path once, in priority order, and every spawn site reuses the
//! cached result.
//!
//! It also exposes [`login_shell_env`] and [`pty_env_overrides`] for
//! hydrating the PTY child environment from the user's login shell so that
//! the embedded terminal behaves exactly like the user's normal terminal
//! (hooks that call `node`, nvm shims, colors, locale) when the app is
//! Finder-launched with a bare GUI environment.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

const BIN_NAME: &str = "claude";

// ---------------------------------------------------------------------------
// Login-shell environment hydration
// ---------------------------------------------------------------------------

/// Parse lines from `/bin/zsh -lc 'env'` output into a `KEY=value` map.
///
/// Rules (defensive):
/// - Split on the *first* `=` only so values that themselves contain `=` are
///   preserved intact.
/// - Skip any line that has no `=` (continuation lines from multi-line values
///   or blank separators).
/// - Skip lines whose key is empty.
pub fn parse_env_output(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in raw.lines() {
        if let Some(eq) = line.find('=') {
            let key = &line[..eq];
            let val = &line[eq + 1..];
            if !key.is_empty() {
                map.insert(key.to_string(), val.to_string());
            }
        }
        // no '=' -> skip (continuation / blank)
    }
    map
}

/// Run `/bin/zsh -lc 'env'` once, bounded by `timeout`, and return the
/// parsed environment. Returns an empty map on timeout or exec failure.
fn fetch_login_shell_env(timeout: Duration) -> HashMap<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new("/bin/zsh")
            .args(["-lc", "env"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        // Ignore send errors: the receiver may have already timed out and
        // dropped, which is fine -- there's nothing left to deliver to.
        let _ = tx.send(result);
    });
    let raw = rx.recv_timeout(timeout).unwrap_or_default();
    parse_env_output(&raw)
}

static LOGIN_SHELL_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// The login shell's environment, fetched once and cached for the process
/// lifetime.
pub fn login_shell_env() -> &'static HashMap<String, String> {
    LOGIN_SHELL_ENV.get_or_init(|| fetch_login_shell_env(Duration::from_secs(5)))
}

/// Given the login-shell env map (injected for testability), return the env
/// vars to apply to a PTY `CommandBuilder` before spawning.
///
/// Policy: the embedded terminal should behave exactly like the user's normal
/// terminal, so the ENTIRE login-shell environment is applied over whatever
/// the (possibly bare, Finder-launched) process inherited. On top of that:
/// - `TERM=xterm-256color` and `COLORTERM=truecolor` are ALWAYS forced --
///   xterm.js is a full-color terminal regardless of what the login shell or
///   GUI process thought.
/// - `LANG` defaults to `en_US.UTF-8` only if the login env lacks it, so
///   box-drawing renders correctly even on machines with no locale config.
///
/// Vars the process inherited that the login env does not mention are left
/// untouched (this function only returns overrides to apply, not a
/// replacement environment).
pub fn pty_env_overrides(login: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out = login.clone();

    // Always-forced terminal capabilities.
    out.insert("TERM".to_string(), "xterm-256color".to_string());
    out.insert("COLORTERM".to_string(), "truecolor".to_string());

    // Locale -- default only when the login env lacks it.
    out.entry("LANG".to_string())
        .or_insert_with(|| "en_US.UTF-8".to_string());

    out
}

// ---------------------------------------------------------------------------
// Claude binary resolution
// ---------------------------------------------------------------------------

/// Resolution priority, in order:
/// 1. `env_override` (the `AGENT_TARMAC_CLAUDE_BIN` env var) -- used verbatim,
///    no further probing, so an explicit override is never second-guessed.
/// 2. `path_probe` -- `claude` resolves against the process's own `PATH`.
/// 3. `shell_probe` -- a login shell's `PATH` finds it (covers the GUI-launch
///    case: the bare system PATH the process inherited doesn't have it, but
///    the user's shell config would).
/// 4. `fallback_exists` -- the first of `fallback_dirs` that exists and is
///    executable, for machines where none of the above apply (e.g. `PATH` is
///    set inside a shell config file the login-shell probe doesn't source).
/// 5. `"claude"` unchanged -- resolution failed; the caller's spawn attempt
///    will fail with the same not-found error a shell would raise, and that
///    error is improved by [`spawn_error_hint`] rather than here.
///
/// Probes are injected (rather than called directly) so this priority order
/// is table-testable without touching the real filesystem or shelling out.
pub fn resolve_claude_program(
    env_override: Option<String>,
    path_probe: impl FnOnce() -> Option<String>,
    shell_probe: impl FnOnce() -> Option<String>,
    fallback_exists: impl Fn(&str) -> bool,
    fallback_paths: &[String],
) -> String {
    if let Some(v) = env_override {
        return v;
    }
    if let Some(p) = path_probe() {
        return p;
    }
    if let Some(p) = shell_probe() {
        return p;
    }
    for candidate in fallback_paths {
        if fallback_exists(candidate) {
            return candidate.clone();
        }
    }
    BIN_NAME.to_string()
}

/// True if `path` exists and has at least one executable bit set (unix).
/// On non-unix, existence alone is treated as executable.
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Searches the process's own `PATH` env var for an executable `claude`,
/// the same lookup a shell does for a bare command name.
fn probe_current_path() -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(BIN_NAME);
        if is_executable_file(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// Runs `/bin/zsh -lc 'command -v claude'` to ask the user's login shell
/// (which sources their profile/rc files, unlike a bare-PATH GUI process)
/// where `claude` lives. Bounded by a timeout so a hung shell never blocks
/// startup indefinitely.
fn probe_login_shell(timeout: Duration) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new("/bin/zsh")
            .args(["-lc", "command -v claude"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        // Ignore send errors: the receiver may have already timed out and
        // dropped, which is fine -- there's nothing left to deliver to.
        let _ = tx.send(result);
    });
    rx.recv_timeout(timeout).ok().flatten().filter(|path| {
        // `command -v` can print a shell function/alias name rather than a
        // path (e.g. if `claude` is aliased); only trust it if it resolves
        // to a real executable file.
        is_executable_file(Path::new(path))
    })
}

/// Well-known install locations, in priority order, checked when neither
/// the current process PATH nor a login shell can find `claude`.
fn well_known_fallback_dirs() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    [
        format!("{home}/.local/bin/{BIN_NAME}"),
        format!("/opt/homebrew/bin/{BIN_NAME}"),
        format!("/usr/local/bin/{BIN_NAME}"),
        format!("{home}/bin/{BIN_NAME}"),
    ]
    .into_iter()
    .filter(|p| !p.starts_with('/') || !p.contains("//")) // drop malformed entries if HOME was empty
    .collect()
}

static RESOLVED_CLAUDE_PROGRAM: OnceLock<String> = OnceLock::new();

/// The path (or bare name, as a last resort) to invoke for `claude`.
/// Resolved once on first call and cached for the life of the process -- see
/// [`resolve_claude_program`] for the priority order. Also honors the
/// `AGENT_TARMAC_CLAUDE_BIN` override.
pub fn claude_program() -> String {
    RESOLVED_CLAUDE_PROGRAM
        .get_or_init(|| {
            resolve_claude_program(
                std::env::var("AGENT_TARMAC_CLAUDE_BIN").ok(),
                probe_current_path,
                || probe_login_shell(Duration::from_secs(5)),
                |p| is_executable_file(Path::new(p)),
                &well_known_fallback_dirs(),
            )
        })
        .clone()
}

/// True if `resolved` is exactly the unresolved bare name -- i.e. every probe
/// in [`claude_program`] failed and a spawn using it is expected to fail the
/// same way a shell's "command not found" would. Used to append a more
/// useful hint to that failure.
pub fn is_unresolved(resolved: &str) -> bool {
    resolved == BIN_NAME
}

/// Appends an actionable hint to a spawn-failure message when `program` is
/// the unresolved bare "claude" -- i.e. resolution in [`claude_program`]
/// exhausted every probe. Leaves other errors (e.g. a resolved path that
/// still failed to spawn for some other reason) untouched.
pub fn spawn_error_hint(program: &str, base_error: String) -> String {
    if is_unresolved(program) {
        format!(
            "{base_error} -- claude wasn't found on the app's PATH; install \
             Claude Code, or set AGENT_TARMAC_CLAUDE_BIN to its full path."
        )
    } else {
        base_error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- env parsing -----

    #[test]
    fn parse_env_output_basic_key_value() {
        let raw = "HOME=/Users/alice\nPATH=/usr/bin:/bin\nTERM=xterm-256color\n";
        let map = parse_env_output(raw);
        assert_eq!(map["HOME"], "/Users/alice");
        assert_eq!(map["PATH"], "/usr/bin:/bin");
        assert_eq!(map["TERM"], "xterm-256color");
    }

    #[test]
    fn parse_env_output_value_contains_equals() {
        // Values like LS_COLORS="rs=0:di=01;34:..." have many '=' chars.
        let raw = "LS_COLORS=rs=0:di=01;34\nFOO=bar=baz=qux\n";
        let map = parse_env_output(raw);
        assert_eq!(map["LS_COLORS"], "rs=0:di=01;34");
        assert_eq!(map["FOO"], "bar=baz=qux");
    }

    #[test]
    fn parse_env_output_skips_lines_without_equals() {
        let raw = "GOOD=value\nno-equals-here\nANOTHER=ok\n";
        let map = parse_env_output(raw);
        assert!(!map.contains_key("no-equals-here"));
        assert_eq!(map["GOOD"], "value");
        assert_eq!(map["ANOTHER"], "ok");
    }

    #[test]
    fn parse_env_output_skips_empty_key() {
        // A line starting with '=' has an empty key -- skip it.
        let raw = "=bad\nGOOD=value\n";
        let map = parse_env_output(raw);
        assert!(!map.contains_key(""));
        assert_eq!(map["GOOD"], "value");
    }

    #[test]
    fn parse_env_output_empty_value_allowed() {
        let raw = "EMPTY=\nNORMAL=hi\n";
        let map = parse_env_output(raw);
        assert_eq!(map["EMPTY"], "");
        assert_eq!(map["NORMAL"], "hi");
    }

    // ----- pty_env_overrides merge policy -----

    #[test]
    fn pty_env_overrides_applies_full_login_env() {
        // The entire login env is carried over -- the embedded terminal
        // should behave exactly like the user's normal terminal.
        let mut login = HashMap::new();
        login.insert("PATH".to_string(), "/opt/homebrew/bin:/usr/bin".to_string());
        login.insert("NVM_DIR".to_string(), "/Users/alice/.nvm".to_string());
        login.insert("SSH_AUTH_SOCK".to_string(), "/tmp/agent.sock".to_string());
        login.insert("HOME".to_string(), "/Users/alice".to_string());
        let overrides = pty_env_overrides(&login);
        assert_eq!(overrides["PATH"], "/opt/homebrew/bin:/usr/bin");
        assert_eq!(overrides["NVM_DIR"], "/Users/alice/.nvm");
        assert_eq!(overrides["SSH_AUTH_SOCK"], "/tmp/agent.sock");
        assert_eq!(overrides["HOME"], "/Users/alice");
    }

    #[test]
    fn pty_env_overrides_term_colorterm_always_forced() {
        // Even when the login shell had a different TERM, we always force
        // xterm-256color/truecolor -- xterm.js is the real terminal here.
        let mut login = HashMap::new();
        login.insert("TERM".to_string(), "dumb".to_string());
        login.insert("COLORTERM".to_string(), "".to_string());
        let overrides = pty_env_overrides(&login);
        assert_eq!(overrides["TERM"], "xterm-256color");
        assert_eq!(overrides["COLORTERM"], "truecolor");

        // And when the login env is empty they're still set.
        let empty: HashMap<String, String> = HashMap::new();
        let overrides2 = pty_env_overrides(&empty);
        assert_eq!(overrides2["TERM"], "xterm-256color");
        assert_eq!(overrides2["COLORTERM"], "truecolor");
    }

    #[test]
    fn pty_env_overrides_lang_defaults_when_absent() {
        let login: HashMap<String, String> = HashMap::new();
        let overrides = pty_env_overrides(&login);
        assert_eq!(overrides["LANG"], "en_US.UTF-8");
    }

    #[test]
    fn pty_env_overrides_lang_from_login_when_present() {
        let mut login = HashMap::new();
        login.insert("LANG".to_string(), "en_GB.UTF-8".to_string());
        let overrides = pty_env_overrides(&login);
        assert_eq!(overrides["LANG"], "en_GB.UTF-8");
    }

    #[test]
    fn pty_env_overrides_leaves_inherited_only_vars_untouched() {
        // The function returns only overrides to apply on top of the
        // inherited env; a var the login env doesn't mention must not appear
        // (so the child keeps whatever it inherited for it).
        let mut login = HashMap::new();
        login.insert("PATH".to_string(), "/usr/bin".to_string());
        let overrides = pty_env_overrides(&login);
        assert!(!overrides.contains_key("XPC_SERVICE_NAME"));
        assert!(!overrides.contains_key("TMPDIR"));
    }

    // ----- claude binary resolution -----

    #[test]
    fn env_override_wins_unconditionally() {
        let result = resolve_claude_program(
            Some("/custom/claude".to_string()),
            || panic!("path_probe should not run when env override is set"),
            || panic!("shell_probe should not run when env override is set"),
            |_| panic!("fallback_exists should not run when env override is set"),
            &["/should/not/be/used".to_string()],
        );
        assert_eq!(result, "/custom/claude");
    }

    #[test]
    fn path_probe_wins_over_shell_and_fallback() {
        let result = resolve_claude_program(
            None,
            || Some("/from/path/claude".to_string()),
            || panic!("shell_probe should not run when path_probe succeeds"),
            |_| panic!("fallback_exists should not run when path_probe succeeds"),
            &["/should/not/be/used".to_string()],
        );
        assert_eq!(result, "/from/path/claude");
    }

    #[test]
    fn shell_probe_wins_when_path_probe_fails() {
        let result = resolve_claude_program(
            None,
            || None,
            || Some("/from/shell/claude".to_string()),
            |_| panic!("fallback_exists should not run when shell_probe succeeds"),
            &["/should/not/be/used".to_string()],
        );
        assert_eq!(result, "/from/shell/claude");
    }

    #[test]
    fn fallback_used_when_path_and_shell_probes_fail() {
        let fallbacks = vec![
            "/nope/claude".to_string(),
            "/also/nope/claude".to_string(),
            "/yes/claude".to_string(),
        ];
        let result =
            resolve_claude_program(None, || None, || None, |p| p == "/yes/claude", &fallbacks);
        assert_eq!(result, "/yes/claude");
    }

    #[test]
    fn fallback_order_is_respected() {
        // Both the first and third fallback "exist" -- the first must win.
        let fallbacks = vec![
            "/first/claude".to_string(),
            "/second/claude".to_string(),
            "/third/claude".to_string(),
        ];
        let result = resolve_claude_program(
            None,
            || None,
            || None,
            |p| p == "/first/claude" || p == "/third/claude",
            &fallbacks,
        );
        assert_eq!(result, "/first/claude");
    }

    #[test]
    fn bare_name_returned_when_everything_fails() {
        let result = resolve_claude_program(None, || None, || None, |_| false, &[]);
        assert_eq!(result, "claude");
    }

    #[test]
    fn is_unresolved_matches_bare_name_only() {
        assert!(is_unresolved("claude"));
        assert!(!is_unresolved("/opt/homebrew/bin/claude"));
    }

    #[test]
    fn spawn_error_hint_appends_only_for_unresolved() {
        let hinted = spawn_error_hint("claude", "boom".to_string());
        assert!(hinted.contains("boom"));
        assert!(hinted.contains("AGENT_TARMAC_CLAUDE_BIN"));

        let untouched = spawn_error_hint("/opt/homebrew/bin/claude", "boom".to_string());
        assert_eq!(untouched, "boom");
    }

    #[test]
    fn is_executable_file_rejects_directories_and_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_executable_file(dir.path()));
        assert!(!is_executable_file(&dir.path().join("does-not-exist")));
    }

    #[cfg(unix)]
    #[test]
    fn is_executable_file_requires_executable_bit() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-executable");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"#!/bin/sh\n")
            .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_executable_file(&path));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable_file(&path));
    }
}
