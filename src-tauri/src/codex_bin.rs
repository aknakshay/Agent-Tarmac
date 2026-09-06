//! Resolves the executable to invoke for `codex` — the Codex analog of
//! [`crate::claude_bin`]. Same GUI-launch problem (a Finder-launched `.app`
//! inherits only the bare system PATH, not the user's login-shell PATH), so
//! the same probe ladder: explicit override, process PATH, login-shell PATH,
//! well-known install dirs, then the bare name as a last resort.
//!
//! This is a thin, self-contained mirror rather than a refactor of
//! `claude_bin` (kept isolated so it doesn't disturb the Claude seam's tests).
//! The login-shell *environment hydration* for the PTY child
//! ([`crate::claude_bin::login_shell_env`] / `pty_env_overrides`) is backend
//! agnostic and reused as-is by the spawn layer; only binary *resolution* is
//! duplicated here with `BIN_NAME = "codex"`.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

const BIN_NAME: &str = "codex";

#[cfg(target_os = "macos")]
const DEFAULT_LOGIN_SHELL: &str = "/bin/zsh";
#[cfg(not(target_os = "macos"))]
const DEFAULT_LOGIN_SHELL: &str = "/bin/bash";

fn login_shell_path() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| DEFAULT_LOGIN_SHELL.to_string())
}

/// Resolution priority (mirrors [`crate::claude_bin::resolve_claude_program`],
/// but the final fallback is the bare `codex`):
/// 1. `env_override` (`AGENT_TARMAC_CODEX_BIN`) — verbatim, never second-guessed.
/// 2. `path_probe` — `codex` on the process's own `PATH`.
/// 3. `shell_probe` — a login shell's `PATH` finds it (the GUI-launch case).
/// 4. first existing/executable of `fallback_paths`.
/// 5. `"codex"` unchanged — resolution failed; the spawn will surface a
///    not-found error the caller can hint on.
///
/// Probes are injected so the priority order is table-testable without the
/// real filesystem or shelling out.
pub fn resolve_codex_program(
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

fn probe_login_shell(timeout: Duration) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new(login_shell_path())
            .args(["-lc", "command -v codex"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        let _ = tx.send(result);
    });
    rx.recv_timeout(timeout)
        .ok()
        .flatten()
        .filter(|path| is_executable_file(Path::new(path)))
}

/// Well-known `codex` install locations, in priority order. Codex is commonly
/// an npm global (`/opt/homebrew/bin`, `~/.local/bin`) or a Homebrew formula.
fn well_known_fallback_dirs() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    [
        format!("{home}/.local/bin/{BIN_NAME}"),
        format!("/opt/homebrew/bin/{BIN_NAME}"),
        format!("/usr/local/bin/{BIN_NAME}"),
        format!("{home}/bin/{BIN_NAME}"),
    ]
    .into_iter()
    .filter(|p| !p.starts_with('/') || !p.contains("//"))
    .collect()
}

static RESOLVED_CODEX_PROGRAM: OnceLock<String> = OnceLock::new();

/// The path (or bare `codex`, as a last resort) to invoke. Resolved once and
/// cached for the life of the process. Honors `AGENT_TARMAC_CODEX_BIN`.
pub fn codex_program() -> String {
    RESOLVED_CODEX_PROGRAM
        .get_or_init(|| {
            resolve_codex_program(
                std::env::var("AGENT_TARMAC_CODEX_BIN").ok(),
                probe_current_path,
                || probe_login_shell(Duration::from_secs(5)),
                |p| is_executable_file(Path::new(p)),
                &well_known_fallback_dirs(),
            )
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins_unconditionally() {
        let result = resolve_codex_program(
            Some("/custom/codex".to_string()),
            || panic!("path_probe should not run when env override is set"),
            || panic!("shell_probe should not run when env override is set"),
            |_| panic!("fallback_exists should not run when env override is set"),
            &["/should/not/be/used".to_string()],
        );
        assert_eq!(result, "/custom/codex");
    }

    #[test]
    fn path_probe_wins_over_shell_and_fallback() {
        let result = resolve_codex_program(
            None,
            || Some("/from/path/codex".to_string()),
            || panic!("shell_probe should not run when path_probe succeeds"),
            |_| panic!("fallback_exists should not run when path_probe succeeds"),
            &["/nope".to_string()],
        );
        assert_eq!(result, "/from/path/codex");
    }

    #[test]
    fn fallback_used_when_probes_fail_then_bare_name() {
        let fallbacks = vec!["/nope/codex".to_string(), "/yes/codex".to_string()];
        assert_eq!(
            resolve_codex_program(None, || None, || None, |p| p == "/yes/codex", &fallbacks),
            "/yes/codex"
        );
        // Nothing resolves -> bare name.
        assert_eq!(
            resolve_codex_program(None, || None, || None, |_| false, &[]),
            "codex"
        );
    }
}
