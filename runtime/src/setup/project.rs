//! Checkout assets and a worktree-private receipt, never a project executable.
use super::*;
use std::collections::BTreeSet;

#[derive(Clone)]
pub struct Options {
    pub agents: Vec<Agent>,
    pub opencode_claude_hooks: bool,
    pub uninstall: bool,
    pub dry_run: bool,
    pub rollback: Option<String>,
}

use crate::project_receipt::ProjectReceipt;

/// New init and setup transactions share one lock and history. Existing setup
/// journals remain read-only evidence for installations created before migration.
fn transaction_store(private: &Path) -> PathBuf {
    private.parent().unwrap_or(private).join("assets")
}
fn owned_pair(
    private: &Path,
    receipt_path: &Path,
    receipt: &Snapshot,
    asset_path: &Path,
    asset: &Snapshot,
    digest: Option<&str>,
) -> Result<Option<Vec<Change>>, Diagnostic> {
    let mut stores = vec![transaction_store(private), private.to_owned()];
    if let Some(bytes) = &receipt.bytes {
        stores.extend(crate::config::worktree::shared_setup_guard_stores(
            &crate::project_receipt::decode(bytes)?.root,
        )?);
    }
    AssetStore::owned_pair_across_at(&stores, receipt_path, receipt, asset_path, asset, digest)
}

