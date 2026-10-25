#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use acceptance::fixture;
use serde_json::{Value, json};
use specgit::{
    assets::AssetStore,
    diagnostic::Code,
    process::Process,
    watch,
    watch_store::{self, EventState, Goal, Identity},
};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::Path,
    time::{Duration, Instant},
};

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Environment {
    saved: Vec<(&'static str, Option<OsString>)>,
}
impl Environment {
    fn install(f: &delivery::Fixture) -> Self {
        const KEYS: [&str; 4] = [
            "PATH",
            "SPECGIT_FIXTURE_ASSET_PAUSE",
            "SPECGIT_FIXTURE_ASSET_PAUSE_DIR",
            "SPECGIT_FIXTURE_ASSET_PAUSE_TARGET",
        ];
        let saved = KEYS
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect();
        let bin = f.root.parent().unwrap().join("bin");
        let mut paths = vec![bin];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        set("PATH", std::env::join_paths(paths).unwrap());
        Self { saved }
    }
    fn set(&self, key: &'static str, value: impl AsRef<std::ffi::OsStr>) {
        set(key, value);
    }
}
impl Drop for Environment {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(value) => set(key, value),
                None => {
                    // SAFETY: this dedicated test binary serializes its two
                    // public-API tests with ENV_LOCK and no other test runs here.
                    unsafe { std::env::remove_var(key) };
                }
            }
        }
    }
}
fn set(key: &str, value: impl AsRef<std::ffi::OsStr>) {
    // SAFETY: this dedicated test binary serializes its two public-API tests
    // with ENV_LOCK; no other test observes these process-global values.
    unsafe { std::env::set_var(key, value.as_ref()) };
}

fn complete_request(f: &delivery::Fixture) {
    f.edit(|s| {
        s["native_closing"] = json!([1]);
        s["requests"][0]["state"] = json!("closed");
        s["requests"][0]["merged"] = json!(true);
        s["issues"][0]["state"] = json!("closed");
    });
}

fn public_process(f: &delivery::Fixture) -> Process {
    let base = f.root.parent().unwrap();
    let mut environment = BTreeMap::new();
    environment.insert("PATH".into(), std::env::var_os("PATH").unwrap());
    environment.insert("HOME".into(), base.into());
    environment.insert("LOCALAPPDATA".into(), base.into());
    environment.insert("XDG_DATA_HOME".into(), base.into());
    environment.insert(
        "SPECGIT_FIXTURE_API_FILE".into(),
        base.join("api.json").into(),
    );
    Process {
        environment,
        ..Process::default()
    }
}

fn options() -> watch::Options {
    watch::Options {
        request: 41,
        session: "session-a".into(),
        goal: Goal::Lifecycle,
        timeout_seconds: None,
        poll_seconds: None,
        once: true,
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn completed_event(f: &delivery::Fixture) -> watch_store::State {
    let runtime = runtime();
    let context = runtime
        .block_on(watch::local(&public_process(f), &f.root))
        .unwrap();
    let identity = Identity::new(&context, "session-a", 41, Goal::Lifecycle).unwrap();
    let state = watch_store::read(&identity).unwrap().unwrap();
    assert_eq!(state.events.len(), 1, "{state:?}");
    assert_eq!(state.events[0].state, EventState::Completed, "{state:?}");
    assert!(!state.events[0].superseded, "{state:?}");
    state
}

fn checkpoint(f: &delivery::Fixture) -> Value {
    serde_json::from_slice(&fs::read(f.root.join(".git/specgit-v2/selection.json")).unwrap())
        .unwrap()
}

fn hold_delivery_lock(f: &delivery::Fixture) -> AssetStore {
    let root = f.root.join(".git/specgit-v2");
    AssetStore::lock(
        &root.join("delivery-transactions"),
        std::slice::from_ref(&root),
        Duration::from_millis(100),
    )
    .unwrap()
}

fn expect_public_error(
    result: Result<watch::ObservedEvents, specgit::diagnostic::Diagnostic>,
    message: &str,
) -> specgit::diagnostic::Diagnostic {
    match result {
        Ok(_) => panic!("{message}"),
        Err(error) => error,
    }
}

fn await_pause(pause: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !pause.join("ready").exists() {
        assert!(
            Instant::now() < deadline,
            "public watch did not reach the checkpoint write barrier"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
struct DeniedCheckpointDirectory {
    path: std::path::PathBuf,
    permissions: fs::Permissions,
}
#[cfg(unix)]
impl DeniedCheckpointDirectory {
    fn new(path: &Path) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(path).unwrap().permissions();
        fs::set_permissions(path, fs::Permissions::from_mode(0o500)).unwrap();
        Self {
            path: path.to_owned(),
            permissions,
        }
    }
}
#[cfg(unix)]
impl Drop for DeniedCheckpointDirectory {
    fn drop(&mut self) {
        fs::set_permissions(&self.path, self.permissions.clone()).unwrap();
    }
}

#[test]
fn public_subscribe_returns_lock_error_after_publishing_the_completed_event() {
    let _serial = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let f = fixture("github");
    complete_request(&f);
    let writes = f.writes();
    let _environment = Environment::install(&f);
    let held = hold_delivery_lock(&f);
    let error = expect_public_error(
        runtime().block_on(watch::observe_subscription(
            options(),
            public_process(&f),
            &f.root,
        )),
        "public watch must not hide a lock failure",
    );
    assert_eq!(error.code, Code::LockBusy, "{error:?}");
    assert_eq!(error.operation, "delivered_checkpoint", "{error:?}");
    drop(held);

    completed_event(&f);
    assert!(checkpoint(&f).get("delivered_request").is_none());
    assert_eq!(f.writes(), writes);
}

#[cfg(unix)]
#[test]
fn public_until_attention_returns_permission_error_after_publishing_the_completed_event() {
    let _serial = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let f = fixture("github");
    complete_request(&f);
    let writes = f.writes();
    let environment = Environment::install(&f);
    let pause = tempfile::tempdir().unwrap();
    environment.set(
        "SPECGIT_FIXTURE_ASSET_PAUSE",
        "checkpoint-before-atomic-write",
    );
    environment.set("SPECGIT_FIXTURE_ASSET_PAUSE_DIR", pause.path());
    environment.set(
        "SPECGIT_FIXTURE_ASSET_PAUSE_TARGET",
        f.root.join(".git/specgit-v2/selection.json"),
    );
    let root = f.root.clone();
    let process = public_process(&f);
    let writer = std::thread::Builder::new()
        .stack_size(8 * 1024 * 1024)
        .spawn(move || {
            runtime().block_on(watch::observe_until_attention(options(), process, &root))
        })
        .unwrap();
    await_pause(pause.path());
    let denied = DeniedCheckpointDirectory::new(&f.root.join(".git/specgit-v2"));
    fs::write(pause.path().join("go"), b"go").unwrap();
    let error = expect_public_error(
        writer.join().unwrap(),
        "public watch must not hide a permission failure",
    );
    drop(denied);
    assert_eq!(error.code, Code::IoFailed, "{error:?}");
    assert_eq!(error.operation, "delivered_checkpoint", "{error:?}");
    assert!(error.message.contains("PermissionDenied"), "{error:?}");

    completed_event(&f);
    assert!(checkpoint(&f).get("delivered_request").is_none());
    assert_eq!(f.writes(), writes);
}
