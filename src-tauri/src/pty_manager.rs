use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::session_index::SessionIndexState;
use crate::workspace_store::{self, WorkspaceState};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const TAIL_CAPACITY: usize = 2048;

/// Description of a session to spawn.
pub struct SpawnSpec {
    pub session_id: String,
    pub cwd: PathBuf,
    pub program: String,
    pub args: Vec<String>,
}

/// Events emitted by a running PTY session.
#[derive(Debug, Clone)]
pub enum PtyEvent {
    Output {
        session_id: String,
        data_b64: String,
    },
    Exited {
        session_id: String,
    },
}

struct PtyHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    tail: Arc<Mutex<String>>,
    last_output_at: Arc<Mutex<Option<Instant>>>,
    running: Arc<Mutex<bool>>,
}

#[derive(Default)]
pub struct PtyManager {
    inner: Mutex<HashMap<String, PtyHandle>>,
}

fn push_tail(tail: &Arc<Mutex<String>>, chunk: &str) {
    let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
    t.push_str(chunk);
    if t.len() > TAIL_CAPACITY {
        let excess = t.len() - TAIL_CAPACITY;
        // Trim at a char boundary at or after `excess`.
        let mut cut = excess;
        while cut < t.len() && !t.is_char_boundary(cut) {
            cut += 1;
        }
        t.drain(..cut);
    }
}

/// Drops any handle whose reader thread has observed EOF, releasing its
/// master/writer/child fds. Called at the top of every map access so dead
/// sessions don't linger forever.
fn reap_dead(map: &mut HashMap<String, PtyHandle>) {
    map.retain(|_, handle| *handle.running.lock().unwrap_or_else(|e| e.into_inner()));
}

impl PtyManager {
    pub fn spawn(
        &self,
        emitter: impl Fn(PtyEvent) + Send + 'static,
        spec: SpawnSpec,
    ) -> Result<(), String> {
        // A session already running under this id must never be silently
        // overwritten: doing so would orphan the original PtyHandle (its
        // reader thread keeps running, then emits a false Exited once the
        // orphaned process eventually dies) while the new handle takes over
        // writes/output for callers still using the same id. Treat a repeat
        // spawn of a live id as a no-op rather than a respawn.
        if self.is_running(&spec.session_id) {
            return Ok(());
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                ..Default::default()
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);

        // Hydrate the PTY child environment from the login shell so that
        // Claude Code hooks (which call `node`), colours, and locale work
        // correctly when the app is Finder-launched with a bare GUI env.
        let env_overrides =
            crate::claude_bin::pty_env_overrides(crate::claude_bin::login_shell_env());
        for (key, val) in &env_overrides {
            cmd.env(key, val);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| crate::claude_bin::spawn_error_hint(&spec.program, e.to_string()))?;
        // Drop the slave end in this process so EOF is detected correctly.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| e.to_string())?,
        ));
        let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pair.master));

        let tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let last_output_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let running = Arc::new(Mutex::new(true));
        let child: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));

        let reader_tail = tail.clone();
        let reader_last_output = last_output_at.clone();
        let reader_running = running.clone();
        let reader_session_id = spec.session_id.clone();

        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk_str = String::from_utf8_lossy(&buf[..n]).to_string();
                        push_tail(&reader_tail, &chunk_str);
                        *reader_last_output.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(Instant::now());
                        let data_b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        emitter(PtyEvent::Output {
                            session_id: reader_session_id.clone(),
                            data_b64,
                        });
                    }
                    Err(_) => break,
                }
            }
            *reader_running.lock().unwrap_or_else(|e| e.into_inner()) = false;
            emitter(PtyEvent::Exited {
                session_id: reader_session_id.clone(),
            });
        });

        let handle = PtyHandle {
            master,
            writer,
            child,
            tail,
            last_output_at,
            running,
        };

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        reap_dead(&mut guard);
        guard.insert(spec.session_id, handle);

        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        // Clone the per-session writer handle and release the global map
        // lock before doing blocking I/O, so a stalled write to one session
        // can't stall every other session's write/kill/is_running/spawn.
        let writer = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            reap_dead(&mut guard);
            let handle = guard
                .get(session_id)
                .ok_or_else(|| format!("unknown session: {session_id}"))?;
            handle.writer.clone()
        };
        let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
        w.write_all(data).map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let master = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            reap_dead(&mut guard);
            let handle = guard
                .get(session_id)
                .ok_or_else(|| format!("unknown session: {session_id}"))?;
            handle.master.clone()
        };
        let m = master.lock().unwrap_or_else(|e| e.into_inner());
        m.resize(PtySize {
            rows,
            cols,
            ..Default::default()
        })
        .map_err(|e| e.to_string())
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let child = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            reap_dead(&mut guard);
            let handle = guard
                .get(session_id)
                .ok_or_else(|| format!("unknown session: {session_id}"))?;
            handle.child.clone()
        };

        let pid = {
            let c = child.lock().unwrap_or_else(|e| e.into_inner());
            c.process_id()
        };

        // portable-pty puts the child in its own session (setsid), so its
        // pgid equals its pid -- signal the whole process GROUP with
        // killpg, not just the immediate child, so any children Claude
        // Code itself spawns (e.g. tool subprocesses) go down too.
        #[cfg(unix)]
        if let Some(pid) = pid {
            unsafe {
                libc::killpg(pid as i32, libc::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        {
            let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = c.kill();
        }

        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let mut c = child.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(c.try_wait(), Ok(None)) {
                #[cfg(unix)]
                if let Some(pid) = pid {
                    unsafe {
                        libc::killpg(pid as i32, libc::SIGKILL);
                    }
                }
                // Fallback in case the group signal somehow missed the
                // tracked child itself (e.g. `pid` was unavailable above).
                let _ = c.kill();
            }
        });

        Ok(())
    }

    pub fn is_running(&self, session_id: &str) -> bool {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        reap_dead(&mut guard);
        match guard.get(session_id) {
            Some(handle) => {
                let reader_says_running = *handle.running.lock().unwrap_or_else(|e| e.into_inner());
                if !reader_says_running {
                    return false;
                }
                let mut c = handle.child.lock().unwrap_or_else(|e| e.into_inner());
                matches!(c.try_wait(), Ok(None))
            }
            None => false,
        }
    }

    pub fn last_output_tail(&self, session_id: &str) -> String {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        reap_dead(&mut guard);
        match guard.get(session_id) {
            Some(handle) => handle
                .tail
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            None => String::new(),
        }
    }

    pub fn secs_since_output(&self, session_id: &str) -> Option<u64> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        reap_dead(&mut guard);
        let handle = guard.get(session_id)?;
        let last = *handle
            .last_output_at
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        last.map(|instant| instant.elapsed().as_secs())
    }

    /// Number of sessions currently tracked (dead handles reaped first).
    /// Mostly for tests/observability.
    pub fn session_count(&self) -> usize {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        reap_dead(&mut guard);
        guard.len()
    }
}

