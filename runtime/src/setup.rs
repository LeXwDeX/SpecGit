use crate::{
    assets::{self, AssetStore, Change, Snapshot},
    diagnostic::{Code, Diagnostic},
    input,
    probe::{self, Capability, ForgeRead},
    process::Process,
    project::Provider,
    report::Report,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
    time::Duration,
};
const VERSION: &str = env!("CARGO_PKG_VERSION");
#[derive(Clone)]
pub struct Options {
    pub root: PathBuf,
    pub provider: Option<Provider>,
    pub api_host: Option<String>,
    pub claude_settings: Option<PathBuf>,
    pub uninstall: bool,
    pub rollback: Option<String>,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    owner: String,
    files: BTreeMap<String, String>,
    registration: Option<Registration>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Registration {
    settings: PathBuf,
    entries: BTreeMap<String, Value>,
    #[serde(default)]
    created_file: bool,
    #[serde(default)]
    created_hook_map: bool,
    #[serde(default)]
    created_event_keys: Vec<String>,
    #[serde(default)]
    skill: Option<OwnedHostSkill>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct OwnedHostSkill {
    path: PathBuf,
    hash: String,
}
fn skill_bytes() -> Vec<u8> {
    include_str!("../assets/SKILL.md")
        .replace("{{version}}", VERSION)
        .into_bytes()
}
fn conflict(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "setup",
        message,
        "Preserve existing content and explicitly reconcile ownership before retrying.",
    )
}
pub fn default_root() -> Result<PathBuf, Diagnostic> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(|p| PathBuf::from(p).join("SpecGit"))
            .ok_or_else(|| Diagnostic::input("LOCALAPPDATA is unavailable; supply --root."))
    }
    #[cfg(not(windows))]
    {
        #[cfg(not(target_os = "macos"))]
        if let Some(root) = std::env::var_os("XDG_DATA_HOME") {
            return Ok(PathBuf::from(root).join("specgit"));
        }
        let home = std::env::var_os("HOME")
            .ok_or_else(|| Diagnostic::input("Home is unavailable; supply --root."))?;
        #[cfg(target_os = "macos")]
        let suffix = "Library/Application Support/SpecGit";
        #[cfg(not(target_os = "macos"))]
        let suffix = ".local/share/specgit";
        Ok(PathBuf::from(home).join(suffix))
    }
}
pub fn claude_settings() -> Result<PathBuf, Diagnostic> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| Diagnostic::input("Home is unavailable; supply --claude-settings."))?;
    Ok(PathBuf::from(home).join(".claude/settings.json"))
}
fn owned_relative(value: &str) -> bool {
    let p = Path::new(value);
    if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return false;
    }
    if value == "manifest.json" {
        return true;
    }
    let parts: Vec<_> = value.split('/').collect();
    parts.len() >= 4
        && parts[0] == "versions"
        && parts[1].len() <= 64
        && parts[1]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
        && ((parts.len() == 4
            && parts[2] == "bin"
            && ["specgit", "specgit.exe"].contains(&parts[3]))
            || (parts.len() == 5
                && parts[2] == "skills"
                && parts[3] == "specgit-native"
                && parts[4] == "SKILL.md"))
}
fn read_receipt(root: &Path) -> Result<(Snapshot, Receipt), Diagnostic> {
    let snapshot = Snapshot::read(&root.join("ownership.json"))?;
    let receipt = if let Some(bytes) = &snapshot.bytes {
        let value = input::json(bytes, 1_048_576, 20)?;
        let r: Receipt = serde_json::from_value(value)
            .map_err(|_| conflict("The ownership receipt is malformed."))?;
        if r.version != 2
            || r.owner != "specgit"
            || r.files.len() > 30
            || r.files.keys().any(|p| !owned_relative(p))
        {
            return Err(conflict("The ownership receipt is unsupported or unsafe."));
        }
        r
    } else {
        Receipt {
            version: 2,
            owner: "specgit".into(),
            ..Receipt::default()
        }
    };
    Ok((snapshot, receipt))
}
fn manifest(binary: &Path, root: &Path) -> BTreeMap<String, Value> {
    ["SessionStart","PreToolUse","PostToolUse","Stop"].into_iter().map(|event|{
        let mut entry=json!({"matcher":if matches!(event,"PreToolUse"|"PostToolUse"){ "Write|Edit|MultiEdit|Bash|PowerShell" }else{""},"hooks":[{"type":"command","command":binary,"args":["hook","--event",event,"--state-root",root],"timeout":5}]});
        if event == "PostToolUse" {
            entry["hooks"].as_array_mut().expect("hooks is an array").push(json!({"type":"command","command":binary,"args":["hook","--event",event,"--state-root",root,"--observe"],"async":true,"timeout":1830}));
        }
        (event.into(),entry)
    }).collect()
}
/// Merge/remove only exact recorded groups. Unknown top-level and hook fields
/// remain values from the just-read settings; matching a name is not ownership.
fn registration_change(
    path: &Path,
    old: Option<&Registration>,
    new: Option<&BTreeMap<String, Value>>,
) -> Result<Change, Diagnostic> {
    let before = Snapshot::read(path)?;
    let mut settings = match &before.bytes {
        Some(bytes) => input::json(bytes, 1_048_576, 32)?,
        None => json!({}),
    };
    let map = settings
        .as_object_mut()
        .ok_or_else(|| conflict("Claude settings must be a JSON object."))?;
    if let Some(old) = old {
        if old.settings != path {
            return Err(conflict(
                "Registration targets another settings path; uninstall it explicitly first.",
            ));
        }
        let hooks = map
            .get_mut("hooks")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| conflict("Recorded host hooks were removed or changed."))?;
        for (event, entry) in &old.entries {
            let array = hooks
                .get_mut(event)
                .and_then(Value::as_array_mut)
                .ok_or_else(|| conflict("Recorded host event is missing."))?;
            let positions: Vec<_> = array
                .iter()
                .enumerate()
                .filter(|(_, v)| *v == entry)
                .map(|(i, _)| i)
                .collect();
            if positions.len() != 1 {
                return Err(conflict(
                    "Owned host registration is edited, missing, or duplicated.",
                ));
            }
            if let Some(replacement) = new.and_then(|entries| entries.get(event)) {
                array[positions[0]] = replacement.clone();
            } else {
                array.remove(positions[0]);
            }
            if array.is_empty() && old.created_event_keys.contains(event) {
                hooks.remove(event);
            }
        }
        if hooks.is_empty() && old.created_hook_map {
            map.remove("hooks");
        }
    }
    if let Some(new) = new {
        let hooks = map
            .entry("hooks")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| conflict("Claude hooks is not an object."))?;
        for (event, entry) in new {
            if old.is_some_and(|old| old.entries.contains_key(event)) {
                continue;
            }
            let array = hooks
                .entry(event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or_else(|| conflict("Claude hook event is not an array."))?;
            if array.contains(entry) {
                return Err(conflict(
                    "An identical unowned host hook already exists; explicit adoption is required.",
                ));
            }
            array.push(entry.clone());
        }
    }
    if new.is_none()
        && old.is_some_and(|old| old.created_file)
        && settings.as_object().is_some_and(|o| o.is_empty())
    {
        return Ok(Change {
            path: path.into(),
            permissions: before.permissions.clone(),
            before,
            after: None,
        });
    }
    let after = serde_json::to_vec_pretty(&settings)
        .map_err(|_| Diagnostic::input("Host settings cannot be represented."))?;
    // Preserve original formatting exactly when the semantic configuration is unchanged.
    let after = if before
        .bytes
        .as_ref()
        .is_some_and(|bytes| input::json(bytes, 1_048_576, 32).ok().as_ref() == Some(&settings))
    {
        before.bytes.clone().unwrap()
    } else {
        [after, b"\n".to_vec()].concat()
    };
    Ok(Change {
        path: path.into(),
        permissions: before.permissions.clone(),
        before,
        after: Some(after),
    })
}
pub fn install(options: &Options, source: &Path) -> Result<Value, Diagnostic> {
    assets::safe_path(&options.root)?;
    let (planned_snapshot, planned_receipt) = read_receipt(&options.root)?;
    let selected_settings = options.claude_settings.clone().or_else(|| {
        planned_receipt
            .registration
            .as_ref()
            .map(|r| r.settings.clone())
    });
    let mut allowed = vec![options.root.clone()];
    if let Some(path) = &selected_settings {
        allowed.push(
            path.parent()
                .ok_or_else(|| Diagnostic::input("Invalid settings path."))?
                .to_owned(),
        );
    }
    let store = AssetStore::lock(&options.root, &allowed, Duration::from_secs(2))?;
    if let Some(id) = &options.rollback {
        return Ok(json!({"rolled_back":store.rollback(id)?}));
    }
    let (receipt_snapshot, previous) = read_receipt(&options.root)?;
    if receipt_snapshot.digest() != planned_snapshot.digest() {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "setup",
            "Ownership changed while acquiring the lock.",
            "Refresh setup after the other operation completes.",
        ));
    }
    let mut changes = vec![];
    for (relative, digest) in &previous.files {
        let change = Change::new(options.root.join(relative), None)?;
        if change.before.digest().as_ref() != Some(digest) {
            return Err(conflict("An owned global asset was edited or removed."));
        }
        changes.push(change);
    }
    let mut receipt = Receipt {
        version: 2,
        owner: "specgit".into(),
        ..Receipt::default()
    };
    let mut entries = None;
    if !options.uninstall {
        let binary_relative = format!(
            "versions/{VERSION}/bin/specgit{}",
            if cfg!(windows) { ".exe" } else { "" }
        );
        let skill_relative = format!("versions/{VERSION}/skills/specgit-native/SKILL.md");
        let binary = Snapshot::read(source)?;
        let binary_bytes = binary
            .bytes
            .ok_or_else(|| Diagnostic::input("Native source executable is unavailable."))?;
        let generated = manifest(&options.root.join(&binary_relative), &options.root);
        let exported: BTreeMap<_, _> = generated
            .iter()
            .map(|(event, entry)| (event, vec![entry]))
            .collect();
        let manifest_bytes = serde_json::to_vec_pretty(&json!({"hooks":exported}))
            .map_err(|_| Diagnostic::input("Manifest cannot be represented."))?;
        for (relative, bytes, permissions) in [
            (binary_relative, binary_bytes, binary.permissions),
            (skill_relative, skill_bytes(), None),
            ("manifest.json".into(), manifest_bytes, None),
        ] {
            let mut change = Change::new(options.root.join(&relative), Some(bytes.clone()))?;
            if change.before.bytes.is_some() && !previous.files.contains_key(&relative) {
                return Err(conflict(
                    "A global destination already contains an unowned file.",
                ));
            }
            if let Some(permissions) = permissions {
                #[cfg(unix)]
                if let Some(existing) = &change.before.permissions {
                    use std::os::unix::fs::PermissionsExt;
                    if existing.mode() & 0o111 == 0 {
                        return Err(conflict(
                            "The owned native executable lost its execute permission.",
                        ));
                    }
                }
                if change.before.bytes.is_none() {
                    change.permissions = Some(permissions);
                }
            }
            receipt.files.insert(relative.clone(), assets::hash(&bytes));
            changes.retain(|c| c.path != change.path);
            changes.push(change);
        }
        entries = Some(generated);
    }
    if let Some(old) = &previous.registration
        && selected_settings.as_ref() != Some(&old.settings)
    {
        return Err(conflict(
            "Repeat the explicit registered settings path to update or uninstall host entries.",
        ));
    }
    if let Some(settings) = &selected_settings {
        if options.uninstall && previous.registration.is_none() {
            return Err(conflict(
                "There is no owned registration at the selected host path.",
            ));
        }
        let host_skill_path = settings
            .parent()
            .ok_or_else(|| Diagnostic::input("Invalid host settings path."))?
            .join("skills/specgit-native/SKILL.md");
        let prior_skill = previous
            .registration
            .as_ref()
            .and_then(|r| r.skill.as_ref());
        if prior_skill.is_some_and(|s| s.path != host_skill_path) {
            return Err(conflict("Recorded host skill has an unexpected path."));
        }
        let host_skill = Change::new(
            host_skill_path.clone(),
            if options.uninstall {
                None
            } else {
                Some(skill_bytes())
            },
        )?;
        if let Some(old) = prior_skill {
            if host_skill.before.digest().as_ref() != Some(&old.hash) {
                return Err(conflict(
                    "The owned native host skill was edited or removed.",
                ));
            }
        } else if host_skill.before.bytes.is_some() {
            return Err(conflict(
                "The native host skill path is already owned by another installation.",
            ));
        }
        changes.push(host_skill);
        let change =
            registration_change(settings, previous.registration.as_ref(), entries.as_ref())?;
        if let Some(entries) = entries {
            let mut registration = if let Some(old) = &previous.registration {
                old.clone()
            } else {
                let before = match &change.before.bytes {
                    Some(bytes) => input::json(bytes, 1_048_576, 32)?,
                    None => json!({}),
                };
                Registration {
                    settings: settings.clone(),
                    entries: BTreeMap::new(),
                    created_file: change.before.bytes.is_none(),
                    created_hook_map: before.get("hooks").is_none(),
                    skill: None,
                    created_event_keys: entries
                        .keys()
                        .filter(|event| before.get("hooks").and_then(|h| h.get(*event)).is_none())
                        .cloned()
                        .collect(),
                }
            };
            registration.entries = entries;
            registration.skill = Some(OwnedHostSkill {
                path: host_skill_path,
                hash: assets::hash(&skill_bytes()),
            });
            receipt.registration = Some(registration);
        }
        changes.push(change);
    }
    let after = if options.uninstall {
        None
    } else {
        Some(
            serde_json::to_vec_pretty(&receipt)
                .map_err(|_| Diagnostic::input("Receipt cannot be represented."))?,
        )
    };
    changes.push(Change {
        path: options.root.join("ownership.json"),
        permissions: receipt_snapshot.permissions.clone(),
        before: receipt_snapshot,
        after,
    });
    let summary:Vec<_>=changes.iter().map(|c|json!({"path":c.path,"state":if c.unchanged(){"unchanged"}else if c.after.is_none(){"removed"}else if c.before.bytes.is_none(){"created"}else{"updated"}})).collect();
    let applied = store.apply(changes)?;
    Ok(
        json!({"schema_version":2,"version":VERSION,"root":options.root,"assets":summary,"transaction":applied,"manifest_exported":!options.uninstall,"registration":if selected_settings.is_some()&&!options.uninstall{"written_not_verified"}else{"not_registered"},"host_delivery":{"imported_event":"not_checked","context_injection":"not_checked","visible_message":"not_checked","next_turn":"not_checked","idle_wake":"not_supported"}}),
    )
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    let mut probes = vec![];
    if !options.uninstall && options.rollback.is_none() {
        let provider = match options.provider {
            Some(p) => p,
            None => {
                return Report::failure(
                    "setup",
                    Diagnostic::input("Select --provider github or gitlab."),
                );
            }
        };
        probes = probe::commands(&process, cwd, provider).await;
        let host = options
            .api_host
            .as_deref()
            .unwrap_or(if provider == Provider::Github {
                "github.com"
            } else {
                "gitlab.com"
            });
        match ForgeRead::new(process, cwd, provider, host) {
            Ok(reader) => probes.push(probe::account(&reader).await),
            Err(d) => probes.push(probe::Probe::failed("account_api", d)),
        };
        probes.push(probe::Probe::not_checked("project_api"));
    }
    let source = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => {
            return Report::failure(
                "setup",
                Diagnostic::input("Current executable is unavailable."),
            );
        }
    };
    match install(&options, &source) {
        Ok(mut evidence) => {
            let ready = probes
                .iter()
                .all(|p| matches!(p.status, Capability::Available | Capability::NotChecked));
            evidence["probes"] = json!(probes);
            evidence["write_permissions"] = json!("not_checked");
            evidence["readiness"] = json!(if ready { "available" } else { "unknown" });
            let mut report = Report::success(
                "setup",
                if options.rollback.is_some() {
                    "rolled_back"
                } else if options.uninstall {
                    "uninstalled"
                } else {
                    "installed"
                },
                evidence,
            );
            if !ready {
                report.exit = 3;
            }
            report
        }
        Err(d) => Report::failure("setup", d),
    }
}
