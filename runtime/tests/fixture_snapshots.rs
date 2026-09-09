#[path = "support/snapshot.rs"]
mod snapshot;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
#[test]
fn concurrent_fixture_readers_never_observe_a_truncated_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("api.json");
    snapshot::write(&path, &json!({"counter":0,"payload":vec![0;8192]}));
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            for counter in 1..=200 {
                snapshot::write(
                    &path,
                    &json!({"counter":counter,"payload":vec![counter;8192]}),
                );
            }
            done.store(true, Ordering::Release);
        });
        let mut reads = 0;
        while !done.load(Ordering::Acquire) || reads < 200 {
            let state: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(
                state["payload"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|v| *v == state["counter"])
            );
            reads += 1;
        }
    });
}
