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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectReceipt {
    version: u8,
    owner: String,
    root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shared_root: Option<PathBuf>,
    agents: BTreeSet<Agent>,
    skills: BTreeMap<String, String>,
    instructions: BTreeMap<String, HostRegistration>,
    hooks: BTreeMap<String, Registration>,
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
        let mut r: ProjectReceipt = serde_json::from_value(input::json(bytes, 1_048_576, 20)?)
            .map_err(|_| conflict("The project integration receipt is malformed."))?;
        if ![1, 2].contains(&r.version)
            || (r.version == 1) != r.shared_root.is_some()
            || r.owner != "specgit"
            || !same_project_root(&r.root, root)?
            || r.agents.is_empty()
            || r.skills.len() > 2
            || r.instructions.len() > 3
            || r.hooks.len() > 3
            || r.skills.keys().any(|p| {
                ![
                    ".agents/skills/specgit-native/SKILL.md",
                    ".claude/skills/specgit-native/SKILL.md",
                ]
                .contains(&p.as_str())
            })
            || r.instructions.iter().any(|(host, g)| {
                g.root != r.root
                    || !matches!(
                        (host.as_str(), g.instructions.as_str()),
                        ("generic", "AGENTS.md")
                            | ("codex", "AGENTS.md" | "AGENTS.override.md")
                            | ("claude", "CLAUDE.md")
                    )
            })
            || r.hooks.iter().any(|(host, h)| {
                h.skill.is_some()
                    || match host.as_str() {
                        "claude" => h.settings != r.root.join(".claude/settings.json"),
                        "codex" => h.settings != r.root.join(".codex/hooks.json"),
                        "opencode" => {
                            h.settings != r.root.join(".opencode/hooks.json") || h.created_hook_map
                        }
                        _ => true,
                    }
            })
        {
            return Err(conflict(
                "The project integration receipt is unsupported or unsafe.",
            ));
        }
        let shared_guidance = r.instructions.contains_key("generic")
            || r.instructions
                .get("codex")
                .is_some_and(|g| g.instructions == "AGENTS.md");
        if !r
            .skills
            .contains_key(".agents/skills/specgit-native/SKILL.md")
            || r.skills
                .contains_key(".claude/skills/specgit-native/SKILL.md")
                != r.agents.contains(&Agent::Claude)
            || (r.hooks.contains_key("claude") && !r.agents.contains(&Agent::Claude))
            || (r.hooks.contains_key("codex") && !r.agents.contains(&Agent::Codex))
            || r.instructions.contains_key("claude") != r.agents.contains(&Agent::Claude)
            || (r.hooks.contains_key("opencode") && !r.agents.contains(&Agent::Opencode))
            || (r.agents.contains(&Agent::Codex)
                && !shared_guidance
                && !r.instructions.contains_key("codex"))
            || ((r.agents.contains(&Agent::Generic) || r.agents.contains(&Agent::Opencode))
                && !shared_guidance)
        {
            return Err(conflict(
                "The project receipt lacks required selected-agent ownership.",
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
            version: 2,
            owner: "specgit".into(),
            root: root.into(),
            shared_root: None,
            agents: BTreeSet::new(),
            skills: BTreeMap::new(),
            instructions: BTreeMap::new(),
            hooks: BTreeMap::new(),
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
                let expected = if host == "opencode" {
                    opencode_manifest(&executable)
                } else {
                    manifest(&executable, agent)
                };
                let mut recognized: Vec<_> = expected.into_iter().collect();
                if agent == Agent::Codex {
                    // Recognize 2.9.2's executable + argv protocol only to
                    // report an orphan. Exact comparison grants no ownership.
                    recognized.extend(manifest(&executable, Agent::Claude));
                }
                recognized.iter().any(|expected| {
                    let group = &expected[event];
                    candidate == group
                        || (event == "PostToolUse" && host != "opencode" && {
                            let mut without_observer = group.clone();
                            without_observer["hooks"]
                                .as_array_mut()
                                .expect("manifest hooks")
                                .truncate(1);
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
    let mut changes = vec![];
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
        let proof = AssetStore::owned_at(private, &c.path, &c.before)?.ok_or_else(|| {
            conflict_at("project", &c.path, None, "The project skill permissions or transaction ownership changed; retain it for reconciliation.")
        })?;
        changes.push(c);
        changes.push(proof);
    }
    for (host, old) in &receipt.instructions {
        changes.push(instruction_change(host, root, Some(old), true, false)?.0);
    }
    for (host, old) in &receipt.hooks {
        changes.push(registration_change(host, &old.settings, Some(old), None)?);
    }
    changes.push(Change {
        path: private.join("ownership.json"),
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
    let requested: BTreeSet<_> = hooks.purposes.iter().copied().collect();
    if requested.len() != hooks.purposes.len()
        || (requested.contains(&HookPurpose::None) && requested.len() > 1)
    {
        return Err(Diagnostic::input(
            "Hook purposes must be unique; none cannot be combined with other purposes.",
        ));
    }
    if (options.uninstall || options.rollback.is_some())
        && (!requested.is_empty() || hooks.opencode_async_rewake)
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
    let allowed = vec![root.to_owned(), private.to_owned()];
    if let Some(id) = &options.rollback {
        return Ok(
            json!({"scope":"project","root":root,"private":private,"rolled_back":AssetStore::lock(private, &allowed, Duration::from_secs(2))?.rollback(id)?}),
        );
    }
    let (snapshot, previous) = read(root, private)?;
    let mut selected = previous.agents.clone();
    for agent in &options.agents {
        if options.agents.iter().filter(|a| *a == agent).count() != 1 {
            return Err(Diagnostic::input("Select each agent only once."));
        }
        selected.insert(*agent);
    }
    if selected.is_empty() {
        return Err(Diagnostic::input(
            "Select at least one --agent for a new project integration; no host is guessed.",
        ));
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
    let custom_opencode = options.opencode_claude_hooks || previous.hooks.contains_key("opencode");
    if hooks.opencode_async_rewake && (!selected.contains(&Agent::Opencode) || !custom_opencode) {
        return Err(Diagnostic::input(
            "Async rewake requires a selected custom OpenCode Claude-compatible host.",
        ));
    }
    let mut plans = BTreeMap::new();
    let mut purpose_evidence = serde_json::Map::new();
    let mut any_wake = false;
    for (agent, host) in [
        (Agent::Generic, "generic"),
        (Agent::Claude, "claude"),
        (Agent::Codex, "codex"),
        (Agent::Opencode, "opencode"),
    ] {
        if !selected.contains(&agent) {
            continue;
        }
        let (mut effective, old_wake) = recorded_purposes(previous.hooks.get(host));
        let mut wanted = requested.clone();
        if wanted.is_empty() && !previous.agents.contains(&agent) {
            wanted.extend([HookPurpose::Guard, HookPurpose::Context]);
            if matches!(agent, Agent::Claude | Agent::Codex) {
                wanted.insert(HookPurpose::Observe);
            }
        }
        effective.extend(wanted.iter().copied().filter(|p| *p != HookPurpose::None));
        if effective.contains(&HookPurpose::Observe) && !effective.contains(&HookPurpose::Context) {
            return Err(Diagnostic::input(
                "Observe requires effective context hooks.",
            ));
        }
        if host == "opencode"
            && hooks.opencode_async_rewake
            && (!effective.contains(&HookPurpose::Observe)
                || !effective.contains(&HookPurpose::Context))
        {
            return Err(Diagnostic::input(
                "Async rewake requires effective observe and context purposes.",
            ));
        }
        let mut declined = vec![];
        for purpose in effective.clone() {
            let refusal = if agent == Agent::Generic
                || (agent == Agent::Opencode && !custom_opencode)
            {
                Some((
                    "unsupported",
                    "This host integration installs guidance and Skill only.",
                ))
            } else if agent == Agent::Opencode
                && purpose == HookPurpose::Observe
                && !old_wake
                && !hooks.opencode_async_rewake
            {
                Some((
                    "unknown",
                    "Async rewake capability is unknown; explicitly opt in with --opencode-async-rewake or use bounded watch manually.",
                ))
            } else {
                None
            };
            if let Some((status, reason)) = refusal {
                effective.remove(&purpose);
                declined.push(json!({"purpose":purpose,"status":status,"reason":reason}));
            }
        }
        let wake = host == "opencode"
            && effective.contains(&HookPurpose::Observe)
            && (old_wake || hooks.opencode_async_rewake);
        any_wake |= wake && !options.uninstall;
        purpose_evidence.insert(host.into(), json!({"requested":wanted,"installed":if options.uninstall { BTreeSet::new() } else { effective.clone() },"declined":declined}));
        if !options.uninstall && !effective.is_empty() {
            plans.insert(host, purpose_manifest(source, agent, &effective, wake)?);
        }
    }
    let needs_executable = !plans.is_empty();
    let executable = needs_executable
        .then(|| shared_executable(source, root))
        .transpose()?;
    let mut receipt = ProjectReceipt {
        version: 2,
        owner: "specgit".into(),
        root: root.into(),
        shared_root: None,
        agents: selected.clone(),
        skills: BTreeMap::new(),
        instructions: BTreeMap::new(),
        hooks: BTreeMap::new(),
    };
    let mut changes = vec![];
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
            if change.before.digest().as_ref() != Some(hash) {
                if options.uninstall || change.before.bytes.is_none() {
                    return Err(conflict_at(
                        "project",
                        &change.path,
                        None,
                        "The owned project skill was edited or removed.",
                    ));
                }
                let proof = AssetStore::owned_pair_at(private, &receipt_path, &snapshot, &change.path, &change.before, Some(hash))?
                    .ok_or_else(|| conflict_at("project", &change.path, None, "The project skill permissions or transaction ownership changed; retain it for reconciliation."))?;
                for journal in proof {
                    if !changes.iter().any(|c: &Change| c.path == journal.path) {
                        changes.push(journal);
                    }
                }
            }
        } else if change.before.bytes.is_some() {
            return Err(conflict_at(
                "project",
                &change.path,
                None,
                "The project skill is unowned; preserve it and reconcile ownership first.",
            ));
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
        let proof = if let Some(old) = old.filter(|_| !options.uninstall) {
            let path = root.join(&old.instructions);
            let current = Snapshot::read(&path)?;
            AssetStore::owned_pair_at(private, &receipt_path, &snapshot, &path, &current, None)?
        } else {
            None
        };
        let (change, registration) =
            instruction_change(host, root, old, options.uninstall, proof.is_some())?;
        if let Some(proofs) = proof {
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
    let summary: Vec<_> = changes.iter().map(|c| json!({"path":c.path,"state":if c.unchanged(){"unchanged"}else if c.after.is_none(){"removed"}else if c.before.bytes.is_none(){"created"}else{"updated"}})).collect();
    let mut evidence = json!({"schema_version":2,"version":VERSION,"scope":"project","root":root,"private":private,"agents":selected,"opencode_claude_hooks":custom_opencode,"assets":summary,"written":false,"manifest_exported":false,"operation":if options.uninstall{"uninstall"}else if snapshot.bytes.is_some(){"update"}else{"install"},"registration":if options.uninstall{"removal_planned"}else{"write_planned"},"codex_trust":if selected.contains(&Agent::Codex){"review_in_host_required"}else{"not_applicable"},"host_delivery":{"imported_event":"not_checked","context_injection":"not_checked","visible_message":"not_checked","next_turn":"not_checked","idle_wake":"not_supported"}});
    evidence["hook_purposes"] = Value::Object(purpose_evidence);
    if any_wake {
        evidence["host_delivery"]["idle_wake"] = json!("configured_not_verified");
    }
    if options.dry_run {
        return Ok(evidence);
    }
    #[cfg(feature = "test-fixtures")]
    if let Some(marker) = std::env::var_os("SPECGIT_FIXTURE_SETUP_PLAN_READY") {
        std::fs::write(marker, b"planned")
            .map_err(|_| Diagnostic::input("Fixture plan marker is unavailable."))?;
    }
    let store = AssetStore::lock(private, &allowed, Duration::from_secs(2))?;
    if Snapshot::read(&private.join("ownership.json"))?.digest() != snapshot.digest() {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "setup",
            "Project ownership changed while acquiring the lock.",
            "Preview again after the other operation completes.",
        ));
    }
    if let Some(executable) = executable {
        let current = shared_executable(source, root)?;
        if !(Change {
            path: source.to_owned(),
            before: executable,
            after: current.bytes,
            permissions: current.permissions,
        })
        .unchanged()
        {
            return Err(Diagnostic::new(
                Code::ConcurrentEdit,
                "setup",
                "The installed executable changed while acquiring the project lock.",
                "Preview setup again with the current installed shared CLI.",
            ));
        }
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
    evidence["transaction"] = json!(store.apply(changes)?);
    evidence["written"] = json!(true);
    evidence["registration"] = json!(if options.uninstall {
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
    assets::safe_path(root)?;
    assets::safe_path(private)?;
    if !AssetStore::pending_at(private)?.is_empty() {
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
        version: 2,
        owner: "specgit".into(),
        root: root.into(),
        shared_root: None,
        agents: previous.agents.clone(),
        skills: BTreeMap::new(),
        instructions: BTreeMap::new(),
        hooks: BTreeMap::new(),
    };
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
        let proof = AssetStore::owned_pair_at(
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
        let proof =
            AssetStore::owned_pair_at(private, &receipt_path, &snapshot, &path, &current, None)?
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
        let proof =
            AssetStore::owned_pair_at(private, &receipt_path, &snapshot, path, &current, None)?
                .ok_or_else(|| {
                    conflict_at(
                        host,
                        path,
                        None,
                        "Host settings ownership or permissions cannot be proved.",
                    )
                })?;
        add_proofs(proof);
        let (purposes, wake) = recorded_purposes(Some(old));
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
        let entries = purpose_manifest(source, agent, &purposes, wake)?;
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
            Some(&entries),
            &recover_missing,
        )?;
        let mut registration = old.clone();
        registration.entries = entries;
        next.hooks.insert(host.clone(), registration);
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
    let receipt_bytes = serde_json::to_vec_pretty(&next)
        .map_err(|_| conflict("Project receipt cannot be represented."))?;
    changes.push(Change {
        path: receipt_path,
        before: snapshot.clone(),
        after: Some(receipt_bytes),
        permissions: snapshot.permissions.clone(),
    });
    let mut plan = assets::MaintenancePlan::new(
        private.into(),
        vec![root.into(), private.into()],
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

pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    run_with_hooks(options, HookOptions::default(), process, cwd).await
}

pub async fn run_with_hooks(
    options: Options,
    hooks: HookOptions,
    process: Process,
    cwd: &Path,
) -> Report {
    let result = async {
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
        install_with_hooks(
            &options,
            &hooks,
            &root,
            &git_dir.join("specgit-v2/agent-assets"),
            &source,
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
