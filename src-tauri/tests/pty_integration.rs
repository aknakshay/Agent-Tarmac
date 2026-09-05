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
