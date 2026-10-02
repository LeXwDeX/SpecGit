//! Digest-bound local retirement. Native lifecycle reads are evidence, never writes.
use crate::{
    assets::{self, AssetStore, Change, Snapshot},
    config,
    diagnostic::{Code, Diagnostic},
    guard, guidance, local_exclude,
    observation::{self, Status},
    process::Process,
    project,
    report::Report,
    selection, setup,
};
use clap::Args;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Args, Default)]
pub struct Options {
    /// Read-only preview; also the default when --apply is absent.
    #[arg(long, conflicts_with_all = ["apply", "rollback"])]
    pub dry_run: bool,
    /// Apply only the exact previously inspected preview.
    #[arg(long, requires = "expect", conflicts_with = "rollback")]
    pub apply: bool,
    #[arg(long, requires = "apply", conflicts_with = "rollback")]
    pub expect: Option<String>,
    /// Restore one removal transaction without forge access.
    #[arg(long)]
    pub rollback: Option<String>,
}

fn conflict(path: &Path, message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "remove",
        &format!("{}: {message}", path.display()),
        "Preserve the files; reconcile ownership or finish/recover delivery before previewing removal again.",
    )
}

struct Layout {
    root: PathBuf,
    private: PathBuf,
    exclude: PathBuf,
    hooks: PathBuf,
    allowed: Vec<PathBuf>,
}
impl Layout {
    async fn read(process: &Process, cwd: &Path) -> Result<Self, Diagnostic> {
        let root = git_path(process, cwd, &["rev-parse", "--show-toplevel"]).await?;
        let git_dir = git_path(process, &root, &["rev-parse", "--absolute-git-dir"]).await?;
        let common = git_path(
            process,
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
        let exclude = local_exclude::path(process, &root).await?;
        let hooks = hooks_root(
            git_path(
                process,
                &root,
                &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
            )
            .await?,
        );
        let private = git_dir.join("specgit-v2");
        let mut allowed = vec![
            root.clone(),
            private.clone(),
            exclude
                .parent()
                .ok_or_else(|| Diagnostic::input("Invalid exclude path."))?
                .into(),
        ];
        if hooks.starts_with(&root) || hooks.starts_with(&common) {
            allowed.push(hooks.clone());
        }
        Ok(Self {
            root,
            private,
            exclude,
            hooks,
            allowed,
        })
    }
    fn stores(&self) -> Vec<PathBuf> {
        [
            "assets",
            "transactions",
            "agent-assets",
            "delivery-transactions",
            "removal",
        ]
        .iter()
        .map(|name| self.private.join(name))
        .collect()
    }
}
fn hooks_root(path: PathBuf) -> PathBuf {
    if path.file_name().is_some_and(|n| n == "_")
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == ".husky")
    {
        path.parent().expect("Husky parent was verified").into()
    } else {
        path
    }
}
async fn git_path(process: &Process, root: &Path, args: &[&str]) -> Result<PathBuf, Diagnostic> {
    let bytes = project::git(process, root, args).await?;
    let text =
        std::str::from_utf8(&bytes).map_err(|_| Diagnostic::input("Git path is not UTF-8."))?;
    let path = PathBuf::from(text.trim_end_matches(['\r', '\n']));
    assets::safe_path(&path)?;
    Ok(path)
}

