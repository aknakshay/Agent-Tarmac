pub mod activity;
pub mod pty_manager;
pub mod session_index;
pub mod status_loop;
pub mod transcript;
pub mod workspace_store;

use std::sync::Mutex;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(session_index::SessionIndexState(Mutex::new(
            session_index::scan(&session_index::claude_projects_dir()),
        )))
        .manage(workspace_store::WorkspaceState(Mutex::new(
            workspace_store::Workspace::default(),
        )))
        .manage(pty_manager::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            session_index::list_sessions,
            workspace_store::get_workspace,
            workspace_store::set_workspace,
            pty_manager::resume_session,
            pty_manager::start_new_session,
            pty_manager::stop_session,
            pty_manager::write_stdin,
            pty_manager::resize_pty
        ])
        .setup(|app| {
            session_index::start_watcher(app.handle().clone());
            status_loop::start(app.handle().clone());

            // Intentionally NOT reconciled against PtyManager here: nothing
            // has been spawned yet at startup, so `is_running` would be false
            // for every id and reconcile would wipe live_session_ids before
            // the restore banner (RestoreBanner.tsx) ever gets a chance to
            // offer them. The saved ids ARE the restore candidates; reconcile
            // is instead wired into the running-app path (pty_exited /
            // stop_session in pty_manager.rs) where PtyManager's state is
            // meaningful.
            let workspace_path = workspace_store::workspace_path(app.handle())?;
            let workspace = workspace_store::load(&workspace_path);
            let state = app.state::<workspace_store::WorkspaceState>();
            *state.0.lock().unwrap_or_else(|e| e.into_inner()) = workspace;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
