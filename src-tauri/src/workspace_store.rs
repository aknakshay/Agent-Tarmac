use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct WorkspaceState(pub Mutex<Workspace>);

#[derive(Default, Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Workspace {
    pub live_session_ids: Vec<String>,
    pub open_session_ids: Vec<String>,
    pub favorites: Vec<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
            open_session_ids: vec![],
            favorites: vec!["b".into()],
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
}
