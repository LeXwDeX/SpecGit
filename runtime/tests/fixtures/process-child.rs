#[path = "../support/snapshot.rs"]
mod snapshot;
use std::{
    io::{Read, Write},
    time::Duration,
};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    #[cfg(windows)]
    if args.first().map(String::as_str) == Some("console-interrupt") {
        console_interrupt(&args[1..]);
        return;
    }
    if let Some(real_git) = std::env::var_os("SPECGIT_FIXTURE_REAL_GIT")
        && std::env::current_exe()
            .unwrap()
            .file_stem()
            .is_some_and(|n| n == "git")
    {
        let path = std::env::var_os("SPECGIT_FIXTURE_API_FILE").unwrap();
        let mut state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        if args.first().is_some_and(|a| a == "rev-parse")
            && args.get(1).is_some_and(|a| a == "--show-toplevel")
            && state["calls"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["method"] == "GET")
        {
            state["hanging_git_pid"] = serde_json::json!(std::process::id());
            snapshot::write(&path, &state);
            std::thread::sleep(Duration::from_secs(120));
        }
        let status = std::process::Command::new(real_git)
            .args(&args)
            .status()
            .unwrap();
        std::process::exit(status.code().unwrap_or(1));
    }
    if let Some(path) = std::env::var_os("SPECGIT_FIXTURE_API_FILE") {
        native_api(&args, &std::path::PathBuf::from(path));
        return;
    }

    if std::env::var_os("SPECGIT_FIXTURE_PROBE_MODE").is_some()
        && args.first().map(String::as_str) != Some("api")
    {
        println!("fixture command help");
        return;
    }
    if std::env::var_os("SPECGIT_FIXTURE_GIT_TIMEOUT").is_some() {
        if args.first().map(String::as_str) == Some("rev-parse")
            && args.get(1).map(String::as_str) == Some("--show-toplevel")
        {
            if let Some(path) = std::env::var_os("SPECGIT_FIXTURE_READY_PID") {
                snapshot::write(path, &serde_json::json!(std::process::id()));
            }
            std::thread::sleep(Duration::from_secs(120));
        }
        println!("fixture command help");
        return;
    }
    match args.first().map(String::as_str).unwrap_or("") {
        "asset-crash" => {
            use specgit::assets::{AssetStore, Change};
            let root = std::path::PathBuf::from(&args[1]);
            let store = AssetStore::lock(
                &root.join("state"),
                std::slice::from_ref(&root),
                Duration::from_secs(1),
            )
            .unwrap();
            let changes = vec![
                Change::new(root.join("a"), Some(b"a1".to_vec())).unwrap(),
                Change::new(root.join("b"), Some(b"b1".to_vec())).unwrap(),
            ];
            let _ = store.apply_checked(changes, |i| {
                if i == 1 {
                    std::process::exit(99);
                }
                Ok(())
            });
        }
        "echo" => {
            let mut bytes = vec![];
            std::io::stdin().read_to_end(&mut bytes).unwrap();
            std::io::stdout().write_all(&bytes).unwrap();
        }
        "args" => println!("{}", serde_json::to_string(&args[1..]).unwrap()),
        "cwd" => println!("{}", std::env::current_dir().unwrap().display()),
        "flood" => loop {
            if std::io::stdout().write_all(&[b'x'; 8192]).is_err() {
                break;
            }
        },
        "stderr" => loop {
            if std::io::stderr().write_all(&[b'x'; 8192]).is_err() {
                break;
            }
        },
        "hang" => {
            std::thread::sleep(Duration::from_secs(120));
        }
        "exit" => std::process::exit(args[1].parse().unwrap()),
        "spawn" => {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["heartbeat", &args[1]])
                .spawn()
                .unwrap();
            std::fs::write(format!("{}.pid", args[1]), child.id().to_string()).unwrap();
            // The child inherits pipes and remains active after its parent exits.
            std::process::exit(0);
        }
        "heartbeat" => {
            let mut n = 0;
            loop {
                n += 1;
                std::fs::write(&args[1], n.to_string()).unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        "api" => {
            if args.len() != 6
                || args[1] != "--hostname"
                || args[2] != "forge.example"
                || args[3] != "--method"
                || args[4] != "GET"
            {
                std::process::exit(2);
            }

            let mode = std::env::var("SPECGIT_FIXTURE_RESPONSE").unwrap();
            match mode.as_str() {
                "forbidden" => {
                    eprintln!(
                        "HTTP 403 private https://sentinel:secret@example.invalid/?token=secret"
                    );
                    std::process::exit(1);
                }
                "unauth" => {
                    eprintln!("HTTP 401");
                    std::process::exit(1);
                }
                "notfound" => {
                    eprintln!("HTTP 404");
                    std::process::exit(1);
                }
                "rate" => {
                    eprintln!("HTTP 403 rate limit exceeded");
                    std::process::exit(1);
                }
                "network" => {
                    eprintln!("error connecting to host");
                    std::process::exit(1);
                }
                "bad" => print!("{{"),
                _ => print!("{mode}"),
            }
        }
        _ => std::process::exit(2),
    }
}

