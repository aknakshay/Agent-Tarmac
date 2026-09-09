use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

/// One entry in the changed-files list surfaced by [`git_changes`]. Field
/// names are camelCase on the wire so the TS side needs no manual mapping —
/// mirrors the convention in `token_stats::TokenStats`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    /// One of "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict".
    pub status: String,
    pub staged: bool,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// The full git-changes snapshot for one `cwd`, returned by [`git_changes`].
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitChanges {
    pub is_repo: bool,
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub files: Vec<GitFile>,
}

/// The unified diff for a single file, returned by [`git_file_diff`].
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub diff: String,
    pub binary: bool,
    pub truncated: bool,
}

/// Diffs over this size (bytes) are truncated rather than shipped whole to
/// the frontend — mirrors the spec's ~2 MB cap.
const MAX_DIFF_BYTES: usize = 2_000_000;

/// Runs `git -C <cwd> <args>`, returning stdout as UTF-8 (lossy) regardless
/// of exit code — several of the commands we shell out to (e.g. `diff
/// --no-index` on an untracked file) exit non-zero by design. `Err` is
/// reserved for the process failing to even launch (e.g. `git` missing).
fn run_git(cwd: &str, args: &[&str]) -> Result<(bool, String), String> {
    let mut full_args = vec!["-C", cwd];
    full_args.extend_from_slice(args);
    let output = Command::new("git")
        .args(&full_args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

/// One line of `git diff --name-status` output: `<letter><score>\t<path>` for
/// most statuses, or `<letter><score>\t<old>\t<new>` for a rename/copy — in
/// which case the new path is what we want.
fn parse_name_status_line(line: &str) -> Option<(String, &'static str)> {
    let mut parts = line.split('\t');
    let code = parts.next()?;
    if code.is_empty() {
        return None;
    }
    let status = match code.as_bytes()[0] {
        b'M' => "modified",
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "added", // copy: treat like a new addition of the copy target
        b'U' => "conflict",
        _ => "modified",
    };
    if status == "renamed" || code.as_bytes()[0] == b'C' {
        // R100\told\tnew (or C100\told\tnew) — the path we want is the new one.
        let _old = parts.next()?;
        let new = parts.next()?;
        Some((new.to_string(), status))
    } else {
        let path = parts.next()?;
        Some((path.to_string(), status))
    }
}

/// One line of `git diff --numstat` output: `<add>\t<del>\t<path>`, or
/// `-\t-\t<path>` for a binary file. Renames appear as `<add>\t<del>\told =>
/// new` or with `{old => new}` path segments in older git — we only need the
/// counts here, keyed by the same "new path" `parse_name_status_line`
/// resolves to, so we extract the path the same way (last tab-delimited
/// path token, tolerating an arrow-rename form).
fn parse_numstat_line(line: &str) -> Option<(String, Option<u32>, Option<u32>)> {
    let mut parts = line.split('\t');
    let add = parts.next()?;
    let del = parts.next()?;
    let path_field = parts.next()?;
    let path = resolve_numstat_path(path_field);
    let additions = add.parse::<u32>().ok();
    let deletions = del.parse::<u32>().ok();
    Some((path, additions, deletions))
}

/// `--numstat` renders a rename as either `old => new` (space form) or
/// `dir/{old => new}/file` (brace form, when only a subpath changed). Resolve
/// either to the plain new path so it lines up with the key
/// `parse_name_status_line` produces.
fn resolve_numstat_path(field: &str) -> String {
    if let Some(brace_start) = field.find('{') {
        if let Some(brace_end) = field.find('}') {
            if let Some(arrow) = field[brace_start..brace_end].find(" => ") {
                let prefix = &field[..brace_start];
                let suffix = &field[brace_end + 1..];
                let new_mid = &field[brace_start + arrow + 4..brace_end];
                return format!("{prefix}{new_mid}{suffix}");
            }
        }
    }
    if let Some(arrow) = field.find(" => ") {
        return field[arrow + 4..].to_string();
    }
    field.to_string()
}

#[derive(Default, Clone)]
struct Accum {
    status: Option<String>,
    staged: bool,
    additions: u32,
    deletions: u32,
    binary: bool,
}

/// Async Tauri command: reads the working-tree + index state of `cwd` with
/// the real `git` CLI. Runs on `spawn_blocking` — a synchronous command here
/// would freeze the UI thread the same way an un-`spawn_blocking`'d
/// `token_stats` once did.
#[tauri::command]
pub async fn git_changes(cwd: String) -> Result<GitChanges, String> {
    tauri::async_runtime::spawn_blocking(move || compute_git_changes(&cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn compute_git_changes(cwd: &str) -> Result<GitChanges, String> {
    let (ok, root_out) = run_git(cwd, &["rev-parse", "--show-toplevel"])?;
    if !ok {
        return Ok(GitChanges {
            is_repo: false,
            repo_root: None,
            branch: None,
            files: vec![],
        });
    }
    let repo_root = root_out.trim().to_string();

    let branch = {
        let (ok, out) = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if ok {
            Some(out.trim().to_string())
        } else {
            None
        }
    };

    let mut acc: HashMap<String, Accum> = HashMap::new();

    // Unstaged name-status.
    let (_, unstaged_ns) = run_git(cwd, &["diff", "--name-status"])?;
    for line in unstaged_ns.lines() {
        if let Some((path, status)) = parse_name_status_line(line) {
            let e = acc.entry(path).or_default();
            e.status = Some(status.to_string());
        }
    }

    // Staged name-status.
    let (_, staged_ns) = run_git(cwd, &["diff", "--cached", "--name-status"])?;
    for line in staged_ns.lines() {
        if let Some((path, status)) = parse_name_status_line(line) {
            let e = acc.entry(path).or_default();
            e.status = Some(status.to_string());
            e.staged = true;
        }
    }

    // Merge conflicts show up as "U" (unmerged) via `diff --name-status`
    // against neither side cleanly in some git versions; a more reliable
    // signal is `ls-files --unmerged` having any entry for the path. We fold
    // that in on top of whatever name-status decided.
    let (_, unmerged) = run_git(cwd, &["diff", "--name-only", "--diff-filter=U"])?;
    for path in unmerged.lines() {
        if path.is_empty() {
            continue;
        }
        let e = acc.entry(path.to_string()).or_default();
        e.status = Some("conflict".to_string());
    }

    // Unstaged numstat: sum additions/deletions, detect binary.
    let (_, unstaged_num) = run_git(cwd, &["diff", "--numstat"])?;
    for line in unstaged_num.lines() {
        if let Some((path, add, del)) = parse_numstat_line(line) {
            let e = acc.entry(path).or_default();
            match (add, del) {
                (Some(a), Some(d)) => {
                    e.additions += a;
                    e.deletions += d;
                }
                _ => e.binary = true,
            }
        }
    }

    // Staged numstat: same, plus marks staged=true (in case name-status
    // somehow missed it, e.g. a pure mode change).
    let (_, staged_num) = run_git(cwd, &["diff", "--cached", "--numstat"])?;
    for line in staged_num.lines() {
        if let Some((path, add, del)) = parse_numstat_line(line) {
            let e = acc.entry(path).or_default();
            e.staged = true;
            match (add, del) {
                (Some(a), Some(d)) => {
                    e.additions += a;
                    e.deletions += d;
                }
                _ => e.binary = true,
            }
        }
    }

    let mut files: Vec<GitFile> = acc
        .into_iter()
        .filter_map(|(path, a)| {
            let status = a.status?;
            Some(GitFile {
                path,
                status,
                staged: a.staged,
                additions: a.additions,
                deletions: a.deletions,
                binary: a.binary,
            })
        })
        .collect();

    // Untracked files: not covered by `diff` at all.
    let (_, untracked_out) = run_git(cwd, &["ls-files", "--others", "--exclude-standard"])?;
    for path in untracked_out.lines() {
        if path.is_empty() {
            continue;
        }
        let additions = std::fs::read_to_string(Path::new(&repo_root).join(path))
            .map(|s| s.lines().count() as u32)
            .unwrap_or(0);
        files.push(GitFile {
            path: path.to_string(),
            status: "untracked".to_string(),
            staged: false,
            additions,
            deletions: 0,
            binary: false,
        });
    }

    // Conflicts first, then alphabetical by path.
    files.sort_by(|a, b| {
        let a_conflict = a.status == "conflict";
        let b_conflict = b.status == "conflict";
        b_conflict.cmp(&a_conflict).then_with(|| a.path.cmp(&b.path))
    });

    Ok(GitChanges {
        is_repo: true,
        repo_root: Some(repo_root),
        branch,
        files,
    })
}

/// Async Tauri command: just the current branch name for `cwd` — a
/// lightweight companion to [`git_changes`] for callers that only need the
/// branch (e.g. a session-list badge) without paying for the full changed-
/// files scan. Runs on `spawn_blocking` for the same reason as
/// [`git_changes`].
#[tauri::command]
pub async fn git_branch(cwd: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || compute_git_branch(&cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn compute_git_branch(cwd: &str) -> Result<Option<String>, String> {
    let (ok, out) = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !ok {
        return Ok(None);
    }
    Ok(Some(out.trim().to_string()))
}

/// Async Tauri command: the unified diff text for one file in `cwd`. Runs on
/// `spawn_blocking` for the same reason as [`git_changes`].
#[tauri::command]
pub async fn git_file_diff(cwd: String, path: String) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || compute_file_diff(&cwd, &path))
        .await
        .map_err(|e| e.to_string())?
}

fn compute_file_diff(cwd: &str, path: &str) -> Result<FileDiff, String> {
    let (_, unstaged) = run_git(cwd, &["diff", "--", path])?;
    let mut raw = unstaged;

    if raw.trim().is_empty() {
        let (_, staged) = run_git(cwd, &["diff", "--cached", "--", path])?;
        raw = staged;
    }

    if raw.trim().is_empty() {
        // Not tracked (or genuinely no diff either side) — try rendering it
        // as an untracked, all-additions diff. `--no-index` against
        // /dev/null exits non-zero by design; `run_git` doesn't treat that
        // as an error, it just hands back stdout regardless of exit code.
        let (_, untracked) = run_git(cwd, &["diff", "--no-index", "--", "/dev/null", path])?;
        raw = untracked;
    }

    if raw.contains("Binary files") && raw.contains("differ") {
        return Ok(FileDiff {
            path: path.to_string(),
            diff: String::new(),
            binary: true,
            truncated: false,
        });
    }

    let truncated = raw.len() > MAX_DIFF_BYTES;
    let diff = if truncated {
        // Truncate on a UTF-8 char boundary at/under the cap.
        let mut end = MAX_DIFF_BYTES;
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        raw[..end].to_string()
    } else {
        raw
    };

    Ok(FileDiff {
        path: path.to_string(),
        diff,
        binary: false,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_name_status_lines() {
        assert_eq!(
            parse_name_status_line("M\tsrc/lib.rs"),
            Some(("src/lib.rs".to_string(), "modified"))
        );
        assert_eq!(
            parse_name_status_line("A\tnew_file.rs"),
            Some(("new_file.rs".to_string(), "added"))
        );
        assert_eq!(
            parse_name_status_line("D\told_file.rs"),
            Some(("old_file.rs".to_string(), "deleted"))
        );
    }

    #[test]
    fn parses_rename_name_status_line_using_new_path() {
        assert_eq!(
            parse_name_status_line("R100\tsrc/old.rs\tsrc/new.rs"),
            Some(("src/new.rs".to_string(), "renamed"))
        );
    }

    #[test]
    fn parses_conflict_name_status_line() {
        assert_eq!(
            parse_name_status_line("U\tconflicted.rs"),
            Some(("conflicted.rs".to_string(), "conflict"))
        );
    }

    #[test]
    fn ignores_empty_line() {
        assert_eq!(parse_name_status_line(""), None);
    }

    #[test]
    fn parses_simple_numstat_line() {
        assert_eq!(
            parse_numstat_line("3\t1\tsrc/lib.rs"),
            Some(("src/lib.rs".to_string(), Some(3), Some(1)))
        );
    }

    #[test]
    fn parses_binary_numstat_line() {
        assert_eq!(
            parse_numstat_line("-\t-\timage.png"),
            Some(("image.png".to_string(), None, None))
        );
    }

    #[test]
    fn resolves_arrow_rename_numstat_path() {
        assert_eq!(
            resolve_numstat_path("src/old.rs => src/new.rs"),
            "src/new.rs"
        );
    }

    #[test]
    fn resolves_brace_rename_numstat_path() {
        assert_eq!(
            resolve_numstat_path("src/{old => new}/lib.rs"),
            "src/new/lib.rs"
        );
    }

    #[test]
    fn resolves_plain_numstat_path_unchanged() {
        assert_eq!(resolve_numstat_path("src/lib.rs"), "src/lib.rs");
    }
}