fn installation_generation() -> Result<String, Diagnostic> {
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce).map_err(|_| {
        Diagnostic::new(
            Code::IoFailed,
            "setup",
            "A unique installation identity could not be generated.",
            "Retry when operating-system randomness is available; no installation was accepted.",
        )
    })?;
    Ok(nonce.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn same_project_root(recorded: &Path, current: &Path) -> Result<bool, Diagnostic> {
    #[cfg(windows)]
    {
        assets::safe_path(recorded)?;
        assets::safe_path(current)?;
        let recorded = recorded
            .canonicalize()
            .map_err(|_| conflict("The recorded project root cannot be resolved safely."))?;
        let current = current
            .canonicalize()
            .map_err(|_| conflict("The current project root cannot be resolved safely."))?;
        Ok(recorded == current)
    }
    #[cfg(not(windows))]
    {
        Ok(recorded == current)
    }
}

fn read(root: &Path, private: &Path) -> Result<(Snapshot, ProjectReceipt), Diagnostic> {
    let snapshot = Snapshot::read(&private.join("ownership.json"))?;
    let receipt = if let Some(bytes) = &snapshot.bytes {
        let mut r = crate::project_receipt::decode(bytes)?;
        if !same_project_root(&r.root, root)? {
            return Err(conflict(
                "The project integration receipt belongs to another root.",
            ));
        }
        // The receipt records the root spelling used at installation. Git may
        // later return the same Windows directory without its extended prefix.
        // Rebase only verified project paths to the current spelling so planned
        // targets and the asset store's explicit roots use one representation.
        r.root = root.to_path_buf();
        for registration in r.instructions.values_mut() {
            registration.root = root.to_path_buf();
        }
        for (host, registration) in &mut r.hooks {
            let relative = match host.as_str() {
                "claude" => ".claude/settings.json",
                "codex" => ".codex/hooks.json",
                "opencode" => ".opencode/hooks.json",
                _ => unreachable!("validated host"),
            };
            registration.settings = root.join(relative);
        }
        r
    } else {
        ProjectReceipt {
            version: 4,
            owner: "specgit".into(),
            root: root.into(),
            shared_root: None,
            generation: None,
            agents: BTreeSet::new(),
            skills: BTreeMap::new(),
            instructions: BTreeMap::new(),
            hooks: BTreeMap::new(),
            purposes: BTreeMap::new(),
        }
    };
    Ok((snapshot, receipt))
}

fn shared_executable(source: &Path, project: &Path) -> Result<Snapshot, Diagnostic> {
    assets::safe_path(source)?;
    assets::safe_path(project)?;
    if !source.is_absolute() || !project.is_absolute() {
        return Err(Diagnostic::input(
            "Project hooks require the installed shared CLI outside this checkout; setup never installs a project executable.",
        ));
    }
    let snapshot = Snapshot::read(source)?;
    if snapshot.bytes.as_ref().is_none_or(Vec::is_empty) {
        return Err(conflict_at(
            "shared",
            source,
            None,
            "The installed shared executable is unavailable.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if snapshot
            .permissions
            .as_ref()
            .is_none_or(|p| p.mode() & 0o111 == 0)
        {
            return Err(conflict_at(
                "shared",
                source,
                None,
                "The shared executable lost execute permission.",
            ));
        }
    }
    if shared_inside_project(source, project)?
        || crate::config::worktree::source_in_same_repository_checkout(source, project)?
    {
        return Err(Diagnostic::input(
            "Project hooks require the installed shared CLI outside this checkout; setup never installs a project executable.",
        ));
    }
    Ok(snapshot)
}

fn codex_override_shadows(root: &Path) -> Result<bool, Diagnostic> {
    Ok(Snapshot::read(&root.join("AGENTS.override.md"))?
        .bytes
        .is_some_and(|bytes| !bytes.iter().all(u8::is_ascii_whitespace)))
}

fn shared_inside_project(source: &Path, project: &Path) -> Result<bool, Diagnostic> {
    let source = source.canonicalize().map_err(|_| {
        conflict_at(
            "shared",
            source,
            None,
            "The shared executable path cannot be resolved.",
        )
    })?;
    let project = project.canonicalize().map_err(|_| {
        conflict_at(
            "project",
            project,
            None,
            "The project root cannot be resolved.",
        )
    })?;
    Ok(source.starts_with(project))
}

fn orphan_at(path: &Path, message: &str) -> Diagnostic {
    let mut diagnostic = conflict_at("project", path, None, message);
    diagnostic.remedy = "Preserve the file. Find the matching worktree ownership receipt or reconcile this orphaned SpecGit asset explicitly before retrying; doctor will not adopt it.".into();
    diagnostic
}

fn orphan_hook_executable(host: &str, event: &str, group: &Value) -> Option<PathBuf> {
    let hook = group.get("hooks")?.as_array()?.first()?;
    let command = hook.get("command")?.as_str()?;
    if command.len() > 8192 {
        return None;
    }
    let shell_command = host == "opencode" || (host == "codex" && hook.get("args").is_none());
    let executable = if shell_command {
        let command = command.strip_suffix(&format!(" hook --event {event}"))?;
        let body = if cfg!(windows) && host == "codex" {
            command.strip_prefix('"')?.strip_suffix('"')?.to_owned()
        } else {
            command
                .strip_prefix('\'')?
                .strip_suffix('\'')?
                .replace("'\\''", "'")
        };
        PathBuf::from(body)
    } else {
        PathBuf::from(command)
    };
    executable.is_absolute().then_some(executable)
}

fn orphan_hook_registration(root: &Path) -> Result<Option<PathBuf>, Diagnostic> {
    for (agent, host, relative) in [
        (Agent::Claude, "claude", ".claude/settings.json"),
        (Agent::Codex, "codex", ".codex/hooks.json"),
        (Agent::Opencode, "opencode", ".opencode/hooks.json"),
    ] {
        let path = root.join(relative);
        let Some(bytes) = Snapshot::read(&path)?.bytes else {
            continue;
        };
        let Ok(settings) = input::json(&bytes, 1_048_576, 32) else {
            continue;
        };
        let Some(events) = (if host == "opencode" {
            settings.as_object()
        } else {
            settings.get("hooks").and_then(Value::as_object)
        }) else {
            continue;
        };
        for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] {
            let Some(groups) = events.get(event).and_then(Value::as_array) else {
                continue;
            };
            if groups.iter().any(|candidate| {
                let Some(executable) = orphan_hook_executable(host, event, candidate) else {
                    return false;
                };
                // Retired events still identify receiptless registrations
                // written through 2.12, so compare with the legacy shape.
                let expected = if host == "opencode" {
                    legacy_opencode_manifest(&executable)
                } else {
                    legacy_manifest(&executable, agent)
                };
                let mut recognized: Vec<_> = expected.into_iter().collect();
                if agent == Agent::Codex {
                    // Recognize 2.9.2's executable + argv protocol only to
                    // report an orphan. Exact comparison grants no ownership.
                    recognized.extend(legacy_manifest(&executable, Agent::Claude));
                }
                recognized.iter().any(|expected| {
                    let Some(group) = expected.get(event) else {
                        return false;
                    };
                    candidate == group
                        || (event == "PostToolUse" && host != "opencode" && {
                            let mut without_observer = group.clone();
                            if let Some(hooks) = without_observer["hooks"].as_array_mut() {
                                hooks.truncate(1);
                            }
                            candidate == &without_observer
                        })
                })
            }) {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

pub(crate) fn removal(root: &Path, private: &Path) -> Result<Vec<Change>, Diagnostic> {
    let (snapshot, receipt) = read(root, private)?;
    if snapshot.bytes.is_none() {
        return Ok(vec![]);
    }
    let receipt_path = private.join("ownership.json");
    let mut changes = vec![];
    let mut add_proven_change =
        |change: Change, digest: Option<&str>, host: &str| -> Result<(), Diagnostic> {
            let proofs = owned_pair(
                private,
                &receipt_path,
                &snapshot,
                &change.path,
                &change.before,
                digest,
            )?
            .ok_or_else(|| {
                conflict_at(
                    host,
                    &change.path,
                    None,
                    "Project asset ownership or permissions cannot be proved.",
                )
            })?;
            for proof in proofs {
                if !changes.iter().any(|old: &Change| old.path == proof.path) {
                    changes.push(proof);
                }
            }
            changes.push(change);
            Ok(())
        };
    for (relative, digest) in &receipt.skills {
        let c = Change::new(root.join(relative), None)?;
        if c.before.digest().as_ref() != Some(digest) {
            return Err(conflict_at(
                "project",
                &c.path,
                None,
                "The owned project skill was edited or removed.",
            ));
        }
        add_proven_change(c, Some(digest), "project")?;
    }
    for (host, old) in &receipt.instructions {
        add_proven_change(
            instruction_change(host, root, Some(old), true, false)?.0,
            None,
            host,
        )?;
    }
    for (host, old) in &receipt.hooks {
        add_proven_change(
            registration_change(host, &old.settings, Some(old), None)?,
            None,
            host,
        )?;
    }
    changes.push(Change {
        path: receipt_path,
        permissions: snapshot.permissions.clone(),
        before: snapshot,
        after: None,
    });
    Ok(changes)
}

pub fn install(
    options: &Options,
    root: &Path,
    private: &Path,
    source: &Path,
) -> Result<Value, Diagnostic> {
    install_with_hooks(options, &HookOptions::default(), root, private, source)
}

pub fn install_with_hooks(
    options: &Options,
    hooks: &HookOptions,
    root: &Path,
    private: &Path,
    source: &Path,
) -> Result<Value, Diagnostic> {
    install_plan(options, hooks, root, private, source, None, None)
}

fn purposes_for(previous: &ProjectReceipt, host: &str) -> (BTreeSet<HookPurpose>, bool) {
    if previous.version >= 4 {
        (
            previous.purposes.get(host).cloned().unwrap_or_default(),
            false,
        )
    } else {
        recorded_purposes(previous.hooks.get(host))
    }
}
fn wants_guard(previous: &ProjectReceipt) -> bool {
    ["generic", "claude", "codex", "opencode"]
        .iter()
        .any(|host| purposes_for(previous, host).0.contains(&HookPurpose::Guard))
}

pub fn install_with_guard_plan(
    options: &Options,
    hooks: &HookOptions,
    root: &Path,
    private: &Path,
    source: &Path,
    native: crate::guard::SetupPlan,
) -> Result<Value, Diagnostic> {
    if options.rollback.is_some() {
        return Err(Diagnostic::input(
            "Typed setup installation does not dispatch rollback; use the setup CLI --rollback with discovered Git context.",
        ));
    }
    let mut prepared = None;
    let mut evidence = install_plan(
        options,
        hooks,
        root,
        private,
        source,
        Some(&mut prepared),
        None,
    )?;
    let mut prepared = prepared.expect("project plan");
    merge_guard(root, &mut prepared, &mut evidence, native)?;
    if options.dry_run {
        return Ok(evidence);
    }
    apply_prepared(root, private, source, prepared, evidence, options.uninstall)
}
/// Discover Git layout before applying the existing typed setup transaction.
pub async fn install_with_context(
    options: &Options,
    hooks: &HookOptions,
    root: &Path,
    private: &Path,
    source: &Path,
    process: &crate::process::Process,
) -> Result<Value, Diagnostic> {
    if options.rollback.is_some() {
        return Err(Diagnostic::input(
            "Typed setup installation does not dispatch rollback; use the setup CLI --rollback with discovered Git context.",
        ));
    }
    let mut prepared = None;
    let mut evidence = install_plan(
        options,
        hooks,
        root,
        private,
        source,
        Some(&mut prepared),
        None,
    )?;
    let mut prepared = prepared.expect("project plan");
    let native =
        crate::guard::setup_plan_with_executable(process, root, prepared.guard_enabled, source)
            .await?;
    merge_guard(root, &mut prepared, &mut evidence, native)?;
    if options.dry_run {
        return Ok(evidence);
    }
    apply_prepared(root, private, source, prepared, evidence, options.uninstall)
}
fn merge_guard(
    root: &Path,
    prepared: &mut Prepared,
    evidence: &mut Value,
    native: crate::guard::SetupPlan,
) -> Result<(), Diagnostic> {
    if native.root != root || native.enabled != prepared.guard_enabled {
        return Err(Diagnostic::input(
            "The discovered native guard plan belongs to a different project or purpose selection.",
        ));
    }
    if native.changes.iter().any(|c| {
        c.path.file_name().and_then(|n| n.to_str()) == Some("setup-guard-hooks.json")
            && !c.unchanged()
            && c.after.is_some()
    }) {
        prepared.observations.extend(
            native
                .changes
                .iter()
                .filter(|c| {
                    c.unchanged()
                        && matches!(
                            c.path.file_name().and_then(|n| n.to_str()),
                            Some("pre-commit" | "pre-push")
                        )
                })
                .map(|c| c.path.clone()),
        );
    }
    prepared.custody_store = native.transaction_store;
    prepared.native_serialization = Some(native.serialization);
    prepared.native_inventory = Some(native.inventory);
    prepared.allowed.extend(native.allowed);
    prepared.dependencies.extend(native.dependencies);
    prepared.changes.extend(native.changes);
    prepared.dependencies.retain(|dependency| {
        !prepared
            .changes
            .iter()
            .any(|change| change.path == dependency.path)
    });
    evidence["native_guard"] = native.evidence;
    evidence["assets"] = json!(prepared.changes.iter().map(|c| json!({"path":c.path,"state":if c.unchanged(){"unchanged"}else if c.after.is_none(){"removed"}else if c.before.bytes.is_none(){"created"}else{"updated"}})).collect::<Vec<_>>());
    Ok(())
}
pub(crate) fn verify_dependencies(dependencies: &[Change]) -> Result<(), Diagnostic> {
    for dependency in dependencies {
        let snapshot = Snapshot::read(&dependency.path)?;
        if !(Change {
            path: dependency.path.clone(),
            before: dependency.before.clone(),
            after: snapshot.bytes,
            permissions: snapshot.permissions,
        })
        .unchanged()
        {
            return Err(Diagnostic::new(
                Code::ConcurrentEdit,
                "setup",
                "A native guard dependency changed after planning.",
                "Preview again with the current Git configuration and ownership.",
            ));
        }
    }
    Ok(())
}

struct Prepared {
    changes: Vec<Change>,
    observations: Vec<PathBuf>,
    snapshot: Snapshot,
    executable: Option<Snapshot>,
    allowed: Vec<PathBuf>,
    dependencies: Vec<Change>,
    guard_enabled: bool,
    native_serialization: Option<PathBuf>,
    native_inventory: Option<crate::guard::Inventory>,
    custody_store: Option<PathBuf>,
}

pub(crate) struct Initialization {
    pub changes: Vec<Change>,
    pub observations: Vec<PathBuf>,
    pub executable: Option<(PathBuf, Snapshot)>,
    pub guard_enabled: bool,
}

pub(crate) fn recheck_executable(
    root: &Path,
    source: &Path,
    expected: &Snapshot,
) -> Result<(), Diagnostic> {
    let current = shared_executable(source, root)?;
    if !(Change {
        path: source.to_owned(),
        before: expected.clone(),
        after: current.bytes,
        permissions: current.permissions,
    })
    .unchanged()
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "setup",
            "The installed executable changed while acquiring the project lock.",
            "Preview again with the current installed shared CLI.",
        ));
    }
    Ok(())
}

pub(crate) fn initialization_changes(
    root: &Path,
    private: &Path,
    mirror: bool,
) -> Result<Initialization, Diagnostic> {
    let mut prepared = None;
    let mut agents = vec![Agent::Generic];
    if mirror {
        agents.push(Agent::Claude);
    }
    let options = Options {
        agents,
        opencode_claude_hooks: false,
        uninstall: false,
        dry_run: false,
        rollback: None,
    };
    let source = std::env::current_exe()
        .map_err(|_| Diagnostic::input("Current executable is unavailable."))?;
    install_plan(
        &options,
        &HookOptions {
            purposes: vec![HookPurpose::None],
            opencode_async_rewake: false,
        },
        root,
        private,
        &source,
        Some(&mut prepared),
        None,
    )?;
    let prepared = prepared.expect("initialization plan");
    Ok(Initialization {
        changes: prepared.changes,
        observations: prepared.observations,
        executable: prepared.executable.map(|snapshot| (source, snapshot)),
        guard_enabled: prepared.guard_enabled,
    })
}

fn install_plan(
    options: &Options,
    hooks: &HookOptions,
    root: &Path,
    private: &Path,
    source: &Path,
    planned: Option<&mut Option<Prepared>>,
    exclude: Option<&Path>,
) -> Result<Value, Diagnostic> {
    install_plan_with_removals(
        options,
        HookChanges {
            options: hooks,
            removals: &[],
        },
        root,
        private,
        source,
        planned,
        exclude,
    )
}

struct HookChanges<'a> {
    options: &'a HookOptions,
    removals: &'a [super::RemovableHookPurpose],
}

fn install_plan_with_removals(
    options: &Options,
    selection: HookChanges<'_>,
    root: &Path,
    private: &Path,
    source: &Path,
    planned: Option<&mut Option<Prepared>>,
    exclude: Option<&Path>,
) -> Result<Value, Diagnostic> {
    let HookChanges {
        options: hooks,
        removals,
    } = selection;
    let requested: BTreeSet<_> = hooks.purposes.iter().copied().collect();
    if requested.len() != hooks.purposes.len()
        || (requested.contains(&HookPurpose::None) && requested.len() > 1)
    {
        return Err(Diagnostic::input(
            "Hook purposes must be unique; none cannot be combined with other purposes.",
        ));
    }
    let removed: BTreeSet<HookPurpose> = removals.iter().copied().map(Into::into).collect();
    if removed.len() != removals.len() || removed.iter().any(|purpose| requested.contains(purpose))
    {
        return Err(Diagnostic::input(
            "Hook removals must be unique and cannot also be added.",
        ));
    }
    if (options.uninstall || options.rollback.is_some())
        && (!requested.is_empty() || !removed.is_empty() || hooks.opencode_async_rewake)
    {
        return Err(Diagnostic::input(
            "Uninstall and rollback cannot be combined with hook selection.",
        ));
    }
    if options.dry_run && options.rollback.is_some()
        || options.uninstall && options.rollback.is_some()
    {
        return Err(Diagnostic::input(
            "Rollback cannot be combined with dry-run or uninstall.",
        ));
    }
    if options.rollback.is_some() && (!options.agents.is_empty() || options.opencode_claude_hooks) {
        return Err(Diagnostic::input(
            "Rollback restores a recorded transaction; omit agent and host-hook choices.",
        ));
    }
    assets::safe_path(root)?;
    assets::safe_path(private)?;
    let store_path = transaction_store(private);
    let mut allowed = vec![
        root.to_owned(),
        private.parent().unwrap_or(private).to_owned(),
        store_path.clone(),
    ];
    if let Some(parent) = exclude.and_then(Path::parent) {
        allowed.push(parent.to_owned());
    }
    if let Some(id) = &options.rollback {
        if !id.starts_with("tx-") || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            return Err(Diagnostic::input("Use an exact reported transaction id."));
        }
        let shared = AssetStore::lock(&store_path, &allowed, Duration::from_secs(2))?;
        let rolled_back = if store_path.join("transactions").join(id).exists() {
            if shared.rollback_paths(id)?.iter().any(|path| {
                matches!(
                    path.file_name().and_then(|name| name.to_str()),
                    Some("pre-commit" | "pre-push" | "guard-hooks.json" | "setup-guard-hooks.json")
                )
            }) {
                return Err(Diagnostic::input(
                    "Native guard rollback requires discovered worktree consumers; use setup --rollback through the CLI.",
                ));
            }
            shared.rollback(id)?
        } else {
            // Hold the new shared lock while recovering a pre-migration journal.
            AssetStore::lock(private, &allowed, Duration::from_secs(2))?.rollback(id)?
        };
        return Ok(
            json!({"scope":"project","root":root,"private":private,"rolled_back":rolled_back}),
        );
    }
    let (snapshot, previous) = read(root, private)?;
    let migration = if options.uninstall {
        Vec::new()
    } else {
        let declaration = crate::config::read(root)?.unwrap_or_default();
        crate::guidance::migration_removal(root, private.parent().unwrap_or(private), &declaration)?
    };
    let mut selected = previous.agents.clone();
    // Successfully verified legacy init entries retain their selected host.
    // Migration changes exist only after every old block proved ownership.
    for (name, agent) in [("AGENTS.md", Agent::Generic), ("CLAUDE.md", Agent::Claude)] {
        if migration
            .iter()
            .any(|change| change.path == root.join(name))
        {
            selected.insert(agent);
        }
    }

    for agent in &options.agents {
        if options.agents.iter().filter(|a| *a == agent).count() != 1 {
            return Err(Diagnostic::input("Select each agent only once."));
        }
        selected.insert(*agent);
    }
    if selected.is_empty() {
        if options.uninstall {
            return Err(Diagnostic::input(
                "No recorded project integration is available to uninstall.",
            ));
        }
        // A shared Skill and stable entry require no host discovery. Existing
        // receipts retain their selected integrations instead of gaining a host.
        selected.insert(Agent::Generic);
    }
    if options.uninstall && (!options.agents.is_empty() || options.opencode_claude_hooks) {
        return Err(Diagnostic::input(
            "Project uninstall removes this worktree's recorded integrations; omit --agent.",
        ));
    }
    if options.opencode_claude_hooks && !selected.contains(&Agent::Opencode) {
        return Err(Diagnostic::input(
            "Custom OpenCode Claude-compatible hooks require --agent opencode.",
        ));
    }
    if !removed.is_empty()
        && (snapshot.bytes.is_none()
            || options
                .agents
                .iter()
                .any(|agent| !previous.agents.contains(agent)))
    {
        return Err(Diagnostic::input(
            "Hook removal requires recorded project integrations; select only recorded agents.",
        ));
    }
    let custom_opencode = options.opencode_claude_hooks || previous.hooks.contains_key("opencode");

    let mut plans = BTreeMap::new();
    let mut purpose_evidence = serde_json::Map::new();
    let mut receipt_purposes = BTreeMap::new();
    for (agent, host) in [
        (Agent::Generic, "generic"),
        (Agent::Claude, "claude"),
        (Agent::Codex, "codex"),
        (Agent::Opencode, "opencode"),
    ] {
        if !selected.contains(&agent) {
            continue;
        }
        let (mut effective, _old_wake) = purposes_for(&previous, host);
        // Naming a host selects guidance only. Hook changes apply only to the
        // explicitly selected hosts, or all recorded hosts when no host is given.
        let targeted = options.agents.is_empty() || options.agents.contains(&agent);
        let wanted = if targeted {
            requested.clone()
        } else {
            BTreeSet::new()
        };
        let removed_here = if targeted {
            removed.clone()
        } else {
            BTreeSet::new()
        };
        let changed_removals: BTreeSet<_> =
            effective.intersection(&removed_here).copied().collect();
        effective.retain(|purpose| !removed_here.contains(purpose));
        effective.extend(wanted.iter().copied().filter(|p| *p != HookPurpose::None));
        let mut declined = vec![];
        for purpose in effective.clone() {
            let refusal = if purpose == HookPurpose::Observe {
                Some((
                    "unsupported",
                    "Automatic observation and idle wake are unsupported on SessionStart/PreToolUse; use bounded specgit watch/inbox tools.",
                ))
            } else if purpose == HookPurpose::Context
                && (agent == Agent::Generic || (agent == Agent::Opencode && !custom_opencode))
            {
                Some((
                    "unsupported",
                    "This host has no verified SessionStart/PreToolUse integration; use the project Skill and bounded tools.",
                ))
            } else {
                None
            };
            if let Some((status, reason)) = refusal {
                effective.remove(&purpose);
                declined.push(json!({"purpose":purpose,"status":status,"reason":reason}));
            }
        }
        if hooks.opencode_async_rewake {
            declined.push(json!({"purpose":"observe","status":"unsupported","reason":"The legacy async-rewake flag is retained for parsing only; no Stop callback or idle wake is installed. Use bounded specgit watch/inbox."}));
        }
        purpose_evidence.insert(host.into(), json!({"requested":wanted,"removed":changed_removals,"removal_requested":removed_here,"removal_status":if changed_removals.is_empty(){"unchanged"}else{"removed"},"installed":if options.uninstall { BTreeSet::new() } else { effective.clone() },"declined":declined}));
        if !options.uninstall {
            receipt_purposes.insert(host.to_owned(), effective.clone());
        }
        if !options.uninstall && effective.contains(&HookPurpose::Context) {
            plans.insert(host, purpose_manifest(source, agent, &effective, false)?);
        }
    }
    let guard_enabled = receipt_purposes
        .values()
        .any(|purposes| purposes.contains(&HookPurpose::Guard));
    let needs_executable = !plans.is_empty() || guard_enabled;
    let executable = needs_executable
        .then(|| shared_executable(source, root))
        .transpose()?;
    let mut receipt = ProjectReceipt {
        version: 4,
        owner: "specgit".into(),
        root: root.into(),
        shared_root: None,
        generation: previous.generation.clone(),
        agents: selected.clone(),
        skills: BTreeMap::new(),
        instructions: BTreeMap::new(),
        hooks: BTreeMap::new(),
        purposes: BTreeMap::new(),
    };
    receipt.purposes = receipt_purposes;
    let mut changes = migration;
    let receipt_path = private.join("ownership.json");
    let mut skills: BTreeSet<String> = previous.skills.keys().cloned().collect();
    if !options.uninstall {
        skills.insert(".agents/skills/specgit-native/SKILL.md".into());
        if selected.contains(&Agent::Claude) {
            skills.insert(".claude/skills/specgit-native/SKILL.md".into());
        }
    }
    for relative in skills {
        let change = Change::new(root.join(&relative), (!options.uninstall).then(skill_bytes))?;
        if let Some(hash) = previous.skills.get(&relative) {
            if change.before.digest().as_ref() != Some(hash) && options.uninstall {
                return Err(conflict_at(
                    "project",
                    &change.path,
                    None,
                    "The owned project skill was edited or removed.",
                ));
            }
            let proof = owned_pair(private, &receipt_path, &snapshot, &change.path, &change.before, Some(hash))?
                .ok_or_else(|| conflict_at("project", &change.path, None, "The project skill permissions or transaction ownership cannot be proved; retain it for reconciliation."))?;
            for journal in proof {
                if !changes.iter().any(|c: &Change| c.path == journal.path) {
                    changes.push(journal);
                }
            }
        } else if change.before.bytes.is_some() {
            let mut diagnostic = conflict_at(
                "project",
                &change.path,
                None,
                "The project skill is unowned; preserve it and reconcile ownership first.",
            );
            diagnostic.remedy = "Preserve the file and manual content; verify the original ownership record. A clone may contain an old generated Skill tracked by Git. Only after confirming it is generated and obtaining authorization, remove that file from the Git index and move the existing local copy to a safe location, then run `specgit init` to generate a managed local Skill. Untracking alone leaves the conflicting local file in place. Never adopt or overwrite unknown content automatically.".into();
            return Err(diagnostic);
        }
        if !options.uninstall {
            receipt
                .skills
                .insert(relative, assets::hash(&skill_bytes()));
        }
        changes.push(change);
    }
    // Plan Codex first so its override can coexist with AGENTS.md for other hosts.
    let mut hosts: BTreeSet<String> = previous.instructions.keys().cloned().collect();
    if !options.uninstall {
        if selected.contains(&Agent::Codex) {
            hosts.insert("codex".into());
        }
        if selected.contains(&Agent::Generic) || selected.contains(&Agent::Opencode) {
            hosts.insert("generic".into());
        }
        if selected.contains(&Agent::Claude) {
            hosts.insert("claude".into());
        }
    }
    let mut observations = Vec::new();
    let mut planned_paths = BTreeSet::new();
    for host in ["codex", "generic", "claude"] {
        if !hosts.contains(host) {
            continue;
        }
        let old = previous.instructions.get(host);
        if host == "codex" && old.is_none() && previous.instructions.contains_key("generic") {
            let override_path = root.join("AGENTS.override.md");
            let shadows = codex_override_shadows(root)?;
            if !shadows {
                continue;
            }
            if previous.agents.contains(&Agent::Codex) {
                return Err(conflict_at(
                    "codex",
                    &override_path,
                    None,
                    "A new Codex override shadows the registered instructions; reconcile the host guidance first.",
                ));
            }
        }
        // When two selected hosts discover the same file, one receipt owns its block.
        if host == "generic"
            && old.is_none()
            && (planned_paths.contains(&root.join("AGENTS.md"))
                || previous
                    .instructions
                    .get("codex")
                    .is_some_and(|g| g.instructions == "AGENTS.md"))
        {
            continue;
        }
        // This is a pure plan. Any recorded asset must prove this exact
        // before-snapshot before the plan can be returned or applied.
        let target = root.join(instruction_target(host, root, old)?);
        let migration_change = changes.iter().find(|change| change.path == target);
        let (change, registration) = instruction_change_after(
            host,
            root,
            old,
            options.uninstall,
            old.is_some() && !options.uninstall,
            migration_change,
        )?;
        if old.is_none() && change.unchanged() {
            observations.push(change.path.clone());
        }
        if old.is_some() {
            let proofs = owned_pair(
                private,
                &receipt_path,
                &snapshot,
                &change.path,
                &change.before,
                None,
            )?
            .ok_or_else(|| {
                conflict_at(
                    host,
                    &change.path,
                    None,
                    "Guidance ownership or permissions cannot be proved.",
                )
            })?;
            for journal in proofs {
                if !changes.iter().any(|c| c.path == journal.path) {
                    changes.push(journal);
                }
            }
        }
        if !planned_paths.insert(change.path.clone()) {
            return Err(conflict("Two project guidance receipts own the same path."));
        }
        if let Some(registration) = registration {
            receipt.instructions.insert(host.into(), registration);
        }
        changes.retain(|c| c.path != change.path);
        changes.push(change);
    }
    for (agent, host, relative) in [
        (Agent::Claude, "claude", ".claude/settings.json"),
        (Agent::Codex, "codex", ".codex/hooks.json"),
        (Agent::Opencode, "opencode", ".opencode/hooks.json"),
    ] {
        if !selected.contains(&agent) || (host == "opencode" && !custom_opencode) {
            continue;
        }
        let path = root.join(relative);
        let old = previous.hooks.get(host);
        let entries = plans.get(host);
        if entries.is_none() && old.is_none() {
            continue;
        }
        let change = registration_change(host, &path, old, entries)?;
        if old.is_some() {
            let proofs = owned_pair(
                private,
                &receipt_path,
                &snapshot,
                &path,
                &change.before,
                None,
            )?
            .ok_or_else(|| {
                conflict_at(
                    host,
                    &path,
                    None,
                    "Host settings ownership or permissions cannot be proved.",
                )
            })?;
            for journal in proofs {
                if !changes.iter().any(|c| c.path == journal.path) {
                    changes.push(journal);
                }
            }
        }
        if let Some(entries) = entries {
            let mut registration = if let Some(old) = old {
                old.clone()
            } else {
                let before = match &change.before.bytes {
                    Some(bytes) => input::json(bytes, 1_048_576, 32)?,
                    None => json!({}),
                };
                Registration {
                    settings: path,
                    entries: BTreeMap::new(),
                    created_file: change.before.bytes.is_none(),
                    created_hook_map: host != "opencode" && before.get("hooks").is_none(),
                    created_event_keys: entries
                        .keys()
                        .filter(|event| {
                            (if host == "opencode" {
                                Some(&before)
                            } else {
                                before.get("hooks")
                            })
                            .and_then(|hooks| hooks.get(*event))
                            .is_none()
                        })
                        .cloned()
                        .collect(),
                    skill: None,
                }
            };
            // Newly introduced events are owned only when no event key existed before.
            let before = match &change.before.bytes {
                Some(bytes) => input::json(bytes, 1_048_576, 32)?,
                None => json!({}),
            };
            for event in entries.keys() {
                let map = if host == "opencode" {
                    Some(&before)
                } else {
                    before.get("hooks")
                };
                if map.and_then(|m| m.get(event)).is_none()
                    && !registration.created_event_keys.contains(event)
                {
                    registration.created_event_keys.push(event.clone());
                }
            }
            registration.entries = entries.clone();
            receipt.hooks.insert(host.into(), registration);
        }
        changes.push(change);
    }
    // Mint an identity only after every existing asset proved its ownership.
    // Refresh keeps it stable; a later reinstall starts a distinct history.
    if !options.uninstall && receipt.generation.is_none() {
        receipt.generation = Some(installation_generation()?);
    }
    changes.push(Change {
        path: private.join("ownership.json"),
        permissions: snapshot.permissions.clone(),
        before: snapshot.clone(),
        after: if options.uninstall {
            None
        } else {
            Some(
                serde_json::to_vec_pretty(&receipt)
                    .map_err(|_| conflict("Project receipt cannot be represented."))?,
            )
        },
    });
    if let Some(exclude) = exclude {
        changes.push(crate::local_exclude::project_change(
            root, exclude, &changes,
        )?);
    }
    let summary: Vec<_> = changes.iter().map(|c| json!({"path":c.path,"state":if c.unchanged(){"unchanged"}else if c.after.is_none(){"removed"}else if c.before.bytes.is_none(){"created"}else{"updated"}})).collect();
    let mut evidence = json!({"schema_version":2,"version":VERSION,"scope":"project","root":root,"private":private,"agents":selected,"opencode_claude_hooks":custom_opencode,"assets":summary,"written":false,"manifest_exported":false,"operation":if options.uninstall{"uninstall"}else if snapshot.bytes.is_some(){"update"}else{"install"},"registration":if options.uninstall{"removal_planned"}else{"write_planned"},"codex_trust":if selected.contains(&Agent::Codex){"review_in_host_required"}else{"not_applicable"},"host_delivery":{"imported_event":"not_checked","context_injection":"not_checked","visible_message":"not_checked","next_turn":"not_checked","idle_wake":"not_supported"}});
    evidence["hook_purposes"] = Value::Object(purpose_evidence);
    if let Some(planned) = planned {
        *planned = Some(Prepared {
            changes,
            observations,
            snapshot,
            executable,
            allowed,
            dependencies: Vec::new(),
            guard_enabled,
            native_serialization: None,
            native_inventory: None,
            custody_store: None,
        });
        return Ok(evidence);
    }
    if guard_enabled
        || private
            .parent()
            .unwrap_or(private)
            .join("setup-guard-hooks.json")
            .exists()
    {
        return Err(Diagnostic::input(
            "Native Git guard planning requires a discovered Git context; use install_with_guard_plan or the setup CLI.",
        ));
    }
    if options.dry_run {
        return Ok(evidence);
    }
    apply_prepared(
        root,
        private,
        source,
        Prepared {
            changes,
            observations,
            snapshot,
            executable,
            allowed,
            dependencies: Vec::new(),
            guard_enabled,
            native_serialization: None,
            native_inventory: None,
            custody_store: None,
        },
        evidence,
        options.uninstall,
    )
}

fn apply_prepared(
    root: &Path,
    private: &Path,
    source: &Path,
    prepared: Prepared,
    mut evidence: Value,
    uninstall: bool,
) -> Result<Value, Diagnostic> {
    let Prepared {
        changes,
        observations,
        snapshot,
        executable,
        allowed,
        dependencies,
        guard_enabled: _,
        native_serialization,
        native_inventory,
        custody_store,
    } = prepared;
    let store_path = transaction_store(private);
    #[cfg(feature = "test-fixtures")]
    if let Some(marker) = std::env::var_os("SPECGIT_FIXTURE_SETUP_PLAN_READY") {
        std::fs::write(marker, b"planned")
            .map_err(|_| Diagnostic::input("Fixture plan marker is unavailable."))?;
    }
    let _native_lock = native_serialization
        .as_ref()
        .map(|path| AssetStore::lock(path, std::slice::from_ref(path), Duration::from_secs(2)))
        .transpose()?;
    if let Some(inventory) = &native_inventory {
        inventory.verify()?;
    }
    let _origin = custody_store
        .as_ref()
        .filter(|path| *path != &store_path)
        .map(|_| AssetStore::lock(&store_path, &allowed, Duration::from_secs(2)))
        .transpose()?;
    let store = AssetStore::lock(
        custody_store.as_ref().unwrap_or(&store_path),
        &allowed,
        Duration::from_secs(2),
    )?;
    if !store.pending_transactions()?.is_empty()
        || !AssetStore::pending_at(private)?.is_empty()
        || !AssetStore::pending_at(&store_path)?.is_empty()
    {
        return Err(conflict(
            "A shared or local transaction requires recovery first.",
        ));
    }
    if Snapshot::read(&private.join("ownership.json"))?.digest() != snapshot.digest() {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "setup",
            "Project ownership changed while acquiring the lock.",
            "Preview again after the other operation completes.",
        ));
    }
    if let Some(executable) = executable {
        recheck_executable(root, source, &executable)?;
    }
    // apply filters unchanged entries; they still need fresh ownership evidence.
    for change in &changes {
        let current = Snapshot::read(&change.path)?;
        let freshness = Change {
            path: change.path.clone(),
            before: change.before.clone(),
            after: current.bytes,
            permissions: current.permissions,
        };
        if !freshness.unchanged() {
            return Err(Diagnostic::new(
                Code::ConcurrentEdit,
                "setup",
                "A project asset or its permissions changed while acquiring the lock.",
                "Preserve the current files and preview setup again.",
            ));
        }
    }
    verify_dependencies(&dependencies)?;
    // Git does not take SpecGit's lock, so a concurrent `git worktree add`
    // must abort and roll back the transaction before hook writes commit.
    evidence["transaction"] =
        json!(store.apply_recording_checked(changes, &observations, |_| {
            if let Some(inventory) = &native_inventory {
                inventory.verify()?;
            }
            verify_dependencies(&dependencies)
        })?);
    if uninstall {
        store.prune_empty_project_directories(root)?;
    }
    evidence["written"] = json!(true);
    evidence["registration"] = json!(if uninstall {
        "not_registered"
    } else {
        "written_not_verified"
    });
    Ok(evidence)
}

