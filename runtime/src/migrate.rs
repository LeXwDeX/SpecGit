//! Explicit, recoverable v1 cutover. It never writes to a forge or reuses a v1 delivery binding.
use crate::{
    assets::{AssetStore, Change, hash, safe_path},
    config::{self, Declaration},
    diagnostic::{Code, Diagnostic},
    guidance,
    migration_assets::Inventory,
    migration_remote,
    probe::{self, ForgeRead},
    process::Process,
    project::{self},
    report::Report,
    templates,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(clap::Args, Default)]
pub struct Options {
    /// The complete, explicitly selected v2 declaration; v1 policy is preserved as migration input.
    #[arg(long, conflicts_with = "rollback")]
    pub config_file: Option<PathBuf>,
    /// Commit the reviewed local transaction. Preview is the default.
    #[arg(long, requires = "expect", conflicts_with = "rollback")]
    pub apply: bool,
    /// Exact preview digest; a changed local/native inventory requires a new preview.
    #[arg(long, requires = "apply", conflicts_with = "rollback")]
    pub expect: Option<String>,
    /// Retire proven local v1 assets while leaving the v1 declaration active for staged cutover.
    #[arg(long, conflicts_with = "rollback")]
    pub retire_only: bool,
    #[arg(long, conflicts_with = "rollback")]
    pub api_host: Option<String>,
    #[arg(long)]
    pub rollback: Option<String>,
}
#[derive(Deserialize)]
struct Legacy {
    version: u8,
    #[serde(default)]
    delivery: Option<String>,
    #[serde(default)]
    issues: Vec<u64>,
    #[serde(default)]
    pr: Option<u64>,
}
fn failure(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::MigrationRequired,
        "migration",
        message,
        "Preview with specgit migrate --config-file <v2.yaml>. Retire native v1 workflows through the approved repository change, wait for old runs to finish, then apply the fresh preview digest. Old drafts remain available to the v1 executable.",
    )
}
async fn git_path(process: &Process, cwd: &Path, args: &[&str]) -> Result<PathBuf, Diagnostic> {
    let bytes = project::git(process, cwd, args).await?;
    let text = String::from_utf8(bytes)
        .map_err(|_| Diagnostic::input("Git returned an invalid filesystem path."))?;
    let path = PathBuf::from(text.trim_end_matches(['\r', '\n']));
    path_identity(&if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}
fn path_identity(path: &Path) -> Result<PathBuf, Diagnostic> {
    // Keep symbolic-link/traversal rejection before normalizing aliases. Windows
    // Git drive paths and filesystem verbatim paths must compare as one identity.
    safe_path(path)?;
    let mut parent = path.to_owned();
    let mut absent = Vec::new();
    loop {
        match parent.canonicalize() {
            Ok(mut normalized) => {
                for component in absent.iter().rev() {
                    normalized.push(component);
                }
                return Ok(normalized);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                absent.push(
                    parent
                        .file_name()
                        .ok_or_else(|| failure("A filesystem identity is unavailable."))?
                        .to_owned(),
                );
                if !parent.pop() {
                    return Err(failure("A filesystem identity is unavailable."));
                }
            }
            Err(_) => return Err(failure("A filesystem identity cannot be verified.")),
        }
    }
}
async fn shares_v1_hook(process: &Process, root: &Path, hook: &Path) -> Result<bool, Diagnostic> {
    let list = project::git(process, root, &["worktree", "list", "--porcelain", "-z"]).await?;
    let mut count = 0;
    for field in list.split(|byte| *byte == 0) {
        let Some(raw) = field.strip_prefix(b"worktree ") else {
            continue;
        };
        count += 1;
        if count > 64 {
            return Err(failure("Shared hook discovery exceeds 64 worktrees."));
        }
        let sibling = path_identity(&PathBuf::from(
            std::str::from_utf8(raw).map_err(|_| failure("A worktree path cannot be verified."))?,
        ))?;
        if sibling == root {
            continue;
        }
        let pointer = config::snapshot(&sibling)?;
        match pointer.bytes.as_deref() {
            Some(bytes) if Declaration::parse(bytes).is_ok() => continue,
            None if !crate::migration_assets::legacy_present(&sibling)? => continue,
            _ => {}
        }
        let sibling_hook = git_path(
            process,
            &sibling,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "hooks/pre-push",
            ],
        )
        .await?;
        if sibling_hook == hook {
            return Ok(true);
        }
    }
    Ok(false)
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    let cancellation = process.cancellation.clone();
    let operation = execute(options, process, cwd);
    tokio::select! {
        _ = cancellation.cancelled() => Report::failure("migrate", Diagnostic::new(Code::Cancelled,"migration","Migration was cancelled.","Inspect any saved asset transaction and resume or roll back explicitly.")),
        result = tokio::time::timeout(Duration::from_secs(180),operation) => match result {
            Ok(Ok(report)) => report,
            Ok(Err(d)) => Report::failure("migrate",d),
            Err(_) => Report::failure("migrate", Diagnostic::new(Code::Timeout,"migration","Migration inspection reached its 180-second bound.","Inspect any pending transaction and retry after native evidence is available.")),
        }
    }
}
async fn execute(options: Options, process: Process, cwd: &Path) -> Result<Report, Diagnostic> {
    let root = git_path(&process, cwd, &["rev-parse", "--show-toplevel"])
        .await?
        .canonicalize()
        .map_err(|_| Diagnostic::input("Git root is unavailable."))?;
    let git_dir = git_path(&process, &root, &["rev-parse", "--absolute-git-dir"]).await?;
    let hook = git_path(
        &process,
        &root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/pre-push",
        ],
    )
    .await?;
    let private = git_dir.join("specgit-v2");
    let store_root = private.join("assets");
    if let Some(id) = &options.rollback {
        let store = AssetStore::lock(
            &store_root,
            &[root.clone(), private.clone()],
            Duration::from_secs(2),
        )?;
        return Ok(Report::success(
            "migrate",
            "rolled_back",
            json!({"transaction":store.rollback(id)?,"native_writes":false,"native_configuration":"unchanged_by_migration"}),
        ));
    }
    let selected = options.config_file.as_ref().ok_or_else(|| Diagnostic::input("Migration requires --config-file with a complete v2 declaration; no legacy flags are reinterpreted."))?;
    let declaration = Declaration::parse(templates::read_text(selected)?.as_bytes())?;
    let mut inventory = Inventory::read(&root, &hook)?;
    let legacy = config::snapshot(&root)?;
    let old: Legacy = if let Some(bytes) = legacy.bytes.as_deref() {
        serde_yaml_ng::from_slice(bytes).map_err(|_| {
            failure(
                "The v1 declaration is unreadable; preserve it and inspect with its existing CLI.",
            )
        })?
    } else {
        #[derive(Deserialize)]
        struct Version {
            version: u8,
        }
        let policy = crate::assets::Snapshot::read(&root.join("spec_git/policy.yaml"))?;
        if !policy.bytes.as_deref().is_some_and(|bytes| {
            serde_yaml_ng::from_slice::<Version>(bytes).is_ok_and(|v| v.version == 1)
        }) {
            return Err(failure("There is no v1 declaration or policy to migrate."));
        }
        Legacy {
            version: 1,
            delivery: None,
            issues: vec![],
            pr: None,
        }
    };
    if old.version != 1 || old.issues.len() > 100 {
        return Err(failure(
            "Only an explicitly selected v1 declaration can be migrated.",
        ));
    }
    if inventory.changes.iter().any(|c| c.path == hook)
        && ((!hook.starts_with(&root) && !hook.starts_with(&git_dir))
            || shares_v1_hook(&process, &root, &hook).await?)
    {
        inventory.blockers.push(hook.clone());
        inventory.changes.retain(|c| c.path != hook);
        if let Some(item) = inventory.items.iter_mut().find(|i| i.path == hook) {
            item.action = "preserve_shared_hook";
            item.after_sha256 = item.before_sha256.clone();
        }
    }
    let context = config::resolve(
        &process,
        &root,
        declaration.remote.as_deref(),
        declaration.provider,
        options.api_host.as_deref(),
    )
    .await?;
    let probes = probe::commands(&process, &root, context.repository.provider).await;
    let reader = ForgeRead::new(
        process.clone(),
        &root,
        context.repository.provider,
        &context.repository.host,
    )?;
    let (remote, remote_error) = if options.retire_only {
        (None, None)
    } else {
        match migration_remote::inspect(&reader, &context.repository).await {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        }
    };
    let mut changes = std::mem::take(&mut inventory.changes);
    if !options.retire_only {
        for name in ["AGENTS.md", "CLAUDE.md"] {
            let path = root.join(name);
            let existing_change = changes.iter().position(|c| c.path == path);
            if name == "CLAUDE.md" && existing_change.is_none() {
                continue;
            }
            let mut change = if let Some(index) = existing_change {
                changes.remove(index)
            } else {
                Change::new(path, None)?
            };
            let retained = if change.after.is_some() {
                change.after.as_deref()
            } else {
                change.before.bytes.as_deref()
            }
            .unwrap_or_default();
            let mut after = retained.to_vec();
            let text = std::str::from_utf8(retained)
                .map_err(|_| failure("Project guidance is not UTF-8."))?;
            if text.contains("<!-- specgit:v2:") {
                return Err(failure(
                    "A v1 project already has v2 guidance; reconcile the competing integration before migrating.",
                ));
            }
            if !after.is_empty() && !after.ends_with(b"\n") {
                after.push(b'\n');
            }
            after.extend_from_slice(format!("\n{}\n", guidance::render(&declaration)).as_bytes());
            change.after = Some(after);
            changes.push(change);
        }
        if let Some(host) = &options.api_host {
            let base = project::resolve(
                &process,
                &root,
                declaration.remote.as_deref(),
                declaration.provider,
                None,
            )
            .await?;
            changes.push(config::routing_change(&base, host)?);
        }
        // Configuration is last: local writers are retired and their preimages are durable first.
        changes.push(Change {
            path: root.join(".specgit.yaml"),
            permissions: legacy.permissions.clone(),
            before: legacy,
            after: Some(declaration.bytes()?),
        });
    }
    let planned_changes: Vec<_> = changes.iter().map(|c| json!({"path":c.path,"before_sha256":c.before.digest(),"after_sha256":c.after.as_deref().map(hash)})).collect();
    let fingerprint = hash(&serde_json::to_vec(&json!({"context":context,"items":inventory.items,"declaration":declaration,"remote":remote,"retire_only":options.retire_only,"planned_changes":planned_changes})).map_err(|_| Diagnostic::input("Cannot encode migration preview."))?);
    let mut evidence = json!({"preview_sha256":fingerprint,"context":context,"inventory":inventory.items,"planned_changes":planned_changes,"unprovable_assets":inventory.blockers,"probes":probes,"remote_retirement":remote,"declaration":declaration,"retired_policy_semantics":["custom_completion","independent_closure","derived_repairs","aggregate_scopes","cross_head_reuse_receipts"],"legacy_work":{"delivery":old.delivery,"issues":old.issues,"request":old.pr,"disposition":"preserved_for_v1_not_adopted"},"native_writes":false,"v1_executable":"preserved","written":false});
    let blocked = remote_error.is_some()
        || !inventory.blockers.is_empty()
        || remote
            .as_ref()
            .is_some_and(|r| !r.blockers.is_empty() || !r.unfinished_runs.is_empty())
        || probes
            .iter()
            .any(|p| p.status != probe::Capability::Available);
    if !options.apply {
        let mut report = Report::success(
            "migrate",
            if blocked {
                "preview_blocked"
            } else {
                "preview"
            },
            evidence,
        );
        if blocked {
            report.exit = 3;
            report
                .diagnostics
                .push(remote_error.clone().unwrap_or_else(|| {
                    failure("The preview contains unretired or unprovable v1 integration.")
                }));
        }
        return Ok(report);
    }
    if options.expect.as_deref() != Some(fingerprint.as_str()) {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "migration",
            "The preview digest no longer matches local or native evidence.",
            "Generate and inspect a fresh preview; do not reuse an old digest.",
        ));
    }
    if blocked {
        let mut report = Report::failure(
            "migrate",
            failure("A v2 activation cannot leave old or unprovable integration active."),
        );
        report.evidence = evidence;
        return Ok(report);
    }
    let store = AssetStore::lock(
        &store_root,
        &[root.clone(), private.clone()],
        Duration::from_secs(2),
    )?;
    inventory.verify()?;
    let refreshed = Inventory::read(&root, &hook)?;
    if serde_json::to_value(&refreshed.items).ok() != serde_json::to_value(&inventory.items).ok() {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "migration",
            "The migration inventory changed after inspection.",
            "Generate a fresh preview including newly created assets.",
        ));
    }
    let current = config::resolve(
        &process,
        &root,
        declaration.remote.as_deref(),
        declaration.provider,
        options.api_host.as_deref(),
    )
    .await?;
    if current.head != context.head
        || current.branch != context.branch
        || current.repository != context.repository
    {
        return Err(failure("The worktree identity changed during migration."));
    }
    if let Some(expected) = &remote
        && &migration_remote::inspect(&reader, &context.repository).await? != expected
    {
        return Err(failure(
            "Native writer evidence changed before local migration.",
        ));
    }
    let final_hook = git_path(
        &process,
        &root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/pre-push",
        ],
    )
    .await?;
    if final_hook != hook
        || (changes.iter().any(|c| c.path == hook)
            && shares_v1_hook(&process, &root, &hook).await?)
    {
        return Err(failure(
            "Shared hook configuration changed before migration.",
        ));
    }
    // Save the complete bounded inventory, including preserved drafts/policy, before retiring anything.
    let archive = json!({"version":2,"root":root,"git_dir":git_dir,"preview_sha256":fingerprint,"entries":inventory.snapshots.iter().map(|(path,s)|json!({"path":path,"sha256":s.digest(),"base64":s.bytes.as_deref().map(|b|STANDARD.encode(b)),"readonly":s.permissions.as_ref().map(|p|p.readonly())})).collect::<Vec<_>>()});
    let archive_path = private
        .join("migration")
        .join(format!("{fingerprint}.json"));
    changes.insert(
        0,
        Change::new(
            archive_path.clone(),
            Some(
                serde_json::to_vec(&archive)
                    .map_err(|_| Diagnostic::input("Cannot encode migration backup."))?,
            ),
        )?,
    );
    let applied = store.apply_checked(changes, |_| {
        if process.cancellation.is_cancelled() {
            Err(Diagnostic::new(
                Code::Cancelled,
                "migration",
                "Migration was cancelled before the next asset write.",
                "Inspect the recoverable asset transaction.",
            ))
        } else {
            Ok(())
        }
    })?;
    // All writes are synchronous and journaled; cancellation is checked before each write.
    evidence["written"] = json!(true);
    evidence["transaction"] = json!(applied.transaction);
    evidence["backup"] = json!(archive_path);
    evidence["activation"] = json!(if options.retire_only {
        "v1_preserved"
    } else {
        "v2_local_native_retirement_observed"
    });
    Ok(Report::success(
        "migrate",
        if options.retire_only {
            "retired_local_assets"
        } else {
            "migrated"
        },
        evidence,
    ))
}
