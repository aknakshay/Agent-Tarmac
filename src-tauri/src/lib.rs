mod activity;
mod session_index;
mod transcript;
mod workspace_store;

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
        .manage(session_index::SessionIndexState(Mutex::new(
            session_index::scan(&session_index::claude_projects_dir()),
        )))
        .manage(workspace_store::WorkspaceState(Mutex::new(
            workspace_store::Workspace::default(),
        )))
        .invoke_handler(tauri::generate_handler![
            greet,
            session_index::list_sessions,
            workspace_store::get_workspace,
            workspace_store::set_workspace
        ])
        .setup(|app| {
            session_index::start_watcher(app.handle().clone());

            let workspace_path = workspace_store::workspace_path(app.handle())?;
            let workspace = workspace_store::load(&workspace_path);
            let state = app.state::<workspace_store::WorkspaceState>();
            *state.0.lock().unwrap_or_else(|e| e.into_inner()) = workspace;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