#[derive(Default)]
struct Plan {
    changes: BTreeMap<PathBuf, Change>,
    items: BTreeMap<PathBuf, Value>,
    diagnostics: Vec<Diagnostic>,
    consumers: Vec<Value>,
    lifecycle: Value,
    git_state_sha256: String,
}
impl Plan {
    fn add(&mut self, path: &Path, ownership: &str, result: Result<Vec<Change>, Diagnostic>) {
        match result {
            Ok(changes) => {
                for c in changes {
                    if !self
                        .items
                        .get(&c.path)
                        .is_some_and(|item| item["state"] == "conflict")
                    {
                        self.items.insert(c.path.clone(), json!({"path":c.path,"state":if c.unchanged(){"preserved"}else if c.after.is_none(){"removed"}else{"updated"},"ownership":ownership}));
                    }
                    if let Some(old) = self.changes.get_mut(&c.path) {
                        // Init and project-agent guidance own disjoint blocks in the same file.
                        if old.before.bytes != c.before.bytes {
                            self.diagnostics.push(conflict(
                                &c.path,
                                "Overlapping plans disagree on the preimage.",
                            ));
                            continue;
                        }
                        if old.after != c.after {
                            self.diagnostics.push(conflict(
                                &c.path,
                                "Overlapping asset plans require explicit reconciliation.",
                            ));
                        }
                    } else {
                        self.changes.insert(c.path.clone(), c);
                    }
                }
            }
            Err(d) => {
                self.items.insert(
                    path.to_owned(),
                    json!({"path":path,"state":"conflict","ownership":ownership,"code":d.code}),
                );
                self.diagnostics.push(d);
            }
        }
    }
    fn preserve(&mut self, path: &Path, reason: &str) {
        if self
            .items
            .get(path)
            .is_some_and(|item| item["state"] == "conflict")
        {
            return;
        }
        self.add(
            path,
            reason,
            Change::new(path.into(), None).map(|mut c| {
                c.after = c.before.bytes.clone();
                vec![c]
            }),
        );
    }
    fn evidence(&self, layout: &Layout) -> Value {
        let changes: Vec<_> = self.changes.values().map(|c| json!({
            "path":c.path,"before_sha256":c.before.digest(),"after_sha256":c.after.as_deref().map(assets::hash),
            "permissions":permission(&c.before),
        })).collect();
        let items: Vec<_> = self.items.values().collect();
        json!({"root":layout.root,"private":layout.private,"assets":items,"planned_changes":changes,
            "git_state_sha256":self.git_state_sha256,
            "shared_consumers":self.consumers,"checkpoint":self.lifecycle,"written":false,"native_writes":false,
            "retained_evidence":"Transaction backups, locks and unknown private files remain for recovery; global assets and remote data are untouched."})
    }
}
fn permission(snapshot: &Snapshot) -> Value {
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        snapshot.permissions.as_ref().map(|p| p.mode() & 0o7777)
    };
    #[cfg(not(unix))]
    let mode: Option<u32> = None;
    json!({"readonly":snapshot.permissions.as_ref().map(std::fs::Permissions::readonly),"unix_mode":mode})
}