#[cfg(windows)]
fn console_interrupt(args: &[String]) {
    use std::{
        process::{Command, Stdio},
        time::Instant,
    };
    use windows_sys::Win32::System::Console::{
        CTRL_C_EVENT, GenerateConsoleCtrlEvent, GetConsoleProcessList, SetConsoleCtrlHandler,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };
    // A CI shell can inherit the separate ignore-Ctrl+C attribute into this
    // helper. Registering a callback alone does not reset that inherited flag.
    // SAFETY: null/FALSE restores normal event processing in this fixture only.
    assert_ne!(unsafe { SetConsoleCtrlHandler(None, 0) }, 0);
    static RECEIVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    unsafe extern "system" fn keep_fixture_alive(_event: u32) -> i32 {
        RECEIVED.store(true, std::sync::atomic::Ordering::SeqCst);
        1
    }
    assert_ne!(
        // SAFETY: the static callback has the documented signature. Only this helper's
        // dedicated console receives the later event; the runner has another console.
        unsafe { SetConsoleCtrlHandler(Some(keep_fixture_alive), 1) },
        0
    );
    let mut child = Command::new(&args[0])
        .args(&args[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let ready = std::path::PathBuf::from(std::env::var_os("SPECGIT_FIXTURE_READY_PID").unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !ready.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("native child did not start");
    }
    let git_pid: u32 = serde_json::from_slice(&std::fs::read(&ready).unwrap()).unwrap();
    // SAFETY: the fixture's own readiness file identifies its live Git process.
    // Retaining this handle makes the post-cancellation check immune to PID reuse.
    let git_handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, git_pid) };
    assert!(!git_handle.is_null());
    let mut attached = [0_u32; 32];
    // SAFETY: the array is writable for the supplied length and this query is local.
    let count = unsafe { GetConsoleProcessList(attached.as_mut_ptr(), attached.len() as u32) };
    assert!(count > 0 && count <= attached.len() as u32);
    assert!(
        attached[..count as usize].contains(&child.id()),
        "entrypoint must share the fixture console"
    );
    // SAFETY: group zero targets only this helper's newly allocated console and
    // its attached Node/native children, never the CI runner's console.
    assert_ne!(unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) }, 0);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if child.try_wait().unwrap().is_none() {
        let _ = child.kill();
        let _ = child.wait();
        panic!(
            "console cancellation timed out; helper received event: {}",
            RECEIVED.load(std::sync::atomic::Ordering::SeqCst)
        );
    }
    assert!(RECEIVED.load(std::sync::atomic::Ordering::SeqCst));
    let out = child.wait_with_output().unwrap();
    // SAFETY: the handle remains valid until this single close after the wait.
    let git_stopped = unsafe {
        let status = WaitForSingleObject(git_handle, 1000);
        CloseHandle(git_handle);
        status
    };
    assert_eq!(git_stopped, WAIT_OBJECT_0, "owned Git child must be reaped");
    std::io::stdout().write_all(&out.stdout).unwrap();
    std::io::stderr().write_all(&out.stderr).unwrap();
    std::process::exit(out.status.code().unwrap_or(1));
}