/// Inspect only assets named by this worktree's receipt. A missing receipt
/// means no project integration was selected here.
pub fn health_plan(
    root: &Path,
    private: &Path,
    source: &Path,
) -> Result<Option<assets::MaintenancePlan>, Diagnostic> {
    let (_, previous) = read(root, private)?;
    if wants_guard(&previous)
        || private
            .parent()
            .unwrap_or(private)
            .join("setup-guard-hooks.json")
            .exists()
    {
        return Err(Diagnostic::input(
            "Native Git guard maintenance requires asynchronous Git discovery; use health_plan_with_context.",
        ));
    }
    health_plan_inner(root, private, source)
}
fn health_plan_inner(
    root: &Path,
    private: &Path,
    source: &Path,
) -> Result<Option<assets::MaintenancePlan>, Diagnostic> {
    assets::safe_path(root)?;
    assets::safe_path(private)?;
    if !AssetStore::pending_at(private)?.is_empty()
        || !AssetStore::pending_at(&transaction_store(private))?.is_empty()
    {
        return Err(conflict(
            "An interrupted project asset transaction requires recovery first.",
        ));
    }
    let (snapshot, previous) = read(root, private)?;
    if snapshot.bytes.is_none() {
        for relative in [
            ".agents/skills/specgit-native/SKILL.md",
            ".claude/skills/specgit-native/SKILL.md",
        ] {
            let path = root.join(relative);
            if Snapshot::read(&path)?.bytes.is_some() {
                return Err(orphan_at(
                    &path,
                    "A SpecGit project Skill exists without a project ownership receipt; preserve it for reconciliation.",
                ));
            }
        }
        for relative in ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"] {
            let path = root.join(relative);
            if let Some(bytes) = Snapshot::read(&path)?.bytes
                && [HOST_START, HOST_END, LEGACY_START, LEGACY_END]
                    .iter()
                    .any(|marker| {
                        bytes
                            .windows(marker.len())
                            .any(|window| window == marker.as_bytes())
                    })
            {
                return Err(orphan_at(
                    &path,
                    "A reserved project guidance block exists without a project ownership receipt; preserve it for reconciliation.",
                ));
            }
        }
        if let Some(path) = orphan_hook_registration(root)? {
            return Err(orphan_at(
                &path,
                "An exact SpecGit host hook registration exists without a project ownership receipt; preserve it for reconciliation.",
            ));
        }
        return Ok(None);
    }
    let receipt_path = private.join("ownership.json");
    if previous.agents.contains(&Agent::Codex)
        && !previous.instructions.contains_key("codex")
        && previous
            .instructions
            .get("generic")
            .is_some_and(|guidance| guidance.instructions == "AGENTS.md")
        && codex_override_shadows(root)?
    {
        let override_path = root.join("AGENTS.override.md");
        return Err(conflict_at(
            "codex",
            &override_path,
            None,
            "A new Codex override shadows the registered instructions; reconcile the host guidance first.",
        ));
    }
    let mut next = ProjectReceipt {
        version: 4,
        owner: "specgit".into(),
        root: root.into(),
        shared_root: None,
        generation: previous.generation.clone(),
        agents: previous.agents.clone(),
        skills: BTreeMap::new(),
        instructions: BTreeMap::new(),
        hooks: BTreeMap::new(),
        purposes: BTreeMap::new(),
    };
    for (agent, host) in [
        (Agent::Generic, "generic"),
        (Agent::Claude, "claude"),
        (Agent::Codex, "codex"),
        (Agent::Opencode, "opencode"),
    ] {
        if previous.agents.contains(&agent) {
            let mut purposes = purposes_for(&previous, host).0;
            purposes.remove(&HookPurpose::Observe);
            next.purposes.insert(host.to_owned(), purposes);
        }
    }
    let mut changes = Vec::new();
    let mut dependencies = vec![Change {
        path: receipt_path.clone(),
        before: snapshot.clone(),
        after: snapshot.bytes.clone(),
        permissions: snapshot.permissions.clone(),
    }];
    let mut add_proofs = |proofs: Vec<Change>| {
        for proof in proofs {
            if !dependencies.iter().any(|old| old.path == proof.path) {
                dependencies.push(proof);
            }
        }
    };
    for (relative, digest) in &previous.skills {
        let path = root.join(relative);
        let mut change = Change::new(path.clone(), Some(skill_bytes()))?;
        let proof = owned_pair(
            private,
            &receipt_path,
            &snapshot,
            &path,
            &change.before,
            Some(digest),
        )?
        .ok_or_else(|| {
            conflict_at(
                "project",
                &path,
                None,
                "The project skill ownership or permissions cannot be proved.",
            )
        })?;
        add_proofs(proof);
        if change.before.bytes.is_none() {
            change.permissions = None;
        }
        next.skills.insert(
            relative.clone(),
            assets::hash(change.after.as_deref().expect("skill bytes")),
        );
        changes.push(change);
    }
    for (host, old) in &previous.instructions {
        let path = root.join(&old.instructions);
        let current = Snapshot::read(&path)?;
        if current.bytes.is_none() {
            return Err(conflict_at(
                host,
                &path,
                None,
                "Missing guidance may contain manual content and cannot be reconstructed.",
            ));
        }
        let proof = owned_pair(private, &receipt_path, &snapshot, &path, &current, None)?
            .ok_or_else(|| {
                conflict_at(
                    host,
                    &path,
                    None,
                    "Guidance ownership or permissions cannot be proved.",
                )
            })?;
        add_proofs(proof);
        let (change, registration) = instruction_change(host, root, Some(old), false, true)?;
        next.instructions.insert(
            host.clone(),
            registration.expect("refresh retains guidance"),
        );
        changes.push(change);
    }
    let executable = if previous.hooks.is_empty() {
        None
    } else {
        Some(shared_executable(source, root)?)
    };
    for (host, old) in &previous.hooks {
        let path = &old.settings;
        let current = Snapshot::read(path)?;
        if current.bytes.is_none() {
            return Err(conflict_at(
                host,
                path,
                None,
                "Missing host settings may contain manual content and cannot be reconstructed.",
            ));
        }
        let proof = owned_pair(private, &receipt_path, &snapshot, path, &current, None)?
            .ok_or_else(|| {
                conflict_at(
                    host,
                    path,
                    None,
                    "Host settings ownership or permissions cannot be proved.",
                )
            })?;
        add_proofs(proof);
        let (mut purposes, _) = purposes_for(&previous, host);
        purposes.remove(&HookPurpose::Observe);
        next.purposes.insert(host.clone(), purposes.clone());
        let agent = match host.as_str() {
            "claude" => Agent::Claude,
            "codex" => Agent::Codex,
            "opencode" => Agent::Opencode,
            _ => {
                return Err(conflict_at(
                    host,
                    path,
                    None,
                    "Unsupported recorded hook host.",
                ));
            }
        };
        let entries = purpose_manifest(source, agent, &purposes, false)?;
        let document = input::json(current.bytes.as_deref().expect("checked"), 1_048_576, 32)?;
        let hooks = if host == "opencode" {
            &document
        } else {
            &document["hooks"]
        };
        let recover_missing: BTreeSet<String> = old
            .entries
            .keys()
            .filter(|event| {
                hooks.get(event.as_str()).is_none() && old.created_event_keys.contains(*event)
            })
            .cloned()
            .collect();
        let change = registration_change_recovering(
            host,
            path,
            Some(old),
            (!entries.is_empty()).then_some(&entries),
            &recover_missing,
        )?;
        let mut registration = old.clone();
        registration.entries = entries;
        if !registration.entries.is_empty() {
            next.hooks.insert(host.clone(), registration);
        }
        changes.push(change);
    }
    if let Some(executable) = executable {
        dependencies.push(Change {
            path: source.into(),
            before: executable.clone(),
            after: executable.bytes.clone(),
            permissions: executable.permissions.clone(),
        });
    }
    if next.generation.is_none() {
        next.generation = Some(installation_generation()?);
    }
    let receipt_bytes = serde_json::to_vec_pretty(&next)
        .map_err(|_| conflict("Project receipt cannot be represented."))?;
    changes.push(Change {
        path: receipt_path,
        before: snapshot.clone(),
        after: Some(receipt_bytes),
        permissions: snapshot.permissions.clone(),
    });
    let mut plan = assets::MaintenancePlan::new(
        transaction_store(private),
        vec![
            root.into(),
            private.parent().unwrap_or(private).into(),
            transaction_store(private),
        ],
        changes,
        dependencies,
    );
    if !previous.hooks.is_empty() {
        let source = source.to_owned();
        let root = root.to_owned();
        plan = plan.with_precondition(move || {
            shared_executable(&source, &root)?;
            Ok(())
        });
    }
    Ok(Some(plan))
}