async fn plan(layout: &Layout, process: &Process) -> Result<Plan, Diagnostic> {
    let mut plan = Plan {
        git_state_sha256: assets::hash(
            &project::git(
                process,
                &layout.root,
                &[
                    "--no-optional-locks",
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "-z",
                ],
            )
            .await?,
        ),
        ..Plan::default()
    };
    for store in layout.stores() {
        let pending = AssetStore::pending_at(&store)?;
        if !pending.is_empty() {
            plan.add(
                &store,
                "transaction_journal",
                Err(conflict(
                    &store,
                    &format!(
                        "Interrupted transactions require rollback first: {}",
                        pending.join(", ")
                    ),
                )),
            );
        }
    }
    let list = project::git(
        process,
        &layout.root,
        &["worktree", "list", "--porcelain", "-z"],
    )
    .await?;
    let mut count = 0;
    for field in list.split(|b| *b == 0) {
        let Some(raw) = field.strip_prefix(b"worktree ") else {
            continue;
        };
        count += 1;
        if count > 64 {
            return Err(Diagnostic::input("Removal discovery exceeds 64 worktrees."));
        }
        let sibling = PathBuf::from(
            std::str::from_utf8(raw).map_err(|_| Diagnostic::input("Invalid worktree path."))?,
        );
        assets::safe_path(&sibling)?;
        if sibling.canonicalize().ok() == layout.root.canonicalize().ok() {
            continue;
        }
        let pointer = config::snapshot(&sibling)?;
        // Even invalid/legacy sibling declarations remain consumers, not permission to delete.
        if pointer.bytes.is_some() {
            let hook = hooks_root(
                git_path(
                    process,
                    &sibling,
                    &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
                )
                .await?,
            );
            plan.consumers.push(json!({"root":sibling,"declaration_sha256":pointer.digest(),"shares_hooks":hook==layout.hooks}));
        }
    }
    let config_path = layout.root.join(".specgit.yaml");
    let declaration = match config::read(&layout.root) {
        Ok(d) => d,
        Err(d) => {
            plan.add(&config_path, "declaration", Err(d));
            None
        }
    };
    let tracked = !project::git(
        process,
        &layout.root,
        &["ls-files", "-z", "--", ".specgit.yaml"],
    )
    .await?
    .is_empty();
    for path in [&config_path, &layout.private.join("local-routing.json")] {
        let c = Change::new(path.clone(), None)?;
        if c.before.bytes.is_some() {
            if path == &config_path && tracked {
                plan.add(path, "tracked_declaration", Err(conflict(path, "The declaration is tracked; removal does not change the Git index. Reconcile it through an explicitly reviewed repository change first.")));
                continue;
            }
            let proof = AssetStore::owned_at(&layout.private.join("assets"), path, &c.before)?;
            plan.add(path, "committed_init_or_migrate_journal", match proof {
                Some(proof) => Ok(vec![c, proof]),
                None => Err(conflict(path, "The bytes or permissions do not match a committed owned transaction; refresh init or reconcile the declaration explicitly.")),
            });
        } else {
            plan.preserve(path, "absent");
        }
    }
    let selection_path = layout.private.join("selection.json");
    let selected = match selection::read_path(&selection_path) {
        Ok(s) => s,
        Err(d) => {
            plan.add(&selection_path, "delivery_checkpoint", Err(d));
            None
        }
    };
    if let Some(selected) = selected {
        let completed = async {
            let w = crate::delivery_context::Workspace::load(process.clone(), &layout.root).await?;
            let s = selection::read(&w.context)?.ok_or_else(|| conflict(&selection_path, "The checkpoint disappeared."))?;
            if s.project_id != w.facts.id || !s.checkpoint_valid(Some(&w.target)) || s.intents.iter().any(|i| i.issue.is_none()) {
                return Err(conflict(&selection_path, "The checkpoint is incomplete or belongs to another native project."));
            }
            let request = s.request.ok_or_else(|| conflict(&selection_path, "The checkpoint has no delivered request."))?;
            let observed = observation::observe(Some(request), process.clone(), &layout.root).await;
            if observed.status != Status::Completed || !observed.diagnostics.is_empty()
                || observed.evidence.issues.as_ref().is_none_or(|issues| s.issues.iter().any(|id| !issues.iter().any(|i| i.id == *id && i.state == "closed"))) {
                return Err(conflict(&selection_path, "Finish the native target merge and every selected Issue closure before removal."));
            }
            let native = observed.evidence.request.as_ref().ok_or_else(|| conflict(&selection_path, "Native request evidence is unavailable."))?;
            if native.target != s.target { return Err(conflict(&selection_path, "The delivered request targets another branch.")); }
            Ok(json!({"request":request,"head":native.head,"target":native.target,"issues":s.issues,"state":"completed"}))
        }.await;
        match completed {
            Ok(evidence) => {
                plan.lifecycle = evidence;
                plan.add(
                    &selection_path,
                    "verified_native_completion",
                    Change::new(selection_path.clone(), None).map(|c| vec![c]),
                );
            }
            Err(d) => {
                plan.lifecycle = json!({"issues":selected.issues,"state":"unfinished"});
                plan.add(&selection_path, "delivery_checkpoint", Err(d));
            }
        }
    } else {
        plan.preserve(&selection_path, "absent");
    }
    let init_guidance = if let Some(d) = &declaration {
        guidance::removal(&layout.root, &layout.private, d)
    } else if guidance::has_block(&layout.root.join("AGENTS.md"))?
        || guidance::has_block(&layout.root.join("CLAUDE.md"))?
        || layout.private.join("guidance.json").exists()
    {
        Err(conflict(
            &config_path,
            "Init guidance has no declaration to verify ownership.",
        ))
    } else {
        Ok(vec![])
    };
    plan.add(
        &layout.root.join("AGENTS.md"),
        "init_guidance_receipt_or_exact_template",
        init_guidance,
    );
    // Agent guidance must be composed against init's planned postimage, never written separately.
    match setup::project::removal(&layout.root, &layout.private.join("agent-assets")) {
        Ok(mut changes) => {
            for c in &mut changes {
                if let Some(init) = plan.changes.get(&c.path) {
                    let before = c.before.bytes.as_deref().unwrap_or_default();
                    let after_init = init.after.as_deref().unwrap_or_default();
                    let after_agent = c.after.as_deref().unwrap_or_default();
                    let text = std::str::from_utf8(before)
                        .map_err(|_| conflict(&c.path, "Guidance is not UTF-8."))?;
                    let init_text = std::str::from_utf8(after_init)
                        .map_err(|_| conflict(&c.path, "Guidance is not UTF-8."))?;
                    let agent_text = std::str::from_utf8(after_agent)
                        .map_err(|_| conflict(&c.path, "Guidance is not UTF-8."))?;
                    let start = text
                        .find("<!-- specgit:v2:start -->")
                        .ok_or_else(|| conflict(&c.path, "Unexpected overlapping asset."))?;
                    let end = text
                        .find("<!-- specgit:v2:end -->")
                        .ok_or_else(|| conflict(&c.path, "Unexpected overlapping asset."))?
                        + "<!-- specgit:v2:end -->".len();
                    let block = &text[start..end];
                    if !agent_text.contains(block) || init_text.contains(block) {
                        return Err(conflict(
                            &c.path,
                            "Disjoint guidance ownership could not be proven.",
                        ));
                    }
                    let mut end = end;
                    if text[end..].starts_with("\r\n") {
                        end += 2;
                    } else if text[end..].starts_with('\n') {
                        end += 1;
                    }
                    let combined = agent_text.replacen(&text[start..end], "", 1);
                    c.after = if combined.is_empty() {
                        None
                    } else {
                        Some(combined.into_bytes())
                    };
                    plan.changes.remove(&c.path);
                }
            }
            plan.add(
                &layout.private.join("agent-assets/ownership.json"),
                "project_agent_receipt",
                Ok(changes),
            );
        }
        Err(d) => plan.add(
            &layout.private.join("agent-assets/ownership.json"),
            "project_agent_receipt",
            Err(d),
        ),
    }
    if plan.consumers.is_empty() {
        plan.add(
            &layout.exclude,
            "exact_shared_exclude_block",
            local_exclude::removal(&layout.exclude).map(|c| vec![c]),
        );
    } else {
        plan.preserve(&layout.exclude, "shared_initialized_worktree");
    }
    let guard_receipt = layout.private.join("guard-hooks.json");
    if guard_receipt.exists() {
        let result = guard::plan(process, &layout.root, true).await;
        let shared = plan.consumers.iter().any(|c| c["shares_hooks"] == true);
        match result {
            Ok((changes, hooks, _)) => {
                if changes.iter().any(|c| {
                    c.path != guard_receipt
                        && c.path != hooks.join("pre-commit")
                        && c.path != hooks.join("pre-push")
                }) {
                    plan.add(
                        &guard_receipt,
                        "guard_receipt",
                        Err(conflict(
                            &guard_receipt,
                            "Recorded hook paths differ from the effective hook directory.",
                        )),
                    );
                } else if shared {
                    for c in changes {
                        plan.preserve(&c.path, "shared_initialized_worktree");
                    }
                } else {
                    plan.add(&guard_receipt, "exact_guard_receipt_block", Ok(changes));
                }
            }
            Err(d) => plan.add(&guard_receipt, "guard_receipt", Err(d)),
        }
    } else {
        plan.preserve(&guard_receipt, "absent");
        for stage in ["pre-commit", "pre-push"] {
            plan.preserve(&layout.hooks.join(stage), "unowned_hook_preserved");
        }
    }
    for name in [
        "AGENTS.md",
        "CLAUDE.md",
        "AGENTS.override.md",
        ".agents/skills/specgit-native/SKILL.md",
        ".claude/skills/specgit-native/SKILL.md",
        ".claude/settings.json",
        ".codex/hooks.json",
    ] {
        let path = layout.root.join(name);
        if !plan.changes.contains_key(&path) {
            plan.preserve(&path, "unowned_or_absent_preserved");
        }
    }
    Ok(plan)
}

pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    match tokio::time::timeout(Duration::from_secs(180), execute(options, &process, cwd)).await {
        Ok(Ok(report)) => report,
        Ok(Err(d)) => Report::failure("remove", d),
        Err(_) => Report::failure(
            "remove",
            Diagnostic::new(
                Code::Timeout,
                "remove",
                "Removal inspection reached its 180-second bound.",
                "Inspect retained transactions; preview or roll back explicitly.",
            ),
        ),
    }
}
async fn execute(options: Options, process: &Process, cwd: &Path) -> Result<Report, Diagnostic> {
    if options.apply && (options.dry_run || options.rollback.is_some() || options.expect.is_none())
        || options.expect.is_some() && !options.apply
        || options.dry_run && options.rollback.is_some()
    {
        return Err(Diagnostic::input(
            "Use preview, --apply --expect <digest>, or --rollback <transaction> separately.",
        ));
    }
    let layout = Layout::read(process, cwd).await?;
    if let Some(id) = options.rollback {
        let locks: Vec<_> = layout
            .stores()
            .iter()
            .map(|p| AssetStore::lock(p, &layout.allowed, Duration::from_secs(2)))
            .collect::<Result<_, _>>()?;
        let restored = locks
            .last()
            .ok_or_else(|| Diagnostic::input("Removal store is unavailable."))?
            .rollback(&id)?;
        return Ok(Report::success(
            "remove",
            "rolled_back",
            json!({"root":layout.root,"transaction":restored,"native_writes":false}),
        ));
    }
    let mut planned = plan(&layout, process).await?;
    let mut evidence = planned.evidence(&layout);
    let digest = assets::hash(
        &serde_json::to_vec(&evidence)
            .map_err(|_| Diagnostic::input("Removal preview cannot be represented."))?,
    );
    evidence["preview_sha256"] = json!(digest);
    if let Some(d) = planned.diagnostics.first() {
        let mut report = Report::failure("remove", d.clone());
        report.evidence = evidence;
        report.diagnostics = planned.diagnostics;
        return Ok(report);
    }
    if !options.apply {
        return Ok(Report::success("remove", "prepared", evidence));
    }
    if options.expect.as_deref() != Some(&digest) {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "remove",
            "The preview digest no longer matches local or native evidence.",
            "Run specgit remove --dry-run --json again and review its exact preview_sha256.",
        ));
    }
    #[cfg(feature = "test-fixtures")]
    if let Some(marker) = std::env::var_os("SPECGIT_FIXTURE_REMOVE_PLAN_READY") {
        std::fs::write(marker, b"planned")
            .map_err(|_| Diagnostic::input("Fixture plan marker is unavailable."))?;
    }
    let locks: Vec<_> = layout
        .stores()
        .iter()
        .map(|p| AssetStore::lock(p, &layout.allowed, Duration::from_secs(2)))
        .collect::<Result<_, _>>()?;
    let fresh = plan(&layout, process).await?;
    if !fresh.diagnostics.is_empty() || fresh.evidence(&layout) != planned.evidence(&layout) {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "remove",
            "Removal evidence changed while acquiring the operation locks.",
            "Preserve the current assets and preview again.",
        ));
    }
    let changes = std::mem::take(&mut planned.changes)
        .into_values()
        .collect::<Vec<_>>();
    // Unchanged ownership witnesses are filtered by apply; check them explicitly.
    for c in &changes {
        let actual = Snapshot::read(&c.path)?;
        if actual.bytes != c.before.bytes || permission(&actual) != permission(&c.before) {
            return Err(conflict(
                &c.path,
                "An asset changed after the locked preview.",
            ));
        }
    }
    let witnesses: Vec<_> = changes.iter().filter(|c| c.unchanged()).cloned().collect();
    evidence["transaction"] = json!(
        locks
            .last()
            .ok_or_else(|| Diagnostic::input("Removal store is unavailable."))?
            .apply_checked(changes, |_| {
                for witness in &witnesses {
                    let actual = Snapshot::read(&witness.path)?;
                    if actual.bytes != witness.before.bytes
                        || permission(&actual) != permission(&witness.before)
                    {
                        return Err(conflict(
                            &witness.path,
                            "An ownership witness changed during the removal transaction.",
                        ));
                    }
                }
                Ok(())
            })?
    );
    evidence["written"] = json!(true);
    Ok(Report::success("remove", "removed", evidence))
}
