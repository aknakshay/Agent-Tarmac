//! Background loop that ticks every 2s, derives a `Status` for each known
//! session from the session index and PTY manager, and emits
//! `session_status_changed` whenever a session's status changes.

use crate::activity::{derive_status, tail_looks_like_prompt, Status, StatusInputs};
use crate::pty_manager::PtyManager;
use crate::session_index::SessionIndexState;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const TICK_INTERVAL: Duration = Duration::from_secs(2);
const IDLE_AFTER_SECS: u64 = 300;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusChange {
    pub session_id: String,
    pub status: Status,
}

/// Starts the status loop on a background thread. Call once from `.setup`,
/// after the session watcher has been started.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut previous: HashMap<String, Status> = HashMap::new();
        let mut first_tick = true;

        loop {
            tick(&app, &mut previous, first_tick);
            first_tick = false;
            thread::sleep(TICK_INTERVAL);
        }
    });
}

fn tick(app: &AppHandle, previous: &mut HashMap<String, Status>, first_tick: bool) {
    let sessions = {
        let Some(state) = app.try_state::<SessionIndexState>() else {
            return;
        };
        let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    };

    let Some(pty_manager) = app.try_state::<PtyManager>() else {
        return;
    };

    let now = Utc::now();

    for session in sessions {
        let pty_running = pty_manager.is_running(&session.id);
        // Task 12 extends this with external session tracking.
        let running = pty_running;

        let pty_secs = pty_manager.secs_since_output(&session.id);
        let transcript_secs = (now - session.last_activity).num_seconds().max(0) as u64;
        let secs_since_activity = match pty_secs {
            Some(pty_secs) => pty_secs.min(transcript_secs),
            None => transcript_secs,
        };

        let prompt_at_tail = tail_looks_like_prompt(&pty_manager.last_output_tail(&session.id));
        let last_role_assistant = session.last_role.as_deref() == Some("assistant");

        let status = derive_status(&StatusInputs {
            running,
            secs_since_activity,
            last_role_assistant,
            prompt_at_tail,
            idle_after_secs: IDLE_AFTER_SECS,
        });

        let changed = first_tick || previous.get(&session.id) != Some(&status);
        if changed {
            #[cfg(debug_assertions)]
            println!("[status_loop] {} -> {:?}", session.id, status);

            let _ = app.emit(
                "session_status_changed",
                StatusChange {
                    session_id: session.id.clone(),
                    status,
                },
            );
        }
        previous.insert(session.id.clone(), status);
    }
}