struct ExclusionHealth {
    change: Change,
    dependencies: Vec<Change>,
    allowed: PathBuf,
}

async fn exclusion_health(
    process: &crate::process::Process,
    root: &Path,
    private: &Path,
    changes: &[Change],
) -> Result<Option<ExclusionHealth>, Diagnostic> {
    let exclude = crate::local_exclude::path(process, root).await?;
    let observed = Snapshot::read(&exclude)?;
    let state = private.parent().unwrap_or(private);
    let mut stores = vec![transaction_store(private), private.to_owned()];
    stores.extend(crate::config::worktree::shared_setup_guard_stores(root)?);
    let mut dependencies = None;
    for receipt in [private.join("ownership.json"), state.join("guidance.json")] {
        let snapshot = Snapshot::read(&receipt)?;
        if snapshot.bytes.is_none() {
            continue;
        }
        if observed.bytes.is_none() {
            if AssetStore::selected_missing_asset_at(&stores, &receipt, &snapshot, &exclude)? {
                return Err(Diagnostic::new(
                    Code::OwnershipConflict,
                    "local_exclude",
                    "The selected Git info/exclude file is missing; its manual rules cannot be reconstructed safely.",
                    "Preserve transaction evidence, restore the original exclude file and its user rules, then preview doctor again. No file was recreated.",
                ));
            }
        } else if let Some(mut proof) = AssetStore::owned_pair_across_at(
            &stores, &receipt, &snapshot, &exclude, &observed, None,
        )? {
            proof.push(Change {
                path: receipt,
                before: snapshot.clone(),
                after: snapshot.bytes,
                permissions: snapshot.permissions,
            });
            dependencies = Some(proof);
            break;
        }
    }
    let Some(mut dependencies) = dependencies else {
        return Ok(None);
    };
    let mut shared_skills = Vec::new();
    // A lost block has no surviving sibling rules. Reconstruct only exact
    // generated Skill paths whose sibling receipt and permissions still prove ownership.
    for sibling in crate::config::worktree::siblings(process, root).await? {
        let sibling_exclude = crate::local_exclude::path(process, &sibling.root).await?;
        if sibling_exclude != exclude
            && sibling_exclude.canonicalize().ok() != exclude.canonicalize().ok()
        {
            continue;
        }
        let sibling_private = sibling.private_root.join("agent-assets");
        let receipt = sibling_private.join("ownership.json");
        let (snapshot, selected) = read(&sibling.root, &sibling_private)?;
        dependencies.push(Change {
            path: receipt.clone(),
            before: snapshot.clone(),
            after: snapshot.bytes.clone(),
            permissions: snapshot.permissions.clone(),
        });
        let sibling_stores = [transaction_store(&sibling_private), sibling_private.clone()];
        let Some(proof) = AssetStore::owned_pair_across_at(
            &sibling_stores,
            &receipt,
            &snapshot,
            &exclude,
            &observed,
            None,
        )?
        else {
            continue;
        };
        dependencies.extend(proof);
        for (relative, digest) in &selected.skills {
            let path = sibling.root.join(relative);
            let asset = Snapshot::read(&path)?;
            let proof = owned_pair(&sibling_private, &receipt, &snapshot, &path, &asset, Some(digest))?.ok_or_else(|| conflict_at("local_exclude", &path, None, "A shared Skill rule cannot be restored without current sibling ownership and permissions."))?;
            dependencies.extend(proof);
            dependencies.push(Change {
                path,
                before: asset.clone(),
                after: asset.bytes,
                permissions: asset.permissions,
            });
            shared_skills.push(relative.clone());
        }
    }
    let change =
        crate::local_exclude::project_change_with_shared(root, &exclude, changes, &shared_skills)?;
    if !(Change {
        path: exclude.clone(),
        before: observed.clone(),
        after: change.before.bytes.clone(),
        permissions: change.before.permissions.clone(),
    })
    .unchanged()
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "local_exclude",
            "Git exclusion rules changed during ownership verification.",
            "Preserve the current rules and preview doctor again.",
        ));
    }
    dependencies.push(Change {
        path: exclude.clone(),
        before: observed.clone(),
        after: observed.bytes,
        permissions: observed.permissions,
    });
    let allowed = exclude
        .parent()
        .ok_or_else(|| Diagnostic::input("Git exclude parent is unavailable."))?
        .to_owned();
    Ok(Some(ExclusionHealth {
        change,
        dependencies,
        allowed,
    }))
}

