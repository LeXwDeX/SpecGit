#[path = "support/snapshot.rs"]
mod snapshot;
use serde_json::json;
use std::path::Path;
fn exercise(path: &Path, write: impl Fn(usize) + Sync) {
    std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            for counter in 1..=200 {
                write(counter);
            }
        });
        let mut reads = 0;
        // Thread completion includes panic. A success-only flag would hide a failed
        // Windows replacement forever and keep libtest from reporting its error.
        while !writer.is_finished() || reads < 200 {
            let state: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(
                state["payload"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|v| *v == state["counter"])
            );
            reads += 1;
        }
        writer.join().expect("fixture snapshot writer failed");
    });
}
#[test]
fn concurrent_fixture_readers_never_observe_a_truncated_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("api.json");
    snapshot::write(&path, &json!({"counter":0,"payload":vec![0;8192]}));
    exercise(&path, |counter| {
        snapshot::write(
            &path,
            &json!({"counter":counter,"payload":vec![counter;8192]}),
        )
    });
}
#[test]
fn a_failed_writer_terminates_the_reader_and_reports_failure() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("api.json");
    snapshot::write(&path, &json!({"counter":0,"payload":[0]}));
    let result =
        std::panic::catch_unwind(|| exercise(&path, |_| panic!("controlled writer failure")));
    assert!(
        result.is_err(),
        "A writer failure must reach the calling test"
    );
}
