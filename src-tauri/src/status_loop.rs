//! Background loop that ticks every 2s, derives a `Status` for each known
//! session from the session index and PTY manager, and emits
//! `session_status_changed` whenever a session's status changes.

use crate::activity::{derive_status, tail_looks_like_prompt, Status, StatusInputs};
use crate::pop_out::ExternalSessions;
use crate::pty_manager::PtyManager;
use crate::session_index::SessionIndexState;
use crate::transcript::SessionMeta;
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const TICK_INTERVAL: Duration = Duration::from_secs(2);
const IDLE_AFTER_SECS: u64 = 300;
/// Minimum time between two native notifications for the same session, even
/// if it transitions into `NeedsYou` more than once in that window. Without
/// this, a session that flaps in and out of `NeedsYou` (e.g. brief
/// `Working` blips from a fast tool call) re-fires a notification on every
/// re-entry.
const NOTIFY_COOLDOWN_SECS: u64 = 600;
/// An externally-tracked (popped-out) session counts as running only while
/// its transcript is still being actively written to.
const EXTERNAL_FRESH_SECS: u64 = 15;
/// Once a popped-out session's transcript has been quiet this long, assume
/// the external terminal was closed and stop tracking it.
const EXTERNAL_STALE_SECS: u64 = 600;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusChange {
    pub session_id: String,
    pub status: Status,
}

/// Whether a transition into `new` should fire a native "needs you"
/// notification. Pure so the transition matrix can be table-tested without
/// standing up a Tauri app.
///
/// - The first tick's statuses are initial state, not events, so it never
///   notifies (`first_tick`).
/// - Only a transition INTO `NeedsYou` from a different prior status fires;
///   a session that's already `NeedsYou` (or has no prior status recorded)
///   does not re-fire on every unchanged tick.
/// - Skipped while the main window is focused — the in-app badge covers
///   that case.
/// - `last_notified_secs_ago`: how long ago this session last fired a
///   notification, if ever. `None` means it never has (or the record was
///   cleared). A transition that would otherwise notify is suppressed while
///   this is within `NOTIFY_COOLDOWN_SECS`.
fn should_notify(
    prev: Option<Status>,
    new: Status,
    first_tick: bool,
    window_focused: bool,
    last_notified_secs_ago: Option<u64>,
) -> bool {
    if first_tick || window_focused {
        return false;
    }
    if new != Status::NeedsYou {
        return false;
    }
    if !matches!(prev, Some(Status::Working) | Some(Status::Idle)) {
        return false;
    }
    match last_notified_secs_ago {
        Some(secs_ago) => secs_ago > NOTIFY_COOLDOWN_SECS,
        None => true,
    }
}

/// Starts the status loop on a background thread. Call once from `.setup`,
/// after the session watcher has been started.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut previous: HashMap<String, Status> = HashMap::new();
        let mut last_notified: HashMap<String, Instant> = HashMap::new();
        let mut first_tick = true;

        loop {
            tick(&app, &mut previous, &mut last_notified, first_tick);
            first_tick = false;
            thread::sleep(TICK_INTERVAL);
        }
    });
}

/// Fires a native OS notification for a session that just transitioned into
/// `NeedsYou`. Never panics or propagates errors — a failed notification
/// must not take down the status loop.
///
/// Note: macOS prompts for notification permission on first fire in a
/// bundled app; under `tauri dev` (unsigned/unbundled) macOS may silently
/// drop notifications entirely, so this can appear to do nothing there.
fn notify_needs_you(app: &AppHandle, session: &SessionMeta) {
    let title = if session.title.trim().is_empty() {
        session.id.chars().take(8).collect::<String>()
    } else {
        session.title.clone()
    };

    let mut body = "needs your attention".to_string();
    if let Some(cwd) = &session.cwd {
        if let Some(name) = Path::new(cwd).file_name().and_then(|n| n.to_str()) {
            body.push_str(&format!(" ({name})"));
        }
    }

    let result = app.notification().builder().title(title).body(body).show();

    if let Err(_e) = result {
        #[cfg(debug_assertions)]
        eprintln!("[status_loop] notification failed: {_e}");
    }
}

