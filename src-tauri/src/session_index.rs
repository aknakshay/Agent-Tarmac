use crate::backend::{self, SessionBackend};
use crate::session_cache::{self, PersistentCache, SessionCacheState};
use crate::transcript::SessionMeta;
use serde::Serialize;
use std::collections::HashSet;
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

/// Cache-aware cross-backend scan. For every transcript file it stats
/// `(mtime, size)`; an unchanged file's [`SessionMeta`] is reused from `cache`
/// with no read, and only a new-or-changed file is head+tail-parsed and folded
/// back in. Entries for files that have vanished are pruned. Newest-activity
/// first, identical ordering to [`scan_all`] — just far cheaper once warm.
pub fn scan_all_cached(cache: &mut PersistentCache) -> Vec<SessionMeta> {
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    for b in backend::all_backends() {
        let root = b.transcripts_root();
        for path in b.transcript_files(&root) {
            let key = path.to_string_lossy().to_string();
            seen.insert(key.clone());
            let Some((mtime, size)) = session_cache::stat_key(&path) else {
                continue;
            };
            if let Some(meta) = cache.get_session(&key, mtime, size) {
                sessions.push(meta.clone());
            } else if let Some(meta) = b.parse_transcript(&path) {
                cache.put_session(key, mtime, size, meta.clone());
                sessions.push(meta);
            }
        }
    }
    cache.retain_present(&seen);
    sessions.sort_by_key(|s| std::cmp::Reverse(s.last_activity));
    sessions
}

/// Payload for the `scan_started` event: how many sessions the instant
/// cache-paint carried (0 on a cold cache / first launch).
#[derive(Clone, Serialize)]
struct ScanStarted {
    cached: usize,
}

/// Payload for the `scan_complete` event: the fresh session count after the
/// disk reconcile.
#[derive(Clone, Serialize)]
struct ScanComplete {
    count: usize,
}

fn publish(app: &AppHandle, sessions: &[SessionMeta]) {
    if let Some(state) = app.try_state::<SessionIndexState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = sessions.to_vec();
        }
    }
    let _ = app.emit("sessions_updated", sessions);
}

/// Non-blocking startup scan. The window paints with an EMPTY index (managed in
/// `lib.rs`); this thread then, off the UI path:
///   1. loads the persisted metadata cache and emits `sessions_updated`
///      immediately — the sidebar populates from disk, instantly, on a warm
///      cache (skipped when the cache is empty on first ever launch);
///   2. runs the stat + reparse-changed pass ([`scan_all_cached`]) and emits
///      `sessions_updated` again with fully fresh data;
///   3. installs the warmed cache into [`SessionCacheState`] (so the watcher's
///      incremental rescans share it) and writes it back to disk.
///
/// Event contract for the loading-state follow-up:
///   * `sessions_updated` (`SessionMeta[]`) fires up to twice — the cached
///     batch first (may be absent on a cold cache), then the fresh batch.
///   * `scan_started` (`{cached: number}`) fires once, right before the disk
///     reconcile, carrying the cached count already shown.
///   * `scan_complete` (`{count: number}`) fires once when the fresh batch has
///     been emitted. Between `scan_started` and `scan_complete` the frontend
///     may show a "refreshing" affordance; it is safe to render the cached
///     batch as the primary list the entire time.
pub fn start_background_scan(app: AppHandle) {
    std::thread::spawn(move || {
        let path = session_cache::cache_path(&app);
        let mut cache = path.as_deref().map(session_cache::load).unwrap_or_default();

        // 1. Instant paint from the cache (if any).
        let cached = cache.all_sessions_sorted();
        if !cached.is_empty() {
            publish(&app, &cached);
        }
        let _ = app.emit(
            "scan_started",
            ScanStarted {
                cached: cached.len(),
            },
        );

        // 2. Fresh reconcile — only new/changed files are read.
        let fresh = scan_all_cached(&mut cache);
        publish(&app, &fresh);
        let _ = app.emit("scan_complete", ScanComplete { count: fresh.len() });

        // 3. Share the warmed cache with the watcher and persist it.
        if let Some(state) = app.try_state::<SessionCacheState>() {
            if let Ok(mut guard) = state.0.lock() {
                *guard = cache.clone();
            }
        }
        if let Some(path) = path {
            let _ = session_cache::save(&path, &cache);
        }
    });
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

        let cache_file = session_cache::cache_path(&app);

        loop {
            // Block until at least one event arrives.
            if rx.recv().is_err() {
                break;
            }
            // Debounce: drain further events for 500ms.
            while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}

            // Incremental rescan through the shared cache: only the file that
            // changed is reparsed, every other session is reused. We take a
            // snapshot of the cache out from under the lock so neither the
            // blocking disk save nor the emit happens while it's held (per the
            // no-lock-across-emit/IO rule).
            let (sessions, snapshot) = match app.try_state::<SessionCacheState>() {
                Some(state) => {
                    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    let sessions = scan_all_cached(&mut guard);
                    let snapshot = guard.clone();
                    drop(guard);
                    (sessions, Some(snapshot))
                }
                // No cache state (shouldn't happen in the running app): fall
                // back to a full scan so the watcher still works.
                None => (scan_all(), None),
            };

            if let Some(state) = app.try_state::<SessionIndexState>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = sessions.clone();
                }
            }
            let _ = app.emit("sessions_updated", &sessions);

            if let (Some(path), Some(snapshot)) = (cache_file.as_ref(), snapshot) {
                let _ = session_cache::save(path, &snapshot);
            }
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