/// Re-exported for callers that only import from `pty_manager` (spawn sites
/// and `check_claude` all want the same resolved binary). See
/// `claude_bin::claude_program` for the resolution order and caching.
pub fn claude_program() -> String {
    crate::claude_bin::claude_program()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputPayload {
    session_id: String,
    data_b64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitedPayload {
    session_id: String,
}

fn make_emitter(app: AppHandle) -> impl Fn(PtyEvent) + Send + 'static {
    move |event| match event {
        PtyEvent::Output {
            session_id,
            data_b64,
        } => {
            let _ = app.emit(
                "pty_output",
                PtyOutputPayload {
                    session_id,
                    data_b64,
                },
            );
        }
        PtyEvent::Exited { session_id } => {
            // Reconcile live_session_ids against PtyManager's ground truth
            // rather than just removing `session_id` directly: it's the same
            // outcome for the common case, but also mops up any other stale
            // entry that never got cleaned up (e.g. a prior crash).
            let workspace = app.state::<WorkspaceState>();
            let manager = app.state::<PtyManager>();
            let _ =
                workspace_store::reconcile_and_save(&app, &workspace, |id| manager.is_running(id));
            let _ = app.emit("pty_exited", PtyExitedPayload { session_id });
        }
    }
}

#[tauri::command]
pub fn resume_session(
    app: AppHandle,
    manager: State<PtyManager>,
    session_index: State<SessionIndexState>,
    workspace: State<WorkspaceState>,
    session_id: String,
) -> Result<(), String> {
    let (cwd, backend_kind) = {
        let sessions = session_index.0.lock().unwrap_or_else(|e| e.into_inner());
        let meta = sessions
            .iter()
            .find(|s| s.id == session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        let cwd = meta
            .cwd
            .clone()
            .ok_or_else(|| format!("session {session_id} has no known cwd"))?;
        (cwd, meta.backend)
    };

    // Resume via the backend that owns this session, so the right binary and
    // resume syntax are used (Claude: `claude --resume <id>`).
    let (program, args) = crate::backend::backend_for(backend_kind).resume_argv(&session_id);

    manager.spawn(
        make_emitter(app.clone()),
        SpawnSpec {
            session_id: session_id.clone(),
            cwd: PathBuf::from(cwd),
            program,
            args,
        },
    )?;

    workspace_store::add_live_session(&app, &workspace, &session_id)
}

#[tauri::command]
pub fn start_new_session(
    app: AppHandle,
    manager: State<PtyManager>,
    cwd: String,
) -> Result<String, String> {
    let session_id = format!("new-{}", uuid::Uuid::new_v4());
    // A fresh session has no backend tag yet; default to Claude (the only
    // backend that can start a brand-new session today).
    let (program, args) =
        crate::backend::backend_for(crate::backend::BackendKind::default()).start_argv();
    manager.spawn(
        make_emitter(app),
        SpawnSpec {
            session_id: session_id.clone(),
            cwd: PathBuf::from(cwd),
            program,
            args,
        },
    )?;
    // `new-*` placeholder ids are intentionally not persisted to
    // live_session_ids -- see workspace_store::add_live_session.
    Ok(session_id)
}

#[tauri::command]
pub fn stop_session(
    app: AppHandle,
    manager: State<PtyManager>,
    workspace: State<WorkspaceState>,
    session_id: String,
) -> Result<(), String> {
    manager.kill(&session_id)?;
    workspace_store::remove_live_session(&app, &workspace, &session_id)
}

#[tauri::command]
pub fn write_stdin(
    manager: State<PtyManager>,
    session_id: String,
    data_b64: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    manager.write(&session_id, &data)
}

#[tauri::command]
pub fn resize_pty(
    manager: State<PtyManager>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    manager.resize(&session_id, rows, cols)
}
