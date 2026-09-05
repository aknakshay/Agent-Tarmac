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

#[cfg(test)]
mod tests {
    use super::*;

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
