mod session_index;
mod transcript;

use std::sync::Mutex;

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
        .invoke_handler(tauri::generate_handler![
            greet,
            session_index::list_sessions
        ])
        .setup(|app| {
            session_index::start_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
