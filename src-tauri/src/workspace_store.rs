use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct WorkspaceState(pub Mutex<Workspace>);

/// Per-session metadata layer: read/unread, tags, rename. Keyed by session id
/// in `Workspace::session_meta`. All fields default so a fresh entry (a
/// session nothing has touched yet) round-trips as the zero value rather than
/// requiring every caller to construct one explicitly.
#[derive(Default, Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct SessionMetaEntry {
    #[serde(default)]
    pub last_seen_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub marked_unread: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub custom_title: Option<String>,
}

/// Per-project metadata layer: custom display name. Keyed by cwd (absolute
/// path) in `Workspace::project_meta`. All fields default for back-compat —
/// mirrors the same `#[serde(default)]` pattern used for `SessionMetaEntry`.
#[derive(Default, Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ProjectMetaEntry {
    #[serde(default)]
    pub custom_name: Option<String>,
}

#[derive(Default, Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Workspace {
    pub live_session_ids: Vec<String>,
    pub favorites: Vec<String>,
    /// `#[serde(default)]` so a workspace.json written before this field
    /// existed still loads instead of falling back to `Workspace::default()`
    /// (which would silently wipe live_session_ids/favorites too, since
    /// `load` treats any parse error as "start fresh").
    #[serde(default)]
    pub session_meta: HashMap<String, SessionMetaEntry>,
    /// `#[serde(default)]` so a workspace.json written before this field
    /// existed still loads cleanly — same back-compat pattern as `session_meta`.
    #[serde(default)]
    pub project_meta: HashMap<String, ProjectMetaEntry>,
    /// Sessions popped out to an external terminal. Persisted so a relaunch
    /// can reconcile against still-running external `claude` processes
    /// instead of forgetting them (the old two-writer-after-restart gap).
    /// Same `#[serde(default)]` back-compat pattern as the fields above.
    #[serde(default)]
    pub external_session_ids: Vec<String>,
    /// Whether to show Codex sessions from the ChatGPT apps (Desktop app,
    /// Chrome extension) rather than only the terminal CLI. Off by default:
    /// Agent Tarmac is a terminal-CLI cockpit, and on a machine with those apps
    /// installed their sessions can flood the sidebar with conversations the
    /// user never runs in a terminal. `#[serde(default)]` (⇒ `false`) so an
    /// older workspace.json loads with app sessions hidden.
    #[serde(default)]
    pub show_codex_app: bool,
}

pub fn load(path: &Path) -> Workspace {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Workspace::default();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

pub fn save(path: &Path, ws: &Workspace) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(ws)?;
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

#[tauri::command]
pub fn get_workspace(state: State<WorkspaceState>) -> Workspace {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[tauri::command]
pub fn set_workspace(
    app: tauri::AppHandle,
    state: State<WorkspaceState>,
    ws: Workspace,
) -> Result<(), String> {
    let path = workspace_path(&app)?;
    save(&path, &ws).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = ws;
    Ok(())
}

pub fn workspace_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("workspace.json"))
        .map_err(|e| e.to_string())
}

/// Returns a copy of `ws` with `live_session_ids` filtered down to ids for
/// which `is_running` returns true. Used by the command layer to keep
/// `live_session_ids` in sync with `PtyManager`'s ground truth whenever a
/// session dies (natural exit or explicit stop) — NOT at app startup, where
/// `PtyManager` is always empty and every id would be (wrongly) dropped
/// before the restore banner ever sees them.
pub fn reconcile(ws: &Workspace, is_running: impl Fn(&str) -> bool) -> Workspace {
    let mut next = ws.clone();
    next.live_session_ids.retain(|id| is_running(id));
    next
}

/// Applies `reconcile` against the live `WorkspaceState` and persists the
/// result. Called from the command layer after a session dies.
pub fn reconcile_and_save(
    app: &tauri::AppHandle,
    state: &State<WorkspaceState>,
    is_running: impl Fn(&str) -> bool,
) -> Result<(), String> {
    let path = workspace_path(app)?;
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    *guard = reconcile(&guard, is_running);
    save(&path, &guard).map_err(|e| e.to_string())
}

/// Adds `id` to `live_session_ids` and persists. Placeholder `new-*` ids are
/// silently skipped: after a reboot they're meaningless to restore, since
/// `claude --resume` can't revive a session that never got a real transcript
/// id.
pub fn add_live_session(
    app: &tauri::AppHandle,
    state: &State<WorkspaceState>,
    id: &str,
) -> Result<(), String> {
    if id.starts_with("new-") {
        return Ok(());
    }
    let path = workspace_path(app)?;
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if !guard.live_session_ids.iter().any(|existing| existing == id) {
        guard.live_session_ids.push(id.to_string());
    }
    save(&path, &guard).map_err(|e| e.to_string())
}

