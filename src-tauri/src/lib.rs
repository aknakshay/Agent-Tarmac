pub mod activity;
pub mod claude_bin;
pub mod pop_out;
pub mod pty_manager;
pub mod session_index;
pub mod status_loop;
pub mod transcript;
pub mod update_check;
pub mod workspace_store;

use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;

/// Checks whether the `claude` binary (resolved via
/// `claude_bin::claude_program`, same resolution `pty_manager::claude_program`
/// uses) is runnable, for the sidebar's "no sessions found" empty-state
/// hint. Returns the version string on success, `None` if the binary isn't
/// found or exits non-zero — either way, never an error the frontend has to
/// handle, since "not installed" is an expected, common state here (not a
/// failure).
#[tauri::command]
fn check_claude() -> Option<String> {
    let bin = claude_bin::claude_program();
    let output = Command::new(&bin).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(session_index::SessionIndexState(Mutex::new(
            session_index::scan(&session_index::claude_projects_dir()),
        )))
        .manage(workspace_store::WorkspaceState(Mutex::new(
            workspace_store::Workspace::default(),
        )))
        .manage(pty_manager::PtyManager::default())
        .manage(pop_out::ExternalSessions::default())
        .invoke_handler(tauri::generate_handler![
            check_claude,
            session_index::list_sessions,
            workspace_store::get_workspace,
            workspace_store::set_workspace,
            pty_manager::resume_session,
            pty_manager::start_new_session,
            pty_manager::stop_session,
            pty_manager::write_stdin,
            pty_manager::resize_pty,
            pop_out::pop_out_to_ghostty,
            pop_out::bring_back_session,
            pop_out::detect_terminals,
            pop_out::list_external_sessions,
        ])
        .setup(|app| {
            session_index::start_watcher(app.handle().clone());
            status_loop::start(app.handle().clone());
            update_check::start(app.handle().clone());

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

            // External (popped-out) sessions DO get startup reconciliation —
            // unlike live_session_ids above, their ground truth (a running
            // external `claude` process) exists independently of this app,
            // so pgrep can verify each persisted id right now. Survivors are
            // re-tracked (sidebar shows them running, in-app resume stays
            // blocked); the rest are dropped.
            pop_out::reconcile_external_on_startup(app.handle());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
