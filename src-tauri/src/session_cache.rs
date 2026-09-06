//! Persisted, append-only-aware caches keyed by `(path, mtime, size)`.
//!
//! Rollout/transcript files are append-only, so a file whose `(mtime, size)`
//! is unchanged since we last looked has *identical* extractable metadata and
//! token totals — no reason to open it again. Both caches live in one JSON file
//! (`app_data_dir/sessions-cache.json`) so a single load/save covers startup:
//!
//!   * [`PersistentCache::sessions`] — one [`SessionMeta`] per transcript, so
//!     the sidebar can paint from disk *instantly* on launch, before any file
//!     is touched.
//!   * [`PersistentCache::tokens`] — per-file running token totals plus the
//!     byte offset already summed, so a token rescan reads only the *new* tail
//!     bytes of a grown file (and nothing at all for an unchanged one).
//!
//! The format is internal and [`CACHE_VERSION`]-stamped: a version bump (or any
//! corruption / parse failure) invalidates the whole file cleanly and it is
//! rebuilt silently on the next scan.

use crate::transcript::SessionMeta;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Bump to invalidate every persisted cache after a schema change.
pub const CACHE_VERSION: u32 = 1;

/// A cached [`SessionMeta`] plus the `(mtime, size)` it was parsed from.
#[derive(Serialize, Deserialize, Clone)]
pub struct SessionEntry {
    pub mtime: DateTime<Utc>,
    pub size: u64,
    pub meta: SessionMeta,
}

/// Per-file token accounting. `offset` is how far into the file we have already
/// summed; because files are append-only, a rescan seeds from these totals and
/// reads only `[offset, size)`.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TokenEntry {
    pub mtime: DateTime<Utc>,
    pub size: u64,
    pub offset: u64,
    pub total_input: u64,
    pub total_output: u64,
    pub has_usage: bool,
    /// The local date the `today_*` buckets were accumulated for. They only
    /// count as "today" while this equals the current local date; on a new day
    /// they reset to zero.
    pub today_date: Option<NaiveDate>,
    pub today_input: u64,
    pub today_output: u64,
    pub today_cache_read: u64,
}

/// Both caches, serialized together. `#[serde(default)]` on the maps lets an
/// older file that predates one of them still load.
#[derive(Serialize, Deserialize, Clone)]
pub struct PersistentCache {
    pub version: u32,
    #[serde(default)]
    pub sessions: HashMap<String, SessionEntry>,
    #[serde(default)]
    pub tokens: HashMap<String, TokenEntry>,
}

impl Default for PersistentCache {
    fn default() -> Self {
        Self {
            version: CACHE_VERSION,
            sessions: HashMap::new(),
            tokens: HashMap::new(),
        }
    }
}

impl PersistentCache {
    /// The cached meta for `key` iff it was parsed from exactly this
    /// `(mtime, size)` — otherwise `None`, and the caller must reparse.
    pub fn get_session(&self, key: &str, mtime: DateTime<Utc>, size: u64) -> Option<&SessionMeta> {
        let e = self.sessions.get(key)?;
        (e.mtime == mtime && e.size == size).then_some(&e.meta)
    }

    /// Record a freshly parsed meta for `key`.
    pub fn put_session(&mut self, key: String, mtime: DateTime<Utc>, size: u64, meta: SessionMeta) {
        self.sessions
            .insert(key, SessionEntry { mtime, size, meta });
    }

    /// Every cached session, newest-activity first — the instant-paint batch
    /// emitted before the disk rescan.
    pub fn all_sessions_sorted(&self) -> Vec<SessionMeta> {
        let mut v: Vec<SessionMeta> = self.sessions.values().map(|e| e.meta.clone()).collect();
        v.sort_by_key(|s| std::cmp::Reverse(s.last_activity));
        v
    }

    /// Drop cache entries whose files no longer exist (weren't seen this scan),
    /// so a deleted transcript stops appearing. Applies to both sub-caches.
    pub fn retain_present(&mut self, seen: &HashSet<String>) {
        self.sessions.retain(|k, _| seen.contains(k));
        self.tokens.retain(|k, _| seen.contains(k));
    }
}