fn native_api(args: &[String], path: &std::path::Path) {
    use serde_json::{Value, json};
    if args.first().is_some_and(|a| a == "pr" || a == "mr") {
        let mut state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        if state["request_fixture"].as_bool() == Some(true) {
            let number: u64 = args[2].parse().unwrap();
            state["calls"]
                .as_array_mut()
                .unwrap()
                .push(json!({"method":"NATIVE","argv":args}));
            if args[1] == "merge" {
                let response = state["merge_response"]
                    .as_str()
                    .unwrap_or("merged")
                    .to_owned();
                let gh = args[0] == "pr";
                if !gh {
                    // glab sends squash only when true, and auto-merge only with
                    // a head pipeline. Model its API semantics, not just argv.
                    let squash = match state["project"]["squash_option"].as_str() {
                        Some("never") => false,
                        Some("always") => true,
                        _ => {
                            args.iter().any(|a| a == "--squash=true" || a == "--squash")
                                || state["requests"][0]["squash"] == true
                        }
                    };
                    let auto = args.iter().any(|a| a == "--auto-merge=true")
                        && state["requests"][0]["pipeline"].is_object();
                    state["effective_merge"] = json!({"squash":squash,"auto_merge":auto});
                }
                let r = &mut state["requests"][0];
                let expected_head = args
                    .windows(2)
                    .find(|a| a[0] == "--match-head-commit" || a[0] == "--sha")
                    .map(|a| a[1].as_str())
                    .unwrap();
                assert_eq!(
                    if gh {
                        r["head"]["sha"].as_str().unwrap()
                    } else {
                        r["sha"].as_str().unwrap()
                    },
                    expected_head
                );
                assert!(!args.iter().any(|a| {
                    ["--admin", "--delete-branch", "--remove-source-branch"].contains(&a.as_str())
                }));
                if ["merged", "lost_merged"].contains(&response.as_str()) {
                    r["merged"] = json!(true);
                    r["state"] = json!(if gh { "closed" } else { "merged" });
                } else if ["queued", "lost_queued"].contains(&response.as_str()) {
                    if gh {
                        r["auto_merge"] = json!({"merge_method":"squash","enabled_by":{"id":99}});
                    } else {
                        r["merge_when_pipeline_succeeds"] = json!(true);
                    }
                }
                if state["close_on_merge"] == true
                    && ["merged", "lost_merged"].contains(&response.as_str())
                {
                    for issue in state["issues"].as_array_mut().unwrap() {
                        issue["state"] = json!("closed");
                    }
                }
                snapshot::write(path, &state);
                if response.starts_with("lost_") || response == "denied" {
                    eprintln!("HTTP 403 native operation denied or response lost");
                    std::process::exit(1);
                }
                println!("native success");
                return;
            }
            let r = state["requests"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|r| r["number"] == number)
                .unwrap();
            r["draft"] = json!(false);
            if let Some(title) = r["title"]
                .as_str()
                .and_then(|s| s.strip_prefix("Draft: "))
                .map(String::from)
            {
                r["title"] = json!(title);
            }
            snapshot::write(path, &state);
            println!("ready");
            return;
        }
    }
    if args.first().map(String::as_str) != Some("api") || args.iter().any(|a| a == "--help") {
        println!("fixture help and version");
        return;
    }
    let mut state: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let method = args
        .windows(2)
        .find(|a| a[0] == "--method")
        .map(|a| a[1].as_str())
        .unwrap_or("");
    let endpoint = args.last().unwrap();
    let input = if method != "GET" {
        let mut b = vec![];
        std::io::stdin().read_to_end(&mut b).unwrap();
        serde_json::from_slice::<Value>(&b).unwrap()
    } else {
        Value::Null
    };
    state["calls"]
        .as_array_mut()
        .unwrap()
        .push(json!({"method":method,"endpoint":endpoint,"body":input}));
    if method == "GET" && state["read_failure"].is_string() {
        state["hanging_reader_pid"] = json!(std::process::id());
        snapshot::write(path, &state);
        if state["read_failure"] == "hang" {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
        eprintln!("HTTP 401 authentication failed");
        std::process::exit(1);
    }
    snapshot::write(path, &state);
    if state["deny"].as_bool() == Some(true) {
        eprintln!("HTTP 403");
        std::process::exit(1);
    }
    if method == "GET" {
        if let Some(value) = state.get("read_routes").and_then(|r| r.get(endpoint)) {
            println!("{value}");
            return;
        }
        if state.get("read_routes").is_some() && state["request_fixture"].as_bool() != Some(true) {
            eprintln!("HTTP 404");
            std::process::exit(1);
        }
    }
    let project_endpoint =
        endpoint == "repos/fixture/repo" || endpoint == "projects/fixture%2Frepo";
    if state["request_fixture"].as_bool() == Some(true)
        && request_api(&mut state, path, method, endpoint, &input)
    {
        return;
    }
    if state.get("issues").is_some() && delivery_api(&mut state, path, method, endpoint, &input) {
        return;
    }
    if method == "GET" {
        if endpoint == "user" {
            println!("{}", json!({"id":1,"login":"fixture","username":"fixture"}));
        } else if endpoint.starts_with("repos/fixture/repo/pulls?")
            || endpoint.starts_with("projects/7/merge_requests?")
        {
            println!("{}", state.get("requests").cloned().unwrap_or(json!([])));
        } else if project_endpoint {
            println!("{}", state["project"]);
        } else {
            eprintln!("HTTP 404");
            std::process::exit(1);
        }
    } else if ["PUT", "PATCH"].contains(&method) && project_endpoint {
        let key = if method == "PATCH" {
            "delete_branch_on_merge"
        } else {
            "remove_source_branch_after_merge"
        };
        if input.as_object().is_none_or(|o| o.len() != 1) || !input[key].is_boolean() {
            std::process::exit(2);
        }
        state["project"][key] = input[key].clone();
        snapshot::write(path, &state);
        println!("{}", state["project"]);
    } else {
        std::process::exit(2);
    }
}

fn request_api(
    state: &mut serde_json::Value,
    path: &std::path::Path,
    method: &str,
    endpoint: &str,
    input: &serde_json::Value,
) -> bool {
    use serde_json::json;
    let gh = endpoint.starts_with("repos/");
    let route = endpoint.split('?').next().unwrap();
    let list = route.ends_with("/pulls") || route.ends_with("/merge_requests");
    let object = route.contains("/pulls/") || route.contains("/merge_requests/");
    let label_write = method == "POST" && route.contains("/issues/") && route.ends_with("/labels");
    let value = if method == "GET" && route.contains("/branches/") {
        let name = route.rsplit('/').next().unwrap();
        let sha = &state["branch_heads"][name];
        if !sha.is_string() {
            eprintln!("HTTP 404");
            std::process::exit(1);
        }
        json!({"name":name,"commit":{"sha":sha,"id":sha}})
    } else if method == "GET" && (route.contains("/compare/") || route.ends_with("/compare")) {
        let files = if state["has_diff"] == true {
            json!([{"filename":"real.rs","new_path":"real.rs"}])
        } else {
            json!([])
        };
        json!({"files":files,"diffs":files,"ahead_by":1,"compare_timeout":false})
    } else if method == "GET" && list {
        state["requests"].clone()
    } else if method == "POST" && list {
        let number = state["requests"].as_array().unwrap().len() as u64 + 41;
        let source = input[if gh { "head" } else { "source_branch" }]
            .as_str()
            .unwrap();
        let target = input[if gh { "base" } else { "target_branch" }]
            .as_str()
            .unwrap();
        let head = &state["branch_heads"][source];
        let r = json!({"id":number+100,"number":number,"iid":number,"title":input["title"],"body":input["body"],"description":input["description"],"labels":[],"draft":true,"state":if gh {"open"} else {"opened"},"merged":false,"head":{"ref":source,"sha":head,"repo":{"id":7}},"base":{"ref":target,"repo":{"id":7}},"source_branch":source,"target_branch":target,"sha":head,"source_project_id":7,"target_project_id":7,"updated_at":"2026-09-09T00:00:00Z"});
        state["requests"].as_array_mut().unwrap().push(r.clone());
        snapshot::write(path, state);
        if state["lose_request_response"] == true {
            eprintln!("connection reset after native request creation");
            std::process::exit(1);
        }
        r
    } else if object || label_write {
        let parts: Vec<_> = route.split('/').collect();
        let number: u64 = parts[if label_write {
            parts.len() - 2
        } else {
            parts.len() - 1
        }]
        .parse()
        .unwrap();
        if method == "GET" {
            state["request_reads"] = json!(state["request_reads"].as_u64().unwrap_or(0) + 1);
        }
        let edit = state["request_reads"].as_u64() == state["edit_request_on_read"].as_u64()
            && state["edit_request_on_read"].is_number();
        let r = state["requests"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|r| r["number"] == number)
            .unwrap();
        if edit {
            r[if gh { "body" } else { "description" }] = json!("Concurrent user edit\n\nCloses #1");
        }
        if method == "GET" {
            r.clone()
        } else if method == "PATCH" || method == "PUT" || label_write {
            if let Some(body) = input.get(if gh { "body" } else { "description" }) {
                r[if gh { "body" } else { "description" }] = body.clone();
            }
            let labels: Vec<String> = if label_write {
                input["labels"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().into())
                    .collect()
            } else {
                input["add_labels"]
                    .as_str()
                    .unwrap_or("")
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect()
            };
            for name in labels {
                let label = if gh {
                    json!({"name":name})
                } else {
                    json!(name)
                };
                if !r["labels"].as_array().unwrap().contains(&label) {
                    r["labels"].as_array_mut().unwrap().push(label);
                }
            }
            r.clone()
        } else {
            return false;
        }
    } else {
        return false;
    };
    snapshot::write(path, state);
    println!("{value}");
    true
}

fn delivery_api(
    state: &mut serde_json::Value,
    path: &std::path::Path,
    method: &str,
    endpoint: &str,
    input: &serde_json::Value,
) -> bool {
    use serde_json::{Value, json};
    let gh = endpoint.starts_with("repos/") || endpoint.starts_with("search/");
    let route = endpoint.split('?').next().unwrap();
    let response = if method == "GET" && endpoint.starts_with("search/issues?") {
        json!({"incomplete_results":state["search_incomplete"].as_bool().unwrap_or(false),"items":state["issues"]})
    } else if method == "GET" && route.ends_with("/issues") {
        state["issues"].clone()
    } else if method == "GET" && route.contains("/issues/") {
        let number: u64 = route.rsplit('/').next().unwrap().parse().unwrap();
        let found = state["issues"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v[if gh { "number" } else { "iid" }].as_u64() == Some(number));
        match found {
            Some(v) => v.clone(),
            None => {
                eprintln!("HTTP 404");
                std::process::exit(1);
            }
        }
    } else if method == "GET" && route.ends_with("/labels") {
        state.get("labels").cloned().unwrap_or(json!([]))
    } else if method == "POST" && route.ends_with("/labels") {
        if state["deny_label"].as_bool() == Some(true) {
            eprintln!("HTTP 403");
            std::process::exit(1);
        }
        if state.get("labels").is_none() {
            state["labels"] = json!([]);
        }
        state["labels"].as_array_mut().unwrap().push(input.clone());
        input.clone()
    } else if method == "POST" && route.ends_with("/issues") {
        let number = state["issues"].as_array().unwrap().len() as u64 + 1;
        let labels = if gh {
            Value::Array(
                input["labels"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| json!({"name":v}))
                    .collect(),
            )
        } else {
            json!(
                input["labels"]
                    .as_str()
                    .unwrap()
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            )
        };
        let value = json!({"id":number+100,"number":number,"iid":number,"project_id":7,"title":input["title"],"body":input["body"],"description":input["description"],"labels":labels,"state":if gh {"open"} else {"opened"},"updated_at":"2026-09-09T00:00:00Z"});
        state["issues"].as_array_mut().unwrap().push(value.clone());
        snapshot::write(path, state);
        if state["lose_issue_response"].as_bool() == Some(true) {
            eprintln!("connection reset after server write");
            std::process::exit(1);
        }
        value
    } else {
        return false;
    };
    snapshot::write(path, state);
    println!("{response}");
    true
}
