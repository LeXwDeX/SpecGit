use std::{
    io::{Read, Write},
    time::Duration,
};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
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

fn native_api(args: &[String], path: &std::path::Path) {
    use serde_json::{Value, json};
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
    std::fs::write(path, serde_json::to_vec(&state).unwrap()).unwrap();
    if state["deny"].as_bool() == Some(true) {
        eprintln!("HTTP 403");
        std::process::exit(1);
    }
    let project_endpoint =
        endpoint == "repos/fixture/repo" || endpoint == "projects/fixture%2Frepo";
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
        std::fs::write(path, serde_json::to_vec(&state).unwrap()).unwrap();
        println!("{}", state["project"]);
    } else {
        std::process::exit(2);
    }
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
        std::fs::write(path, serde_json::to_vec(state).unwrap()).unwrap();
        if state["lose_issue_response"].as_bool() == Some(true) {
            eprintln!("connection reset after server write");
            std::process::exit(1);
        }
        value
    } else {
        return false;
    };
    std::fs::write(path, serde_json::to_vec(state).unwrap()).unwrap();
    println!("{response}");
    true
}
