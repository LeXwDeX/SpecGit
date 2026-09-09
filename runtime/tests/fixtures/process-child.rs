use std::{
    io::{Read, Write},
    time::Duration,
};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
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
