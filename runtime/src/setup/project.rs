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

fn read(root: &Path, private: &Path) -> Result<(Snapshot, ProjectReceipt), Diagnostic> {
    let snapshot = Snapshot::read(&private.join("ownership.json"))?;
    let receipt = if let Some(bytes) = &snapshot.bytes {
        let r: ProjectReceipt = serde_json::from_value(input::json(bytes, 1_048_576, 20)?)
            .map_err(|_| conflict("The project integration receipt is malformed."))?;
        if ![1, 2].contains(&r.version)
            || (r.version == 1) != r.shared_root.is_some()
            || r.owner != "specgit"
            || r.root != root
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
                g.root != root
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
                        "claude" => h.settings != root.join(".claude/settings.json"),
                        "codex" => h.settings != root.join(".codex/hooks.json"),
                        "opencode" => {
                            h.settings != root.join(".opencode/hooks.json") || h.created_hook_map
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
            || r.hooks.contains_key("claude") != r.agents.contains(&Agent::Claude)
            || r.hooks.contains_key("codex") != r.agents.contains(&Agent::Codex)
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
    if !source.is_absolute() || source.starts_with(project) {
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
    Ok(snapshot)
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
        changes.push(instruction_change(host, root, Some(old), true)?.0);
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
    let needs_executable = !options.uninstall
        && (custom_opencode
            || selected
                .iter()
                .any(|a| matches!(a, Agent::Claude | Agent::Codex)));
    let executable = needs_executable
        .then(|| shared_executable(source, root))
        .transpose()?;
    let entries = executable.as_ref().map(|_| manifest(source));
    let opencode_entries = if needs_executable && custom_opencode {
        Some(opencode_manifest(source)?)
    } else {
        None
    };
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
                return Err(conflict_at(
                    "project",
                    &change.path,
                    None,
                    "The owned project skill was edited or removed.",
                ));
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
            let shadows = Snapshot::read(&override_path)?
                .bytes
                .is_some_and(|b| !b.iter().all(u8::is_ascii_whitespace));
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
        let (change, registration) = instruction_change(host, root, old, options.uninstall)?;
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
        let entries = if host == "opencode" {
            &opencode_entries
        } else {
            &entries
        };
        let change = registration_change(host, &path, old, entries.as_ref())?;
        if let Some(entries) = &entries {
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

pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
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
        install(
            &options,
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
