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
/// The concurrent test above only races this state. Pin it: one replacement
/// attempt must succeed while a reader holds the old snapshot open, and that
/// reader must still see the whole old snapshot. A `MoveFileExW` replacement
/// fails here on Windows with Access is denied.
#[test]
fn replacement_never_waits_for_a_reader_holding_the_old_snapshot() {
    use std::io::Read;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("api.json");
    let old = json!({"counter":0,"payload":vec![0;8192]});
    snapshot::write(&path, &old);
    let mut reader = std::fs::File::open(&path).unwrap();
    let mut prefix = [0; 16];
    reader.read_exact(&mut prefix).unwrap();
    let new = json!({"counter":1,"payload":vec![1;8192]});
    snapshot::replace(&path, &new).expect("replacement must not depend on readers");
    let mut rest = Vec::new();
    reader.read_to_end(&mut rest).unwrap();
    let held: serde_json::Value = serde_json::from_slice(&[&prefix[..], &rest].concat()).unwrap();
    assert_eq!(held, old);
    drop(reader);
    assert_eq!(snapshot::read(&path), new);
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
#[cfg(feature = "test-fixtures")]
#[test]
fn concurrent_fake_forge_calls_never_lose_an_update() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("api.json");
    snapshot::write(&path, &json!({"calls":[],"issues":[],"project":{"id":7}}));
    let children: Vec<_> = (0..16)
        .map(|_| {
            std::process::Command::new(env!("CARGO_BIN_EXE_specgit-process-fixture"))
                .args(["api", "--method", "GET", "repos/fixture/repo"])
                .env("SPECGIT_FIXTURE_API_FILE", &path)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect();
    for mut child in children {
        assert!(child.wait().unwrap().success());
    }
    // Each process appends its call by read-modify-write of the shared snapshot.
    assert_eq!(snapshot::read(&path)["calls"].as_array().unwrap().len(), 16);
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn delayed_fake_forge_creation_can_be_cancelled_before_write() {
    use specgit::{
        diagnostic::Code,
        process::{Process, Request},
    };
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("api.json");
    snapshot::write(
        &path,
        &json!({"calls":[],"issues":[],"labels":[],"project":{"id":7},"create_issue_delay_ms":60_000}),
    );
    let mut request = Request::new(
        env!("CARGO_BIN_EXE_specgit-process-fixture"),
        &root,
        "fixture",
    )
    .args(["api", "--method", "POST", "repos/fixture/repo/issues"]);
    request.input =
        serde_json::to_vec(&json!({"title":"feat: delayed", "body":"Why", "labels":[]})).unwrap();
    request.env.insert(
        "SPECGIT_FIXTURE_API_FILE".into(),
        path.clone().into_os_string(),
    );
    let runner = Process::default();
    let cancellation = runner.cancellation.clone();
    let task = tokio::spawn(async move { runner.run(request).await });
    let mut delayed = false;
    while !task.is_finished() {
        let state = snapshot::read(&path);
        if state["calls"].as_array().unwrap().len() == 1 && state["issues"] == json!([]) {
            delayed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    cancellation.cancel();
    let result = task.await.unwrap();
    assert!(
        delayed,
        "creation never paused before its write: {result:?}"
    );
    assert_eq!(result.unwrap_err().code, Code::Cancelled);
    let _lock = snapshot::Lock::acquire(&path);
    assert_eq!(snapshot::read(&path)["issues"], json!([]));
}