pub async fn health_plan_with_context(
    process: &Process,
    root: &Path,
    private: &Path,
    source: &Path,
) -> Result<Option<assets::MaintenancePlan>, Diagnostic> {
    let (_, previous) = read(root, private)?;
    let Some(mut plan) = health_plan_inner(root, private, source)? else {
        return Ok(None);
    };
    let native =
        crate::guard::setup_plan_with_executable(process, root, wants_guard(&previous), source)
            .await?;
    if let Some(exclusion) =
        exclusion_health(process, root, private, plan.planned_changes()).await?
    {
        plan.extend(
            vec![exclusion.change],
            exclusion.dependencies,
            vec![exclusion.allowed],
        );
    }
    plan.observe(native.observations());
    plan.serialize_with(native.serialization);
    if let Some(store) = native.transaction_store {
        plan.custody_store(store);
    }
    let inventory = native.inventory;
    plan = plan.with_precondition(move || inventory.verify());
    plan.extend(native.changes, native.dependencies, native.allowed);
    Ok(Some(plan))
}

pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    run_with_hooks(options, HookOptions::default(), process, cwd).await
}

pub async fn run_with_hooks(
    options: Options,
    hooks: HookOptions,
    process: Process,
    cwd: &Path,
) -> Report {
    run_with_hook_removals(options, hooks, Vec::new(), process, cwd).await
}

