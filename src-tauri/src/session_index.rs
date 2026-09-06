use crate::backend::{self, SessionBackend};
use crate::transcript::SessionMeta;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// The session index across every backend. ChatGPT-app Codex sessions (Desktop
/// app, Chrome extension) are included and tagged (`SessionMeta::codex_app`);
/// the show/hide policy is applied client-side (see the store's `showCodexApp`),
/// so the toggle re-filters instantly with no rescan and the sidebar can show a
/// count of what's hidden.
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

/// Scan a single Claude-topology directory. Thin wrapper over the Claude
/// backend's `scan`, kept for the targeted/test call sites that pass an
/// explicit dir; the running app discovers across every backend via
/// [`scan_all`].
pub fn scan(dir: &Path) -> Vec<SessionMeta> {
    backend::CLAUDE.scan(dir)
}

/// Discover every session across all registered backends, each at its own
/// transcripts root, merged newest-activity first. With a single (Claude)
/// backend this is behavior-identical to the old `scan(claude_projects_dir())`.
pub fn scan_all() -> Vec<SessionMeta> {
    let mut sessions = Vec::new();
    for b in backend::all_backends() {
        sessions.extend(b.scan(&b.transcripts_root()));
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.last_activity));
    sessions
}

pub fn start_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        use notify::{RecursiveMode, Watcher};

        // Watch every backend's transcripts root that exists on disk. A
        // change under any of them triggers a full cross-backend rescan.
        let roots: Vec<PathBuf> = backend::all_backends()
            .iter()
            .map(|b| b.transcripts_root())
            .filter(|root| root.exists())
            .collect();
        if roots.is_empty() {
            return;
        }

        let (tx, rx) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(_) => return,
        };
        let mut watching_any = false;
        for root in &roots {
            if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
                watching_any = true;
            }
        }
        if !watching_any {
            return;
        }

        loop {
            // Block until at least one event arrives.
            if rx.recv().is_err() {
                break;
            }
            // Debounce: drain further events for 500ms.
            while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}

            let sessions = scan_all();
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