/// Live, in-memory handle to the persisted cache, shared by the startup
/// background scan and the file-watcher so both reparse only changed files.
/// `Default` seeds an empty, current-version cache; the real contents are
/// loaded from disk on the background thread to keep startup non-blocking.
#[derive(Default)]
pub struct SessionCacheState(pub Mutex<PersistentCache>);

/// `(mtime, size)` for `path`, or `None` if it can't be stat'd. The cache key
/// pair — cheap enough to call for every file on every scan.
pub fn stat_key(path: &Path) -> Option<(DateTime<Utc>, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime: DateTime<Utc> = m.modified().ok()?.into();
    Some((mtime, m.len()))
}

/// Location of the on-disk cache file (`app_data_dir/sessions-cache.json`).
pub fn cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("sessions-cache.json"))
}

/// Load the cache from disk. A missing file, a parse error, or a
/// [`CACHE_VERSION`] mismatch all yield a fresh empty cache — the cache is
/// always rebuildable, so invalidation is silent and total.
pub fn load(path: &Path) -> PersistentCache {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return PersistentCache::default();
    };
    match serde_json::from_str::<PersistentCache>(&contents) {
        Ok(c) if c.version == CACHE_VERSION => c,
        _ => PersistentCache::default(),
    }
}

/// Persist the cache atomically (tmp file + rename), creating the parent dir.
pub fn save(path: &Path, cache: &PersistentCache) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    let json = serde_json::to_string(cache)?;
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::BackendKind;

    fn meta(id: &str, ts: &str) -> SessionMeta {
        SessionMeta {
            id: id.to_string(),
            cwd: Some("/x".to_string()),
            title: id.to_string(),
            last_activity: ts.parse().unwrap(),
            last_role: Some("assistant".to_string()),
            backend: BackendKind::Claude,
            codex_app: false,
        }
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sessions-cache.json");
        let mut c = PersistentCache::default();
        let ts: DateTime<Utc> = "2026-09-06T10:00:00Z".parse().unwrap();
        c.put_session("k1".into(), ts, 100, meta("s1", "2026-09-06T10:00:00Z"));
        save(&p, &c).unwrap();

        let loaded = load(&p);
        assert_eq!(loaded.version, CACHE_VERSION);
        assert_eq!(loaded.get_session("k1", ts, 100).unwrap().id, "s1");
        // Wrong size ⇒ miss (file grew): caller must reparse.
        assert!(loaded.get_session("k1", ts, 101).is_none());
    }

    #[test]
    fn version_mismatch_invalidates() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sessions-cache.json");
        std::fs::write(&p, r#"{"version":999,"sessions":{},"tokens":{}}"#).unwrap();
        assert!(load(&p).sessions.is_empty());
        // Corrupt JSON also yields a clean empty cache.
        std::fs::write(&p, "not json at all").unwrap();
        assert_eq!(load(&p).version, CACHE_VERSION);
    }

    #[test]
    fn retain_present_drops_vanished_files() {
        let mut c = PersistentCache::default();
        let ts: DateTime<Utc> = "2026-09-06T10:00:00Z".parse().unwrap();
        c.put_session("gone".into(), ts, 1, meta("a", "2026-09-06T10:00:00Z"));
        c.put_session("kept".into(), ts, 1, meta("b", "2026-09-06T10:00:01Z"));
        let mut seen = HashSet::new();
        seen.insert("kept".to_string());
        c.retain_present(&seen);
        assert!(c.sessions.contains_key("kept"));
        assert!(!c.sessions.contains_key("gone"));
    }

    #[test]
    fn all_sessions_sorted_newest_first() {
        let mut c = PersistentCache::default();
        let ts: DateTime<Utc> = "2026-09-06T10:00:00Z".parse().unwrap();
        c.put_session("k1".into(), ts, 1, meta("old", "2026-09-01T00:00:00Z"));
        c.put_session("k2".into(), ts, 1, meta("new", "2026-09-06T00:00:00Z"));
        let sorted = c.all_sessions_sorted();
        assert_eq!(sorted[0].id, "new");
        assert_eq!(sorted[1].id, "old");
    }
}
