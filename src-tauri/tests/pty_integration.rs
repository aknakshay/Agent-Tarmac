use claude_deck_lib::pty_manager::{PtyEvent, PtyManager, SpawnSpec};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[test]
fn spawn_stream_write_kill() {
    let mgr = PtyManager::default();
    let events: Arc<Mutex<Vec<PtyEvent>>> = Arc::default();
    let sink = events.clone();
    let script =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-claude.sh");
    mgr.spawn(
        move |e| sink.lock().unwrap().push(e),
        SpawnSpec {
            session_id: "s1".into(),
            cwd: std::env::temp_dir(),
            program: script.to_string_lossy().into(),
            args: vec!["--resume".into(), "s1".into()],
        },
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(2000));
    assert!(mgr.is_running("s1"));
    assert!(mgr.last_output_tail("s1").contains("Do you want"));
    mgr.write("s1", b"hello\n").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(mgr.last_output_tail("s1").contains("got: hello"));
    mgr.kill("s1").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(!mgr.is_running("s1"));
    assert_eq!(
        mgr.session_count(),
        0,
        "dead session handle should be reaped (fds released) after kill"
    );
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, PtyEvent::Output { .. })));
}

#[test]
fn second_spawn_of_running_session_is_noop() {
    let mgr = PtyManager::default();
    let events: Arc<Mutex<Vec<PtyEvent>>> = Arc::default();
    let sink = events.clone();
    let script =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/fake-claude.sh");
    mgr.spawn(
        {
            let sink = sink.clone();
            move |e| sink.lock().unwrap().push(e)
        },
        SpawnSpec {
            session_id: "s2".into(),
            cwd: std::env::temp_dir(),
            program: script.to_string_lossy().into(),
            args: vec!["--resume".into(), "s2".into()],
        },
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    assert!(mgr.is_running("s2"));

    // A second spawn for the same, still-running session id (e.g. the
    // RestoreBanner resume racing TerminalPane's own resume-on-mount) must
    // be a no-op: it must not replace the live PtyHandle.
    mgr.spawn(
        move |e| sink.lock().unwrap().push(e),
        SpawnSpec {
            session_id: "s2".into(),
            cwd: std::env::temp_dir(),
            program: script.to_string_lossy().into(),
            args: vec![],
        },
    )
    .unwrap();

    assert_eq!(
        mgr.session_count(),
        1,
        "second spawn of a running session must not create a duplicate handle"
    );

    // The ORIGINAL session must still be alive and responsive — proof the
    // first handle wasn't silently overwritten/orphaned by the second spawn.
    mgr.write("s2", b"hello\n").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(mgr.last_output_tail("s2").contains("got: hello"));

    mgr.kill("s2").unwrap();
}
