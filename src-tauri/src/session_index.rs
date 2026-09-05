use crate::transcript::{parse_transcript, SessionMeta};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct SessionIndexState(pub Mutex<Vec<SessionMeta>>);

pub fn claude_projects_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AGENT_TARMAC_PROJECTS_DIR") {
        return PathBuf::from(dir);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("projects")
}

pub fn scan(dir: &Path) -> Vec<SessionMeta> {
    let mut sessions = Vec::new();
    let Ok(project_dirs) = std::fs::read_dir(dir) else {
        return sessions;
    };
    for project_entry in project_dirs.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&project_path) else {
            continue;
        };
        for file_entry in files.flatten() {
            let file_path = file_entry.path();
            if file_path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Some(meta) = parse_transcript(&file_path) {
                    sessions.push(meta);
                }
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.last_activity));
    sessions
}

pub fn start_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let dir = claude_projects_dir();
        if !dir.exists() {
            return;
        }

        use notify::{RecursiveMode, Watcher};

        let (tx, rx) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(_) => return,
        };
        if watcher.watch(&dir, RecursiveMode::Recursive).is_err() {
            return;
        }

        loop {
            // Block until at least one event arrives.
            if rx.recv().is_err() {
                break;
            }
            // Debounce: drain further events for 500ms.
            while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}

            let sessions = scan(&claude_projects_dir());
            if let Some(state) = app.try_state::<SessionIndexState>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = sessions.clone();
                }
            }
            let _ = app.emit("sessions_updated", &sessions);
        }
    });
}

#[tauri::command]
pub fn list_sessions(state: State<SessionIndexState>) -> Vec<SessionMeta> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_finds_both_fixture_sessions_sorted_desc() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/projects");
        let all = scan(&dir);
        assert_eq!(all.len(), 2);
        assert!(all[0].last_activity >= all[1].last_activity);
    }

    #[test]
    fn scan_of_missing_dir_is_empty() {
        assert!(scan(Path::new("/nope")).is_empty());
    }
}