/// Apply additive hook choices and explicit removals while preserving guidance.
pub async fn run_with_hook_removals(
    options: Options,
    hooks: HookOptions,
    removals: Vec<super::RemovableHookPurpose>,
    process: Process,
    cwd: &Path,
) -> Report {
    let result = async {
        crate::project::require_local_repository_environment()?;
        let path = |bytes: Vec<u8>| -> Result<PathBuf, Diagnostic> {
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| Diagnostic::input("Git path is not UTF-8."))?;
            let path = PathBuf::from(text.trim_end_matches(['\r', '\n']));
            assets::safe_path(&path)?;
            Ok(path)
        };
        let root =
            path(crate::project::git(&process, cwd, &["rev-parse", "--show-toplevel"]).await?)?;
        let git_dir =
            path(crate::project::git(&process, cwd, &["rev-parse", "--absolute-git-dir"]).await?)?;
        let source = std::env::current_exe()
            .map_err(|_| Diagnostic::input("Current executable is unavailable."))?;
        let exclude = crate::local_exclude::path(&process, &root).await?;
        let private = git_dir.join("specgit-v2/agent-assets");
        if let Some(id) = &options.rollback {
            if options.dry_run || options.uninstall || !options.agents.is_empty() || options.opencode_claude_hooks || !hooks.purposes.is_empty() || !removals.is_empty() || hooks.opencode_async_rewake {
                return Err(Diagnostic::input("Rollback restores a recorded transaction; omit installation changes."));
            }
            if !id.starts_with("tx-") || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
                return Err(Diagnostic::input("Use an exact reported transaction id."));
            }
            let serialization = crate::config::worktree::lock_native_guard(&process, &root).await?;
            let (store_path, shared) = crate::config::worktree::rollback_store(&process, &root, id, &[transaction_store(&private), private.clone()]).await?;
            let allowed = crate::config::worktree::rollback_allowed_roots(&[shared, crate::config::worktree::hooks(&process, &root).await?, root.clone(), git_dir.join("specgit-v2"), exclude.parent().ok_or_else(|| Diagnostic::input("Invalid exclude parent."))?.to_owned()])?;
            let store = AssetStore::lock(&store_path, &allowed, Duration::from_secs(2))?;
            let (rolled_back, retained) = crate::config::worktree::rollback_with_lock(&serialization, &store, &process, &root, &exclude, id).await?;
            return Ok(json!({"scope":"project","root":root,"private":private,"rolled_back":rolled_back,"retained":retained}));
        }
        let mut prepared = None;
        let mut evidence = install_plan_with_removals(
            &options,
            HookChanges { options: &hooks, removals: &removals },
            &root,
            &private,
            &source,
            Some(&mut prepared),
            Some(&exclude),
        )?;
        let mut prepared = prepared.expect("project plan");
        let native = crate::guard::setup_plan_with_executable(&process, &root, prepared.guard_enabled, &source).await?;
        merge_guard(&root, &mut prepared, &mut evidence, native)?;
        if options.uninstall {
            // Setup retires only its integration. This worktree's declaration
            // and init/checkpoint state continue to consume local exclusions.
            // Classify each consumer from the same snapshots pinned below.
            let mut worktrees = vec![(root.clone(), git_dir.join("specgit-v2"), true)];
            worktrees.extend(crate::config::worktree::siblings(&process, &root).await?.into_iter().map(|sibling| (sibling.root, sibling.private_root, false)));
            let mut retained_exclusions = false;
            for (checkout, state_root, current) in worktrees {
                let paths = std::iter::once((checkout.join(".specgit.yaml"), true))
                    .chain(crate::config::worktree::INITIALIZED_MARKERS.into_iter().map(|name| (state_root.join(name), true)))
                    .chain(crate::config::worktree::RECEIPT_MARKERS.into_iter().filter(|_| !current).map(|name| (state_root.join(name), name == "agent-assets/ownership.json")));
                for (path, consumes) in paths {
                    let before = Snapshot::read(&path)?;
                    retained_exclusions |= consumes && before.bytes.is_some();
                    if !prepared.dependencies.iter().any(|dependency| dependency.path == path) {
                        prepared.dependencies.push(Change { path, after: before.bytes.clone(), permissions: before.permissions.clone(), before });
                    }
                }
            }
            if !retained_exclusions {
                let change = crate::local_exclude::removal(&exclude)?;
                prepared.changes.retain(|change| change.path != exclude);
                prepared.changes.push(change);
            }
            evidence["assets"] = json!(prepared.changes.iter().map(|change| json!({"path":change.path,"state":if change.unchanged(){"unchanged"}else if change.after.is_none(){"removed"}else if change.before.bytes.is_none(){"created"}else{"updated"}})).collect::<Vec<_>>());
        }
        evidence["local_exclusion"] =
            crate::local_exclude::inspect(&process, &root, &exclude, &prepared.changes).await?;
        if options.dry_run {
            return Ok(evidence);
        }
        apply_prepared(
            &root,
            &private,
            &source,
            prepared,
            evidence,
            options.uninstall,
        )
    }
    .await;
    match result {
        Ok(evidence) => Report::success(
            "setup",
            if options.dry_run {
                "dry_run"
            } else if options.rollback.is_some() {
                "rolled_back"
            } else if options.uninstall {
                "uninstalled"
            } else {
                "installed"
            },
            evidence,
        ),
        Err(d) => Report::failure("setup", d),
    }
}

#[cfg(test)]
mod path_tests {
    use super::shared_inside_project;
    use std::fs;

    #[test]
    fn containment_normalizes_project_dot_alias_and_keeps_external_cli_outside() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        let nested = project.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let inside = project.join("specgit");
        let outside = temporary.path().join("shared-specgit");
        fs::write(&inside, b"inside").unwrap();
        fs::write(&outside, b"outside").unwrap();
        let project_alias = nested.join("..");
        assert!(shared_inside_project(&inside.canonicalize().unwrap(), &project_alias).unwrap());
        assert!(!shared_inside_project(&outside.canonicalize().unwrap(), &project_alias).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn extended_executable_path_is_inside_plain_windows_project_path() {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        fs::create_dir(&project).unwrap();
        let inside = project.join("specgit.exe");
        fs::write(&inside, b"inside").unwrap();
        let extended = inside.canonicalize().unwrap();
        assert!(extended.to_string_lossy().starts_with(r"\\?\"));
        let plain = project.to_string_lossy().replace(r"\\?\", "");
        assert!(shared_inside_project(&extended, std::path::Path::new(&plain)).unwrap());
    }
}