fn tick(
    app: &AppHandle,
    previous: &mut HashMap<String, Status>,
    last_notified: &mut HashMap<String, Instant>,
    first_tick: bool,
) {
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

    let external = app.try_state::<ExternalSessions>();

    let now = Utc::now();

    // Focus is a window-level property, not per-session, so read it once per
    // tick. `is_focused()` returning `Err` (e.g. window torn down) is
    // treated as "not focused" — never suppress a notification on a lookup
    // failure.
    let window_focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);

    for session in sessions {
        let pty_running = pty_manager.is_running(&session.id);

        let transcript_secs = (now - session.last_activity).num_seconds().max(0) as u64;

        // A popped-out session has no PtyManager handle (it's an external
        // process), so its only liveness signal is transcript freshness:
        // treat it as running while claude is actively writing to the
        // transcript, and stop tracking it once that goes stale (the
        // external terminal was presumably closed).
        let external_running = match &external {
            Some(external) if external.contains(&session.id) => {
                if transcript_secs > EXTERNAL_STALE_SECS {
                    external.remove(&session.id);
                    // Keep the persisted set in step, so a stale external
                    // isn't resurrected on the next launch's reconcile.
                    if let Some(ws) = app.try_state::<crate::workspace_store::WorkspaceState>() {
                        let _ = crate::workspace_store::set_external_session(
                            app,
                            &ws,
                            &session.id,
                            false,
                        );
                    }
                    false
                } else {
                    transcript_secs < EXTERNAL_FRESH_SECS
                }
            }
            _ => false,
        };

        let running = pty_running || external_running;

        let pty_secs = pty_manager.secs_since_output(&session.id);
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

        let prev_status = previous.get(&session.id).copied();
        let changed = first_tick || prev_status != Some(status);
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

        let last_notified_secs_ago = last_notified
            .get(&session.id)
            .map(|t| t.elapsed().as_secs());

        if should_notify(
            prev_status,
            status,
            first_tick,
            window_focused,
            last_notified_secs_ago,
        ) {
            notify_needs_you(app, &session);
            last_notified.insert(session.id.clone(), Instant::now());
        }

        previous.insert(session.id.clone(), status);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (prev, new, first_tick, window_focused, last_notified_secs_ago, expected)
    type ShouldNotifyCase = (Option<Status>, Status, bool, bool, Option<u64>, bool);

    #[test]
    fn should_notify_table() {
        let cases: Vec<ShouldNotifyCase> = vec![
            // (prev, new, first_tick, window_focused, last_notified_secs_ago, expected)
            // First tick statuses are initial state, never an event.
            (None, Status::NeedsYou, true, false, None, false),
            (
                Some(Status::Working),
                Status::NeedsYou,
                true,
                false,
                None,
                false,
            ),
            // Real transition into NeedsYou while unfocused, never notified
            // before: notify.
            (
                Some(Status::Working),
                Status::NeedsYou,
                false,
                false,
                None,
                true,
            ),
            (
                Some(Status::Idle),
                Status::NeedsYou,
                false,
                false,
                None,
                true,
            ),
            // Same transition while the window is focused: the in-app
            // badge covers it, skip.
            (
                Some(Status::Working),
                Status::NeedsYou,
                false,
                true,
                None,
                false,
            ),
            // Already NeedsYou, still NeedsYou: no repeat notification.
            (
                Some(Status::NeedsYou),
                Status::NeedsYou,
                false,
                false,
                None,
                false,
            ),
            // Not transitioning into NeedsYou at all.
            (
                Some(Status::Working),
                Status::Idle,
                false,
                false,
                None,
                false,
            ),
            // No prior status recorded (session appeared mid-run, not on
            // first_tick) landing directly on NeedsYou: nothing to
            // transition from, don't notify.
            (None, Status::NeedsYou, false, false, None, false),
            // Re-entering NeedsYou (e.g. a flap through Working) within the
            // cooldown window: suppressed.
            (
                Some(Status::Working),
                Status::NeedsYou,
                false,
                false,
                Some(30),
                false,
            ),
            (
                Some(Status::Working),
                Status::NeedsYou,
                false,
                false,
                Some(NOTIFY_COOLDOWN_SECS),
                false,
            ),
            // Cooldown has fully elapsed: notify again.
            (
                Some(Status::Working),
                Status::NeedsYou,
                false,
                false,
                Some(NOTIFY_COOLDOWN_SECS + 1),
                true,
            ),
        ];

        for (prev, new, first_tick, window_focused, last_notified_secs_ago, expected) in cases {
            assert_eq!(
                should_notify(
                    prev,
                    new,
                    first_tick,
                    window_focused,
                    last_notified_secs_ago
                ),
                expected,
                "prev={prev:?} new={new:?} first_tick={first_tick} window_focused={window_focused} last_notified_secs_ago={last_notified_secs_ago:?}"
            );
        }
    }
}