/// Removes `id` from `live_session_ids` and persists. Used for the explicit
/// `stop_session` path: the user's intent to stop should drop the id right
/// away rather than waiting on `PtyManager::is_running` to catch up (kill()
/// sends SIGTERM and returns before the process is confirmed dead).
pub fn remove_live_session(
    app: &tauri::AppHandle,
    state: &State<WorkspaceState>,
    id: &str,
) -> Result<(), String> {
    let path = workspace_path(app)?;
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.live_session_ids.retain(|existing| existing != id);
    save(&path, &guard).map_err(|e| e.to_string())
}

/// Adds/removes `id` in `external_session_ids` and persists. The external
/// set must survive an app restart — startup reconciles it against real
/// `pgrep` results (see lib.rs setup) so a still-running Ghostty session is
/// remembered instead of shown Dormant and double-resumed.
pub fn set_external_session(
    app: &tauri::AppHandle,
    state: &WorkspaceState,
    id: &str,
    external: bool,
) -> Result<(), String> {
    let path = workspace_path(app)?;
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if external {
        if !guard.external_session_ids.iter().any(|e| e == id) {
            guard.external_session_ids.push(id.to_string());
        }
    } else {
        guard.external_session_ids.retain(|e| e != id);
    }
    save(&path, &guard).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_format_without_external_ids_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ws.json");
        std::fs::write(&p, r#"{"live_session_ids":["a"],"favorites":[]}"#).unwrap();
        let ws = load(&p);
        assert_eq!(ws.live_session_ids, vec!["a".to_string()]);
        assert!(ws.external_session_ids.is_empty());
    }

    #[test]
    fn reconcile_removes_dead_ids() {
        let ws = Workspace {
            live_session_ids: vec!["a".into(), "b".into()],
            ..Default::default()
        };
        let running = |id: &str| id == "a";
        assert_eq!(
            reconcile(&ws, running).live_session_ids,
            vec!["a".to_string()]
        );
    }

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ws.json");
        let ws = Workspace {
            live_session_ids: vec!["a".into()],
            favorites: vec!["b".into()],
            ..Default::default()
        };
        save(&p, &ws).unwrap();
        assert_eq!(load(&p), ws);
    }

    #[test]
    fn corrupt_file_loads_default() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ws.json");
        std::fs::write(&p, "{{{").unwrap();
        assert_eq!(load(&p), Workspace::default());
    }

    #[test]
    fn old_format_without_session_meta_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ws.json");
        // Includes the now-removed `open_session_ids` field, to prove an
        // on-disk workspace.json from before it was dropped still loads —
        // serde ignores unknown fields by default.
        std::fs::write(
            &p,
            r#"{"live_session_ids":["a"],"open_session_ids":["b"],"favorites":["c"]}"#,
        )
        .unwrap();
        let ws = load(&p);
        assert_eq!(ws.live_session_ids, vec!["a".to_string()]);
        assert_eq!(ws.favorites, vec!["c".to_string()]);
        assert!(ws.session_meta.is_empty());
    }

    #[test]
    fn old_format_without_project_meta_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ws.json");
        // workspace.json written before project_meta existed: must load without
        // losing live_session_ids/favorites and must default project_meta to
        // empty — mirrors the session_meta back-compat test above.
        std::fs::write(
            &p,
            r#"{"live_session_ids":["a"],"favorites":["b"],"session_meta":{}}"#,
        )
        .unwrap();
        let ws = load(&p);
        assert_eq!(ws.live_session_ids, vec!["a".to_string()]);
        assert_eq!(ws.favorites, vec!["b".to_string()]);
        assert!(
            ws.project_meta.is_empty(),
            "project_meta should default to empty"
        );
    }

    #[test]
    fn session_meta_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ws.json");
        let mut ws = Workspace::default();
        ws.session_meta.insert(
            "sess-1".to_string(),
            SessionMetaEntry {
                last_seen_at: Some(Utc::now()),
                marked_unread: true,
                tags: vec!["urgent".to_string()],
                custom_title: Some("My rename".to_string()),
            },
        );
        save(&p, &ws).unwrap();
        assert_eq!(load(&p), ws);
    }

    #[test]
    fn project_meta_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("ws.json");
        let mut ws = Workspace::default();
        ws.project_meta.insert(
            "/Users/me/proj".to_string(),
            ProjectMetaEntry {
                custom_name: Some("My Project".to_string()),
            },
        );
        save(&p, &ws).unwrap();
        let loaded = load(&p);
        assert_eq!(
            loaded.project_meta["/Users/me/proj"].custom_name.as_deref(),
            Some("My Project")
        );
    }

    #[test]
    fn project_meta_entry_custom_name_cleared_by_empty_string() {
        // The client sends "" to clear; the Rust store just stores whatever
        // the frontend passes in — this test documents that None != Some("").
        let mut ws = Workspace::default();
        ws.project_meta
            .insert("/p".to_string(), ProjectMetaEntry { custom_name: None });
        assert_eq!(ws.project_meta["/p"].custom_name, None);
    }
}
