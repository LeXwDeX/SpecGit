#![cfg(feature = "test-fixtures")]
use specgit::{
    diagnostic::Code,
    process::{Limits, Process, Request},
};
use std::{path::PathBuf, time::Duration};
fn request(args: &[&str]) -> Request {
    Request::new(
        PathBuf::from(env!("CARGO_BIN_EXE_specgit-process-fixture")),
        &std::env::current_dir().unwrap(),
        "fixture",
    )
    .args(args.iter().copied())
}
fn process() -> Process {
    Process {
        limits: Limits {
            timeout: Duration::from_secs(3),
            input_bytes: 65536,
            output_bytes: 65536,
        },
        ..Process::default()
    }
}
#[tokio::test]
async fn preserves_exact_bytes_arguments_cwd_and_exit() {
    let runner = process();
    let mut r = request(&["echo"]);
    r.input = (0..=255).cycle().take(32768).collect();
    let expected = r.input.clone();
    assert_eq!(runner.run(r).await.unwrap().stdout, expected);
    let out = runner
        .run(request(&[
            "args",
            "space path",
            "汉字",
            "$HOME",
            "`id`",
            "a&b",
            "a\"b",
        ]))
        .await
        .unwrap();
    let args: Vec<String> = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        args,
        vec!["space path", "汉字", "$HOME", "`id`", "a&b", "a\"b"]
    );
    let root = tempfile::Builder::new()
        .prefix("SpecGit 空格 ")
        .tempdir()
        .unwrap();
    let mut r = request(&["cwd"]);
    r.cwd = root.path().canonicalize().unwrap();
    let out = runner.run(r).await.unwrap();
    assert_eq!(
        PathBuf::from(String::from_utf8(out.stdout).unwrap().trim_end())
            .canonicalize()
            .unwrap(),
        root.path().canonicalize().unwrap()
    );
    assert_eq!(runner.run(request(&["exit", "7"])).await.unwrap().code, 7);
}
#[tokio::test]
async fn refuses_input_overflow_and_both_output_streams() {
    let runner = process();
    let mut r = request(&["echo"]);
    r.input = vec![0; 65537];
    assert_eq!(runner.run(r).await.unwrap_err().code, Code::InputLimit);
    for mode in ["flood", "stderr"] {
        assert_eq!(
            runner.run(request(&[mode])).await.unwrap_err().code,
            Code::OutputLimit
        );
    }
}
#[tokio::test]
async fn deadline_covers_stalled_stdin_and_process_wait() {
    let runner = Process {
        limits: Limits {
            timeout: Duration::from_millis(200),
            ..Limits::default()
        },
        ..Process::default()
    };
    let mut r = request(&["hang"]);
    r.input = vec![0; 1_048_576];
    let start = std::time::Instant::now();
    assert_eq!(runner.run(r).await.unwrap_err().code, Code::Timeout);
    assert!(start.elapsed() < Duration::from_secs(5));
}
#[tokio::test]
async fn cancellation_and_deadline_stop_descendants_after_parent_exits() {
    for cancel in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let heartbeat = root.path().join("heartbeat");
        let runner = Process {
            limits: Limits {
                timeout: Duration::from_millis(900),
                ..Limits::default()
            },
            ..Process::default()
        };
        let token = runner.cancellation.clone();
        let r = request(&["spawn", heartbeat.to_str().unwrap()]);
        let task = tokio::spawn(async move { runner.run(r).await });
        for _ in 0..80 {
            if heartbeat.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(heartbeat.exists(), "descendant actually started");
        if cancel {
            token.cancel();
        }
        assert_eq!(
            task.await.unwrap().unwrap_err().code,
            if cancel {
                Code::Cancelled
            } else {
                Code::Timeout
            }
        );
        let value = std::fs::read(&heartbeat).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            std::fs::read(&heartbeat).unwrap(),
            value,
            "owned descendant no longer executes"
        );
    }
}
#[tokio::test]
async fn already_cancelled_does_not_spawn() {
    let runner = process();
    runner.cancellation.cancel();
    assert_eq!(
        runner.run(request(&["hang"])).await.unwrap_err().code,
        Code::Cancelled
    );
}

#[tokio::test]
async fn dropped_operation_stops_owned_descendants() {
    let root = tempfile::tempdir().unwrap();
    let heartbeat = root.path().join("heartbeat");
    let runner = process();
    let r = request(&["spawn", heartbeat.to_str().unwrap()]);
    let task = tokio::spawn(async move { runner.run(r).await });
    for _ in 0..100 {
        if heartbeat.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(heartbeat.exists());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::sleep(Duration::from_millis(100)).await;
    let value = std::fs::read(&heartbeat).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(std::fs::read(&heartbeat).unwrap(), value);
}
