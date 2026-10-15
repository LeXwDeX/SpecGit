//! Local Git hook backstop. It uses only Git objects and the branch checkpoint.
use crate::{
    assets::{self, AssetStore, Change, Snapshot},
    config,
    diagnostic::{Code, Diagnostic},
    process::Process,
    project, selection,
};
use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
#[clap(rename_all = "kebab-case")]
pub enum Stage {
    PreCommit,
    PrePush,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HookReceipt {
    path: PathBuf,
    block: String,
    created: bool,
    original_empty: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation: Option<String>,
    hooks: BTreeMap<String, HookReceipt>,
}

fn hook_block(stage: &str) -> String {
    if stage == "pre-push" {
        return format!(
            "# >>> specgit-v2:{stage}:start >>>\nspecgit_input=$(mktemp /tmp/specgit-pre-push.XXXXXX) || exit 1\ntrap 'rm -f \"$specgit_input\"' EXIT HUP INT TERM\ncat > \"$specgit_input\"\nspecgit guard --stage pre-push < \"$specgit_input\" || exit $?\nexec < \"$specgit_input\"\nrm -f \"$specgit_input\"\ntrap - EXIT HUP INT TERM\n# <<< specgit-v2:{stage}:end <<<"
        );
    }
    format!(
        "# >>> specgit-v2:{stage}:start >>>\nspecgit guard --stage {stage} || exit $?\n# <<< specgit-v2:{stage}:end <<<"
    )
}

fn insert_after_shebang(before: &str, block: &str) -> Result<String, Diagnostic> {
    if before.contains("specgit-v2:pre-") {
        return Err(rejected(
            "An unowned SpecGit Git-hook marker already exists.",
        ));
    }
    if before.is_empty() {
        return Ok(format!("#!/bin/sh\n{block}"));
    }
    let first = before.lines().next().unwrap_or("");
    if !first.starts_with("#!") {
        return Err(rejected(
            "The existing Git hook has no shell shebang and was preserved.",
        ));
    }
    if first.starts_with("#!")
        && !["sh", "bash", "zsh"]
            .iter()
            .any(|shell| first.contains(shell))
    {
        return Err(rejected(
            "The existing Git hook is not a supported shell script and was preserved.",
        ));
    }
    if first.starts_with("#!") {
        let split = before.find('\n').map_or(before.len(), |index| index + 1);
        return Ok(format!("{}{block}{}", &before[..split], &before[split..]));
    }
    Ok(format!("#!/bin/sh\n{block}{before}"))
}

pub(crate) async fn plan(
    process: &Process,
    cwd: &Path,
    uninstall: bool,
) -> Result<(Vec<Change>, PathBuf, PathBuf), Diagnostic> {
    plan_named(process, cwd, uninstall, "guard-hooks.json").await
}

pub(crate) async fn plan_named(
    process: &Process,
    cwd: &Path,
    uninstall: bool,
    name: &str,
) -> Result<(Vec<Change>, PathBuf, PathBuf), Diagnostic> {
    let Some(root) = root(process, cwd).await? else {
        return Err(Diagnostic::new(
            Code::MissingProject,
            "git_guard",
            "Git-hook installation requires a working tree.",
            "Run the command from the intended repository.",
        ));
    };
    let git_dir = git_path(
        project::git(process, &root, &["rev-parse", "--absolute-git-dir"]).await?,
        "metadata",
    )?;
    let hook_root = config::worktree::hooks(process, &root).await?;
    let common_dir = git_path(
        project::git(
            process,
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?,
        "common metadata",
    )?;
    if !hook_root.starts_with(&root) && !hook_root.starts_with(&common_dir) {
        return Err(rejected(
            "The effective Git hooks path is external to this repository and its common Git directory.",
        ));
    }
    assets::safe_path(&hook_root)?;
    let legacy_pending = AssetStore::pending_at(&git_dir.join("specgit-v2/transactions"))?;
    if !legacy_pending.is_empty() {
        return Err(Diagnostic::new(
            Code::RollbackConflict,
            "git_guard",
            &format!(
                "Unfinished legacy guard transactions require recovery: {}.",
                legacy_pending.join(", ")
            ),
            "Preserve the legacy transactions/transactions journals and recover their exact ids before installing or migrating guard ownership.",
        ));
    }
    let shared = config::worktree::shared_setup_guard_private(process, &root).await?;
    let setup_path = setup_source(&git_dir.join("specgit-v2"), &shared)?;
    let receipt_path = if name == "setup-guard-hooks.json" {
        setup_path.clone()
    } else {
        git_dir.join("specgit-v2").join(name)
    };
    let receipt_snapshot = Snapshot::read(&receipt_path)?;
    let transfer_path = setup_path;
    if name == "setup-guard-hooks.json"
        && receipt_snapshot.bytes.is_some()
        && Snapshot::read(&git_dir.join("specgit-v2/guard-hooks.json"))?
            .bytes
            .is_some()
    {
        return Err(rejected(
            "Independent and setup guard sources both claim this worktree; preserve both receipts for reconciliation.",
        ));
    }
    let transferred = name == "guard-hooks.json"
        && !uninstall
        && receipt_snapshot.bytes.is_none()
        && Snapshot::read(&transfer_path)?.bytes.is_some();
    if receipt_snapshot.bytes.is_some()
        && name == "guard-hooks.json"
        && Snapshot::read(&transfer_path)?.bytes.is_some()
    {
        return Err(rejected(
            "Independent and setup guard sources both claim this worktree; preserve both receipts and reconcile the recorded transaction before maintenance.",
        ));
    }
    let previous_snapshot = if transferred {
        Snapshot::read(&transfer_path)?
    } else {
        receipt_snapshot.clone()
    };
    let previous: Option<Receipt> = previous_snapshot
        .bytes
        .as_ref()
        .map(|bytes| {
            let value = crate::input::json(bytes, 1_048_576, 16)?;
            serde_json::from_value(value).map_err(|_| {
                rejected("The Git-hook ownership receipt is malformed and was preserved.")
            })
        })
        .transpose()?;
    if previous.as_ref().is_some_and(|receipt| {
        !valid_receipt(receipt)
            || receipt.hooks.len() != 2
            || !["pre-commit", "pre-push"]
                .iter()
                .all(|stage| receipt.hooks.contains_key(*stage))
    }) {
        return Err(rejected(
            "The Git-hook ownership receipt version or inventory is unsupported.",
        ));
    }
    if uninstall && previous.is_none() {
        return Err(rejected("No owned SpecGit Git-hook installation exists."));
    }
    let mut changes = vec![];
    let mut recorded = BTreeMap::new();
    for stage in ["pre-commit", "pre-push"] {
        let old = previous
            .as_ref()
            .and_then(|receipt| receipt.hooks.get(stage));
        let path = old
            .map(|receipt| receipt.path.clone())
            .unwrap_or_else(|| hook_root.join(stage));
        if path != hook_root.join(stage) {
            return Err(rejected(
                "The recorded Git hook no longer matches the effective hooks path; preserve all assets and reconcile core.hooksPath before refreshing.",
            ));
        }
        let mut change = Change::new(path.clone(), None)?;
        let before = std::str::from_utf8(change.before.bytes.as_deref().unwrap_or_default())
            .map_err(|_| rejected("The existing Git hook is not UTF-8 and was preserved."))?;
        let next_block = format!("{}\n", hook_block(stage));
        let original_empty = old.map_or(before.is_empty(), |old| old.original_empty);
        let exact_generated = old.is_some_and(|old| before == format!("#!/bin/sh\n{}", old.block));
        let (after, created) = if let Some(old) = old {
            if before.matches(&old.block).count() != 1 {
                return Err(rejected(
                    "An owned SpecGit Git-hook block was edited, removed, or duplicated.",
                ));
            }
            (
                before.replacen(&old.block, if uninstall { "" } else { &next_block }, 1),
                old.created,
            )
        } else {
            if before.contains("specgit-v2:pre-")
                && let Some(owner) = owner(process, &root, &path).await?
            {
                return Err(owned_elsewhere(&path, &owner));
            }
            (
                insert_after_shebang(before, &next_block)?,
                change.before.bytes.is_none(),
            )
        };
        change.after = if uninstall && exact_generated {
            if created {
                None
            } else if original_empty {
                Some(vec![])
            } else {
                Some(after.into_bytes())
            }
        } else {
            Some(after.into_bytes())
        };
        #[cfg(unix)]
        if change.before.bytes.is_none() && change.after.is_some() {
            use std::os::unix::fs::PermissionsExt;
            change.permissions = Some(std::fs::Permissions::from_mode(0o755));
        }
        if !uninstall {
            recorded.insert(
                stage.to_owned(),
                HookReceipt {
                    path,
                    block: next_block,
                    created,
                    original_empty,
                },
            );
        }
        changes.push(change);
    }
    if previous.is_some() && (name == "setup-guard-hooks.json" || transferred) {
        let ownership = if transferred {
            &transfer_path
        } else {
            &receipt_path
        };
        for change in &changes {
            AssetStore::owned_pair_across_at(
                &source_stores(&git_dir.join("specgit-v2"), &shared),
                ownership,
                &previous_snapshot,
                &change.path,
                &change.before,
                None,
            )?
            .ok_or_else(|| {
                rejected("The setup guard ownership or permissions cannot be proved.")
            })?;
        }
    }
    let generation = match previous.as_ref().and_then(|r| r.generation.clone()) {
        Some(generation) => Some(generation),
        None if name == "setup-guard-hooks.json" && !uninstall => Some(new_generation()?),
        None => None,
    };
    let receipt = (!uninstall).then_some(Receipt {
        version: if generation.is_some() { 2 } else { 1 },
        generation,
        hooks: recorded,
    });
    changes.push(Change {
        path: receipt_path.clone(),
        before: receipt_snapshot.clone(),
        after: receipt
            .as_ref()
            .map(serde_json::to_vec_pretty)
            .transpose()
            .map_err(|_| Diagnostic::input("Git-hook receipt cannot be represented."))?,
        permissions: receipt_snapshot.permissions,
    });
    if transferred {
        changes.push(Change::new(transfer_path, None)?);
    }
    let receipt_parent = receipt_path
        .parent()
        .ok_or_else(|| Diagnostic::input("Invalid Git-hook receipt path."))?
        .to_owned();
    Ok((changes, hook_root, receipt_parent))
}

/// A selected guard installation. Unlike the ordinary install planner this
/// cannot introduce hooks when the worktree has no ownership receipt.
pub struct GuardHealthPlan {
    root: PathBuf,
    hook_root: PathBuf,
    receipt_parent: PathBuf,
    changes: Vec<Change>,
    dependencies: Vec<Change>,
}

impl GuardHealthPlan {
    pub fn depend_on(&mut self, path: &Path) -> Result<(), Diagnostic> {
        let snapshot = Snapshot::read(path)?;
        self.depend_on_snapshot(path, &snapshot);
        Ok(())
    }

    pub fn depend_on_snapshot(&mut self, path: &Path, snapshot: &Snapshot) {
        self.dependencies.push(Change {
            path: path.to_path_buf(),
            before: snapshot.clone(),
            after: snapshot.bytes.clone(),
            permissions: snapshot.permissions.clone(),
        });
    }

    pub fn assets(&self) -> Vec<assets::MaintenanceAsset> {
        self.changes
            .iter()
            .filter(|change| !change.unchanged())
            .map(|change| assets::MaintenanceAsset {
                path: change.path.clone(),
                state: if change.after.is_none() {
                    "removed"
                } else {
                    "updated"
                },
            })
            .collect()
    }

    /// Coordinate a guard repair with a composite setup plan. Delegation is
    /// allowed only when every guard write has the same preimage, postimage and
    /// permissions; partial or inconsistent overlap is a planning conflict.
    pub fn covered_by(&self, plan: &assets::MaintenancePlan) -> Result<bool, Diagnostic> {
        let writes: Vec<_> = self
            .changes
            .iter()
            .filter(|change| !change.unchanged())
            .collect();
        let setup = plan.planned_changes();
        if !writes.iter().any(|guard| {
            setup
                .iter()
                .any(|change| change.path == guard.path && !change.unchanged())
        }) {
            return Ok(false);
        }
        if writes.iter().all(|guard| {
            setup.iter().any(|change| {
                change.path == guard.path
                    && change.before.bytes == guard.before.bytes
                    && change.before.permissions.as_ref().map(permission_bits)
                        == guard.before.permissions.as_ref().map(permission_bits)
                    && change.after == guard.after
                    && change.permissions.as_ref().map(permission_bits)
                        == guard.permissions.as_ref().map(permission_bits)
            })
        }) {
            Ok(true)
        } else {
            Err(rejected(
                "Setup and Git guard repair plans overlap without identical ownership snapshots and target contents; inspect again before repair.",
            ))
        }
    }

    /// Hold the guard transaction lock while re-reading the effective Git
    /// path, ownership receipt, sibling consumers and hook permissions.
    pub async fn apply(self, process: &Process) -> Result<assets::Applied, Diagnostic> {
        if self.assets().is_empty() {
            return Ok(assets::Applied {
                transaction: String::new(),
                changes: 0,
            });
        }
        let serialization = serialization_path(process, &self.root).await?;
        let _serialization = AssetStore::lock(
            &serialization,
            std::slice::from_ref(&serialization),
            Duration::from_secs(2),
        )?;
        let store = AssetStore::lock(
            &self.receipt_parent.join("assets"),
            &[self.hook_root.clone(), self.receipt_parent.clone()],
            Duration::from_secs(2),
        )?;
        if !store.pending_transactions()?.is_empty() {
            return Err(rejected(
                "An unfinished guard transaction requires recovery.",
            ));
        }
        guard_dependencies_unchanged(&self.dependencies)?;
        let fresh = health_plan(process, &self.root)
            .await?
            .ok_or_else(|| rejected("The Git guard ownership receipt disappeared."))?;
        let same = self.changes.len() == fresh.changes.len()
            && self.changes.iter().zip(&fresh.changes).all(|(a, b)| {
                a.path == b.path && a.after == b.after && a.before.bytes == b.before.bytes
            });
        if !same || self.hook_root != fresh.hook_root {
            return Err(rejected("Git guard state changed after inspection."));
        }
        let dependencies = self.dependencies;
        store.apply_checked(self.changes, move |_| {
            guard_dependencies_unchanged(&dependencies)
        })
    }
}

fn guard_dependencies_unchanged(dependencies: &[Change]) -> Result<(), Diagnostic> {
    for dependency in dependencies {
        let current = Snapshot::read(&dependency.path)?;
        if current.bytes != dependency.before.bytes
            || current.permissions.as_ref().map(permission_bits)
                != dependency.before.permissions.as_ref().map(permission_bits)
        {
            return Err(rejected(
                "A guard maintenance dependency changed after inspection.",
            ));
        }
    }
    Ok(())
}

pub async fn health_plan(
    process: &Process,
    cwd: &Path,
) -> Result<Option<GuardHealthPlan>, Diagnostic> {
    let Some(root) = root(process, cwd).await? else {
        return Ok(None);
    };
    let private = config::worktree::private_root(process, &root).await?;
    let mut pending = AssetStore::pending_at(&private.join("transactions"))?;
    pending.extend(AssetStore::pending_at(&private.join("assets"))?);
    if !pending.is_empty() {
        return Err(Diagnostic::new(
            Code::RollbackConflict,
            "git_guard_health",
            &format!(
                "Unfinished Git guard transaction(s): {}.",
                pending.join(", ")
            ),
            &format!(
                "Preserve and inspect assets/transactions and legacy transactions/transactions under {} for id(s) {}; recover each verified id before using guard or doctor again. This CLI has no guard rollback command.",
                private.display(),
                pending.join(", ")
            ),
        ));
    }
    let shared = config::worktree::shared_setup_guard_private(process, &root).await?;
    let setup_path = setup_source(&private, &shared)?;
    let receipt_name = if Snapshot::read(&private.join("guard-hooks.json"))?
        .bytes
        .is_none()
        && Snapshot::read(&setup_path)?.bytes.is_some()
    {
        "setup-guard-hooks.json"
    } else {
        "guard-hooks.json"
    };
    let receipt_path = if receipt_name == "setup-guard-hooks.json" {
        setup_path
    } else {
        private.join(receipt_name)
    };
    let receipt_snapshot = Snapshot::read(&receipt_path)?;
    let Some(bytes) = receipt_snapshot.bytes.as_deref() else {
        let hook_root = config::worktree::hooks(process, &root).await?;
        for stage in ["pre-commit", "pre-push"] {
            let path = hook_root.join(stage);
            let snapshot = Snapshot::read(&path)?;
            let Some(contents) = snapshot.bytes else {
                continue;
            };
            let marker = b"specgit-v2:pre-";
            if contents.windows(marker.len()).any(|part| part == marker)
                && owner(process, &root, &path).await?.is_none()
            {
                return Err(Diagnostic::new(
                    Code::OwnershipConflict,
                    "git_guard_health",
                    &format!(
                        "The Git hook {} contains a SpecGit marker but this worktree has no guard ownership receipt.",
                        path.display()
                    ),
                    "Preserve the hook and recover its ownership receipt or inspect the owning sibling worktree before making changes.",
                ));
            }
        }
        return Ok(None);
    };
    let value = crate::input::json(bytes, 1_048_576, 16)?;
    let receipt: Receipt = serde_json::from_value(value)
        .map_err(|_| rejected("The Git-hook ownership receipt is malformed."))?;
    if !valid_receipt(&receipt) || receipt.hooks.len() != 2 {
        return Err(rejected(
            "The Git-hook ownership receipt inventory is unsupported.",
        ));
    }
    let hook_root = config::worktree::hooks(process, &root).await?;
    let common_dir = git_path(
        project::git(
            process,
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?,
        "common metadata",
    )?;
    if !hook_root.starts_with(&root) && !hook_root.starts_with(&common_dir) {
        return Err(rejected(
            "The effective Git hooks path is external to this repository.",
        ));
    }
    assets::safe_path(&hook_root)?;
    for stage in ["pre-commit", "pre-push"] {
        let hook = receipt
            .hooks
            .get(stage)
            .ok_or_else(|| rejected("The Git-hook ownership receipt inventory is incomplete."))?;
        if !hook
            .block
            .starts_with(&format!("# >>> specgit-v2:{stage}:start >>>\n"))
            || !hook
                .block
                .ends_with(&format!("# <<< specgit-v2:{stage}:end <<<\n"))
            || !hook
                .block
                .contains(&format!("specgit guard --stage {stage}"))
        {
            return Err(rejected(
                "The recorded Git-hook block has an invalid format.",
            ));
        }
        if hook.path != hook_root.join(stage) {
            return Err(rejected(
                "The recorded Git hook no longer matches the effective hooks path.",
            ));
        }
        let snapshot = Snapshot::read(&hook.path)?;
        let script = std::str::from_utf8(snapshot.bytes.as_deref().unwrap_or_default())
            .map_err(|_| rejected("The recorded Git hook is not UTF-8."))?;
        let first = script.lines().next().unwrap_or("");
        if !first.starts_with("#!")
            || !["sh", "bash", "zsh"]
                .iter()
                .any(|shell| first.contains(shell))
        {
            return Err(rejected(
                "The recorded Git hook has no supported shell shebang.",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if snapshot
                .permissions
                .as_ref()
                .is_none_or(|mode| mode.mode() & 0o111 == 0)
            {
                return Err(rejected(
                    "The recorded Git hook is not executable; restore its permissions explicitly.",
                ));
            }
        }
        if script.matches(&hook.block).count() != 1 {
            return Err(rejected(
                "The recorded Git-hook block is missing, edited or duplicated.",
            ));
        }
    }
    let (changes, planned_root, receipt_parent) =
        plan_named(process, &root, false, receipt_name).await?;
    if changes
        .iter()
        .any(|change| change.path.starts_with(&hook_root) && !change.unchanged())
    {
        for sibling in config::worktree::siblings(process, &root).await? {
            let shares = sibling.hooks == hook_root
                || matches!((sibling.hooks.canonicalize(), hook_root.canonicalize()), (Ok(a), Ok(b)) if a == b);
            if shares
                && Snapshot::read(&sibling.private_root.join("guard-hooks.json"))?
                    .bytes
                    .is_some()
            {
                return Err(rejected(
                    "Shared Git hooks have another ownership receipt; refresh from its owning worktree.",
                ));
            }
        }
        let consumers = config::worktree::sibling_hook_consumers(process, &root).await?;
        if consumers
            .iter()
            .any(|consumer| config::worktree::shares_hooks(consumer, &hook_root))
        {
            return Err(rejected(
                "Shared Git hooks have another initialized worktree consumer; refresh ownership from that worktree.",
            ));
        }
    }
    Ok(Some(GuardHealthPlan {
        root,
        hook_root: planned_root,
        receipt_parent,
        changes,
        dependencies: vec![],
    }))
}

#[cfg(unix)]
fn permission_bits(permission: &std::fs::Permissions) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    permission.mode()
}

#[cfg(not(unix))]
fn permission_bits(permission: &std::fs::Permissions) -> bool {
    permission.readonly()
}

/// The sibling worktree whose guard receipt records this shared hook file.
async fn owner(process: &Process, root: &Path, hook: &Path) -> Result<Option<PathBuf>, Diagnostic> {
    let Some(stage) = hook.file_name().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    if !["pre-commit", "pre-push"].contains(&stage) {
        return Ok(None);
    }
    let current = Snapshot::read(hook)?;
    let Some(current) = current.bytes else {
        return Ok(None);
    };
    let mut candidates: Vec<_> = config::worktree::siblings(process, root)
        .await?
        .into_iter()
        .map(|s| (s.root, s.private_root, s.hooks))
        .collect();
    candidates.push((
        root.to_owned(),
        config::worktree::shared_setup_guard_private(process, root).await?,
        config::worktree::hooks(process, root).await?,
    ));
    candidates.push((
        root.to_owned(),
        config::worktree::private_root(process, root).await?,
        config::worktree::hooks(process, root).await?,
    ));
    for (owner_root, private_root, hooks) in candidates {
        for name in ["guard-hooks.json", "setup-guard-hooks.json"] {
            let Some(bytes) = Snapshot::read(&private_root.join(name))?.bytes else {
                continue;
            };
            // A malformed sibling receipt names no owner; the generic conflict still applies.
            let Some(receipt) = crate::input::json(&bytes, 1_048_576, 16)
                .ok()
                .and_then(|value| serde_json::from_value::<Receipt>(value).ok())
            else {
                continue;
            };
            if !valid_receipt(&receipt)
                || receipt.hooks.len() != 2
                || !["pre-commit", "pre-push"]
                    .iter()
                    .all(|stage| receipt.hooks.contains_key(*stage))
            {
                continue;
            }
            let Some(recorded) = receipt.hooks.get(stage) else {
                continue;
            };
            let same_path = recorded.path == hook
                || matches!((recorded.path.canonicalize(), hook.canonicalize()), (Ok(a), Ok(b)) if a == b);
            let same_root = hook.parent().is_some_and(|parent| {
            hooks == parent
                || matches!((hooks.canonicalize(), parent.canonicalize()), (Ok(a), Ok(b)) if a == b)
        });
            if same_path
                && same_root
                && recorded
                    .block
                    .starts_with(&format!("# >>> specgit-v2:{stage}:start >>>\n"))
                && recorded
                    .block
                    .ends_with(&format!("# <<< specgit-v2:{stage}:end <<<\n"))
                && recorded
                    .block
                    .contains(&format!("specgit guard --stage {stage}"))
                && current
                    .windows(recorded.block.len())
                    .filter(|part| *part == recorded.block.as_bytes())
                    .count()
                    == 1
            {
                return Ok(Some(owner_root));
            }
        }
    }
    Ok(None)
}

fn owned_elsewhere(hook: &Path, owner: &Path) -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "git_guard",
        &format!(
            "The shared Git hook {} already runs the SpecGit guard; linked worktree {} owns it.",
            hook.display(),
            owner.display()
        ),
        &format!(
            "No hook was changed. Linked worktrees share this hook, so it already checks this worktree once it is initialized. Manage it from {} with specgit guard --install or --uninstall.",
            owner.display()
        ),
    )
}

/// Prepare native guard changes without creating locks, directories, or assets.
pub async fn preview(process: &Process, cwd: &Path, uninstall: bool) -> Result<Value, Diagnostic> {
    install_with_preview(process, cwd, uninstall, true).await
}

pub async fn install(process: &Process, cwd: &Path, uninstall: bool) -> Result<Value, Diagnostic> {
    install_with_preview(process, cwd, uninstall, false).await
}

async fn install_with_preview(
    process: &Process,
    cwd: &Path,
    uninstall: bool,
    dry_run: bool,
) -> Result<Value, Diagnostic> {
    let root = root(process, cwd)
        .await?
        .ok_or_else(|| rejected("Native guard installation requires a Git worktree."))?;
    let serialization = serialization_path(process, &root).await?;
    let _serialization = if dry_run {
        None
    } else {
        Some(AssetStore::lock(
            &serialization,
            std::slice::from_ref(&serialization),
            Duration::from_secs(2),
        )?)
    };
    let shared = config::worktree::shared_setup_guard_private(process, &root).await?;
    let (changes, hook_root, receipt_parent) = plan(process, cwd, uninstall).await?;
    // A transfer from retained shared custody removes exactly that receipt; its
    // fixed custody directory is the only extra root this operation may write.
    let transfer = setup_source(&receipt_parent, &shared)?;
    let mut roots = vec![hook_root.clone(), receipt_parent.clone()];
    if transfer.starts_with(&shared)
        && changes
            .iter()
            .any(|c| c.path == transfer && c.after.is_none())
    {
        roots.push(shared.clone());
    }
    if dry_run {
        for change in &changes {
            assets::safe_path(&change.path)?;
            if !roots.iter().any(|root| change.path.starts_with(root)) {
                return Err(rejected(
                    "A recorded Git-hook path is outside the planned asset roots.",
                ));
            }
        }
        if !AssetStore::pending_at(&receipt_parent.join("assets"))?.is_empty() {
            return Err(rejected(
                "An unfinished guard transaction requires recovery.",
            ));
        }
    }
    let mut dependencies = Vec::new();
    if let Some(change) = changes
        .iter()
        .find(|c| c.path == transfer && c.after.is_none())
    {
        for hook in changes.iter().filter(|c| c.path.starts_with(&hook_root)) {
            dependencies.extend(AssetStore::owned_pair_across_at(&source_stores(&receipt_parent, &shared), &transfer, &change.before, &hook.path, &hook.before, None)?.ok_or_else(|| rejected("The setup guard transfer requires current transaction and permission proof."))?);
        }
    }

    if uninstall {
        // Hooks live in the shared directory, but the receipt is per worktree.
        let consumers: Vec<_> = config::worktree::sibling_hook_consumers(process, &root)
            .await?
            .into_iter()
            .filter(|consumer| config::worktree::shares_hooks(consumer, &hook_root))
            .collect();
        let setup_demand = setup_wants_guard(&receipt_parent, &root)?;
        if !consumers.is_empty() || setup_demand {
            let retained: Vec<_> = changes
                .iter()
                .filter(|c| c.path.starts_with(&hook_root))
                .map(|c| &c.path)
                .collect();
            if dry_run {
                return Ok(json!({
                    "dry_run": true,
                    "prepared": true,
                    "hook_root": hook_root,
                    "changes": [],
                    "retained": {
                        "reason": if setup_demand { "setup_guard_purpose" } else { "shared_initialized_worktree" },
                        "paths": changes.iter().map(|change| &change.path).collect::<Vec<_>>(),
                        "shared_consumers": consumers
                    }
                }));
            }
            return Ok(json!({
                "installed": true,
                "hooks": ["pre-commit", "pre-push"],
                "retained": {
                    "reason": if setup_demand { "setup_guard_purpose" } else { "shared_initialized_worktree" },
                    "paths": retained,
                    "shared_consumers": consumers,
                    "remedy": if setup_demand { "Setup still selects the native Git guard. Uninstall the setup integration first; its borrowed independent guard remains available for explicit guard --uninstall." } else { "Sibling worktrees still rely on these shared hook blocks; the blocks and this worktree's receipt were kept. Retire those worktrees first, then uninstall again." }
                },
                "transaction": null
            }));
        }
    }
    if dry_run {
        guard_dependencies_unchanged(&dependencies)?;
        let planned: Vec<_> = changes.iter().map(|change| json!({
            "path": change.path,
            "operation": if change.unchanged() { "keep" } else if change.after.is_none() { "remove" } else if change.before.bytes.is_none() { "create" } else { "update" }
        })).collect();
        return Ok(json!({
            "dry_run": true,
            "prepared": true,
            "hook_root": hook_root,
            "changes": planned,
            "retained": null
        }));
    }
    let store = AssetStore::lock(
        &receipt_parent.join("assets"),
        &roots,
        Duration::from_secs(2),
    )?;
    let observations: Vec<_> = changes
        .iter()
        .filter(|c| {
            changes
                .iter()
                .any(|c| c.path == transfer && c.after.is_none())
                && c.unchanged()
                && matches!(
                    c.path.file_name().and_then(|n| n.to_str()),
                    Some("pre-commit" | "pre-push")
                )
        })
        .map(|c| c.path.clone())
        .collect();
    guard_dependencies_unchanged(&dependencies)?;
    let applied = store.apply_recording_checked(changes, &observations, |_| {
        guard_dependencies_unchanged(&dependencies)
    })?;
    Ok(json!({
        "installed": !uninstall,
        "hooks": if uninstall { vec![] } else { vec!["pre-commit", "pre-push"] },
        "transaction": applied
    }))
}

fn rejected(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::EvidenceRejected,
        "git_guard",
        message,
        "Select complete Issues with specgit issue on this branch, then retry the Git operation.",
    )
}

fn checkpoint_valid(
    context: &project::Context,
    target: Option<&str>,
) -> Result<selection::Selection, Diagnostic> {
    let selected = selection::read(context)?
        .ok_or_else(|| rejected("No Issue checkpoint is selected for this project and branch."))?;
    if !selected.checkpoint_valid(target) {
        return Err(rejected(
            "The selected checkpoint is incomplete or targets another delivery branch.",
        ));
    }
    Ok(selected)
}

fn zero_oid(value: &str) -> bool {
    [40, 64].contains(&value.len()) && value.bytes().all(|byte| byte == b'0')
}

fn pushed_branches(bytes: &[u8]) -> Result<Vec<String>, Diagnostic> {
    if bytes.len() > 1_048_576 {
        return Err(Diagnostic::input("pre-push input exceeds 1 MiB."));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Diagnostic::input("pre-push input must be UTF-8."))?;
    let mut branches = vec![];
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 4 {
            return Err(Diagnostic::input(
                "pre-push input must contain local-ref local-oid remote-ref remote-oid.",
            ));
        }
        let [local_ref, local_oid, remote_ref, _remote_oid] = fields.as_slice() else {
            unreachable!("the field count was checked")
        };
        if *local_ref == "(delete)" || zero_oid(local_oid) {
            continue;
        }
        if local_ref.starts_with("refs/tags/") && remote_ref.starts_with("refs/tags/") {
            continue;
        }
        let Some(branch) = local_ref.strip_prefix("refs/heads/") else {
            return Err(rejected(
                "A non-branch, non-tag ref update cannot be matched to an Issue checkpoint.",
            ));
        };
        if !remote_ref.starts_with("refs/heads/") {
            return Err(rejected(
                "A local branch may only be guarded when it updates a remote branch ref.",
            ));
        }
        if branch.is_empty() || branch.len() > 1024 {
            return Err(Diagnostic::input("pre-push branch identity is invalid."));
        }
        branches.push(branch.to_owned());
        if branches.len() > 100 {
            return Err(Diagnostic::input(
                "pre-push input contains too many ref updates.",
            ));
        }
    }
    Ok(branches)
}

async fn root(process: &Process, cwd: &Path) -> Result<Option<PathBuf>, Diagnostic> {
    let bytes = match project::git(process, cwd, &["rev-parse", "--show-toplevel"]).await {
        Ok(bytes) => bytes,
        Err(d) if d.code == Code::MissingProject => return Ok(None),
        Err(d) => return Err(d),
    };
    Ok(Some(git_path(bytes, "project root")?))
}

fn git_path(bytes: Vec<u8>, what: &str) -> Result<PathBuf, Diagnostic> {
    let text = String::from_utf8(bytes)
        .map_err(|_| Diagnostic::input(&format!("Git returned a non-UTF-8 {what} path.")))?;
    let path = text
        .strip_suffix('\n')
        .ok_or_else(|| Diagnostic::input(&format!("Git returned an unterminated {what} path.")))?;
    #[cfg(windows)]
    let path = path.strip_suffix('\r').unwrap_or(path);
    Ok(PathBuf::from(path))
}

pub async fn check(
    stage: Stage,
    bytes: &[u8],
    process: &Process,
    cwd: &Path,
) -> Result<(), Diagnostic> {
    let pushed = if matches!(stage, Stage::PrePush) {
        pushed_branches(bytes)?
    } else {
        vec![]
    };
    let Some(root) = root(process, cwd).await? else {
        return Ok(());
    };
    // A missing declaration means "never initialized" only without private state.
    // A lost one fails closed wherever the checkpoint rule would apply.
    let declaration = match config::read(&root)? {
        Some(declaration) => Ok(declaration),
        None => match config::worktree::declaration_lost(process, &root).await? {
            Some(lost) => Err(lost),
            None => return Ok(()),
        },
    };
    if matches!(stage, Stage::PrePush) && pushed.is_empty() {
        return Ok(());
    }
    if matches!(stage, Stage::PreCommit)
        && project::git(process, &root, &["diff", "--cached", "--name-only", "-z"])
            .await?
            .is_empty()
    {
        return Ok(());
    }
    let declaration = declaration?;
    let context = config::resolve(
        process,
        &root,
        declaration.remote.as_deref(),
        declaration.provider,
        None,
    )
    .await?;
    let selected = checkpoint_valid(&context, declaration.target.as_deref())?;
    if matches!(stage, Stage::PrePush) {
        for branch in pushed {
            if branch != selected.branch {
                return Err(rejected(&format!(
                    "Ref refs/heads/{branch} is not covered by the checkpoint for refs/heads/{}.",
                    selected.branch
                )));
            }
        }
    }
    Ok(())
}

fn read_dependency(path: &Path) -> Result<Change, Diagnostic> {
    let snapshot = Snapshot::read(path)?;
    Ok(Change {
        path: path.to_owned(),
        before: snapshot.clone(),
        after: snapshot.bytes,
        permissions: snapshot.permissions,
    })
}
fn valid_block(stage: &str, block: &str) -> bool {
    block.starts_with(&format!("# >>> specgit-v2:{stage}:start >>>\n"))
        && block.ends_with(&format!("# <<< specgit-v2:{stage}:end <<<\n"))
        && block.contains(&format!("specgit guard --stage {stage}"))
}

fn valid_receipt(receipt: &Receipt) -> bool {
    match receipt.version {
        1 => receipt.generation.is_none(),
        2 => receipt
            .generation
            .as_ref()
            .is_some_and(|g| g.len() == 64 && g.bytes().all(|b| b.is_ascii_hexdigit())),
        _ => false,
    }
}
fn new_generation() -> Result<String, Diagnostic> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| Diagnostic::input("Cannot create a native guard ownership generation."))?;
    Ok(crate::assets::hash(&bytes))
}
fn setup_wants_guard(private: &Path, root: &Path) -> Result<bool, Diagnostic> {
    let snapshot = Snapshot::read(&private.join("agent-assets/ownership.json"))?;
    crate::config::worktree::setup_guard_demand(snapshot.bytes.as_deref(), root)
}

#[derive(Clone)]
pub(crate) struct Inventory {
    path: PathBuf,
    entries: Vec<std::ffi::OsString>,
}
impl Inventory {
    fn read(path: PathBuf) -> Result<Self, Diagnostic> {
        let mut entries = Vec::new();
        match std::fs::read_dir(&path) {
            Ok(directory) => {
                for entry in directory.take(1025) {
                    entries.push(
                        entry
                            .map_err(|_| rejected("Git worktree inventory is unreadable."))?
                            .file_name(),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(rejected("Git worktree inventory is unreadable.")),
        }
        if entries.len() > 1024 {
            return Err(rejected(
                "Git worktree inventory exceeds its bounded limit.",
            ));
        }
        entries.sort();
        Ok(Self { path, entries })
    }
    pub(crate) fn verify(&self) -> Result<(), Diagnostic> {
        if Self::read(self.path.clone())?.entries != self.entries {
            return Err(rejected(
                "The Git worktree inventory changed after planning.",
            ));
        }
        Ok(())
    }
}
pub(crate) async fn serialization_path(
    process: &Process,
    root: &Path,
) -> Result<PathBuf, Diagnostic> {
    config::worktree::native_guard_lock(process, root).await
}

fn setup_source(private: &Path, shared: &Path) -> Result<PathBuf, Diagnostic> {
    let local = private.join("setup-guard-hooks.json");
    let common = shared.join("setup-guard-hooks.json");
    let local_exists = Snapshot::read(&local)?.bytes.is_some();
    let common_exists = Snapshot::read(&common)?.bytes.is_some();
    if local_exists && common_exists {
        return Err(rejected(
            "Local and shared setup guard sources both claim these hooks; preserve both histories for reconciliation.",
        ));
    }
    Ok(if common_exists { common } else { local })
}
fn source_stores(private: &Path, shared: &Path) -> [PathBuf; 2] {
    [private.join("assets"), shared.join("assets")]
}

/// An asynchronously discovered native Git plan, merged into setup's transaction.
pub struct SetupPlan {
    pub(crate) serialization: PathBuf,
    pub(crate) inventory: Inventory,
    pub(crate) root: PathBuf,
    pub(crate) enabled: bool,
    pub(crate) changes: Vec<Change>,
    pub(crate) dependencies: Vec<Change>,
    pub(crate) allowed: Vec<PathBuf>,
    pub(crate) evidence: Value,
    pub(crate) transaction_store: Option<PathBuf>,
}
impl SetupPlan {
    pub(crate) fn observations(&self) -> Vec<PathBuf> {
        if !self.changes.iter().any(|c| {
            c.path
                .file_name()
                .is_some_and(|n| n == "setup-guard-hooks.json")
                && !c.unchanged()
                && c.after.is_some()
        }) {
            return vec![];
        }
        self.changes
            .iter()
            .filter(|c| {
                c.unchanged()
                    && matches!(
                        c.path.file_name().and_then(|n| n.to_str()),
                        Some("pre-commit" | "pre-push")
                    )
            })
            .map(|c| c.path.clone())
            .collect()
    }
}
pub async fn setup_plan(
    process: &Process,
    root: &Path,
    enabled: bool,
) -> Result<SetupPlan, Diagnostic> {
    setup_plan_inner(process, root, enabled, !enabled).await
}
pub(crate) async fn retiring_setup_plan(
    process: &Process,
    root: &Path,
) -> Result<SetupPlan, Diagnostic> {
    setup_plan_inner(process, root, false, true).await
}
async fn setup_plan_inner(
    process: &Process,
    root: &Path,
    enabled: bool,
    retiring: bool,
) -> Result<SetupPlan, Diagnostic> {
    let private = config::worktree::private_root(process, root).await?;
    let legacy_pending = AssetStore::pending_at(&private.join("transactions"))?;
    if enabled && !legacy_pending.is_empty() {
        return Err(Diagnostic::new(
            Code::RollbackConflict,
            "git_guard",
            &format!(
                "Unfinished legacy guard transactions require recovery: {}.",
                legacy_pending.join(", ")
            ),
            "Recover the exact legacy guard journal ids before setup migration; no host or Git hooks were changed.",
        ));
    }
    let common = git_path(
        project::git(
            process,
            root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?,
        "common metadata",
    )?;
    let serialization = common.join("specgit-v2/native-guard-lock");
    let inventory = Inventory::read(common.join("worktrees"))?;
    let shared = config::worktree::shared_setup_guard_private(process, root).await?;
    if !AssetStore::pending_at(&shared.join("assets"))?.is_empty() {
        return Err(rejected(
            "An interrupted shared setup guard transaction requires exact-id recovery first.",
        ));
    }
    // Decide ownership and pin dependencies from one set of snapshots. A
    // concurrent owner retirement then invalidates this plan at lock time.
    let local_path = private.join("setup-guard-hooks.json");
    let shared_path = shared.join("setup-guard-hooks.json");
    let independent_path = private.join("guard-hooks.json");
    let local_setup = Snapshot::read(&local_path)?;
    let shared_setup = Snapshot::read(&shared_path)?;
    let independent = Snapshot::read(&independent_path)?;
    if local_setup.bytes.is_some() && shared_setup.bytes.is_some() {
        return Err(rejected(
            "Local and shared setup guard sources both claim these hooks; preserve both histories for reconciliation.",
        ));
    }
    let (own, existing) = if shared_setup.bytes.is_some() {
        (shared_path.clone(), shared_setup.clone())
    } else {
        (local_path.clone(), local_setup.clone())
    };
    if existing.bytes.is_some() && independent.bytes.is_some() {
        return Err(rejected(
            "Independent and setup guard sources both claim this worktree; preserve both receipts and reconcile the recorded transaction before setup.",
        ));
    }
    let pinned = |path: &Path, snapshot: &Snapshot| Change {
        path: path.to_owned(),
        before: snapshot.clone(),
        after: snapshot.bytes.clone(),
        permissions: snapshot.permissions.clone(),
    };
    let mut dependencies = vec![
        pinned(&local_path, &local_setup),
        pinned(&shared_path, &shared_setup),
        pinned(&independent_path, &independent),
    ];
    let hooks = config::worktree::hooks(process, root).await?;
    if !enabled && existing.bytes.is_none() {
        return Ok(SetupPlan {
            transaction_store: None,
            serialization,
            inventory,
            root: root.to_owned(),
            enabled,
            changes: vec![],
            dependencies,
            allowed: vec![hooks],
            evidence: json!({"selected":false,"ownership":"none"}),
        });
    }
    // Pin every currently participating Git configuration origin. These are read
    // dependencies, not writable asset roots.
    for path in [
        common.join("config"),
        private.parent().unwrap_or(&private).join("config.worktree"),
        root.join(".git"),
    ] {
        if !path.is_dir() {
            dependencies.push(read_dependency(&path)?);
        }
    }
    let origins = project::git(process, root, &["config", "--list", "--show-origin", "-z"]).await?;
    for field in origins.split(|b| *b == 0) {
        if let Some(file) = field.strip_prefix(b"file:") {
            let file = PathBuf::from(String::from_utf8_lossy(file).into_owned());
            let path = if file.is_absolute() {
                file
            } else {
                root.join(file)
            };
            if !dependencies.iter().any(|c| c.path == path) {
                let snapshot = Snapshot::read(&path)?;
                dependencies.push(Change {
                    path,
                    before: snapshot.clone(),
                    after: snapshot.bytes,
                    permissions: snapshot.permissions,
                });
            }
        }
    }
    for sibling in config::worktree::siblings(process, root).await? {
        dependencies.push(read_dependency(&sibling.root.join(".specgit.yaml"))?);
        for name in config::worktree::RECEIPT_MARKERS {
            dependencies.push(read_dependency(&sibling.private_root.join(name))?);
        }
    }
    // Independent installations are only borrowed, never rewritten by setup.
    if existing.bytes.is_none()
        && let Some(owner_root) = owner(process, root, &hooks.join("pre-commit")).await?
    {
        let owner_private = config::worktree::private_root(process, &owner_root).await?;
        let independent = owner_private.join("guard-hooks.json");
        let receipt = if Snapshot::read(&independent)?.bytes.is_some() {
            independent
        } else {
            owner_private.join("setup-guard-hooks.json")
        };
        let snapshot = Snapshot::read(&receipt)?;
        let value: Receipt = serde_json::from_value(crate::input::json(
            snapshot
                .bytes
                .as_deref()
                .ok_or_else(|| rejected("The guard owner disappeared."))?,
            1_048_576,
            16,
        )?)
        .map_err(|_| rejected("The guard owner receipt is malformed."))?;
        if !valid_receipt(&value) {
            return Err(rejected("The guard owner receipt is unsupported."));
        }
        for stage in ["pre-commit", "pre-push"] {
            let expected = value
                .hooks
                .get(stage)
                .ok_or_else(|| rejected("The guard owner inventory is incomplete."))?;
            let current = Snapshot::read(&hooks.join(stage))?;
            let text = std::str::from_utf8(current.bytes.as_deref().unwrap_or_default())
                .map_err(|_| rejected("The borrowed guard is not UTF-8."))?;
            let shell = text.lines().next().unwrap_or_default();
            if expected.path != hooks.join(stage)
                || !valid_block(stage, &expected.block)
                || text.matches(&expected.block).count() != 1
                || !shell.starts_with("#!")
                || !["sh", "bash", "zsh"]
                    .iter()
                    .any(|name| shell.contains(name))
            {
                return Err(rejected("The borrowed guard is changed or incomplete."));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if current
                    .permissions
                    .as_ref()
                    .is_none_or(|p| p.mode() & 0o111 == 0)
                {
                    return Err(rejected("The borrowed guard is not executable."));
                }
            }
            dependencies.push(Change {
                path: hooks.join(stage),
                before: current.clone(),
                after: current.bytes,
                permissions: current.permissions,
            });
        }
        dependencies.push(Change {
            path: receipt,
            before: snapshot.clone(),
            after: snapshot.bytes,
            permissions: snapshot.permissions,
        });
        return Ok(SetupPlan {
            transaction_store: None,
            serialization,
            inventory,
            root: root.to_owned(),
            enabled,
            changes: vec![],
            dependencies,
            allowed: vec![hooks],
            evidence: json!({"selected":true,"ownership":"borrowed","owner":owner_root}),
        });
    }
    let consumers = config::worktree::sibling_hook_consumers(process, root).await?;
    if !enabled
        && consumers
            .iter()
            .any(|c| config::worktree::shares_hooks(c, &hooks))
    {
        let (current, _, _) = plan_named(process, root, false, "setup-guard-hooks.json").await?;
        for change in current.iter().filter(|c| c.path != own) {
            dependencies.extend(
                AssetStore::owned_pair_across_at(
                    &source_stores(&private, &shared),
                    &own,
                    &existing,
                    &change.path,
                    &change.before,
                    None,
                )?
                .ok_or_else(|| {
                    rejected("The retained shared guard ownership or permissions cannot be proved.")
                })?,
            );
        }
        if retiring && !own.starts_with(&shared) {
            let shared_receipt = shared.join("setup-guard-hooks.json");
            let mut changes = current;
            let recorded = changes.iter_mut().find(|c| c.path == own).ok_or_else(|| {
                rejected("The retiring setup guard receipt is missing from its plan.")
            })?;
            let mut receipt: Receipt = serde_json::from_slice(
                recorded
                    .after
                    .as_deref()
                    .ok_or_else(|| rejected("The retiring guard has no source postimage."))?,
            )
            .map_err(|_| rejected("The retiring guard source is malformed."))?;
            receipt.version = 2;
            // Derive a distinct custody identity from the already proven source
            // identity and target contents. Preview, apply and lock-time replan
            // must name the same generation without writing preview state.
            let mut identity = serde_json::to_vec(&receipt)
                .map_err(|_| rejected("The custody identity cannot be represented."))?;
            identity.extend_from_slice(shared.as_os_str().as_encoded_bytes());
            identity.extend_from_slice(b"specgit-shared-custody-v1");
            receipt.generation = Some(crate::assets::hash(&identity));
            *recorded = Change::new(
                shared_receipt,
                Some(
                    serde_json::to_vec_pretty(&receipt)
                        .map_err(|_| rejected("The shared guard source cannot be represented."))?,
                ),
            )?;
            changes.push(Change::new(own.clone(), None)?);
            dependencies.retain(|d| !changes.iter().any(|c| c.path == d.path && !c.unchanged()));
            return Ok(SetupPlan {
                serialization,
                inventory,
                root: root.to_owned(),
                enabled,
                changes,
                dependencies,
                allowed: vec![hooks, private, shared.clone()],
                evidence: json!({"selected":false,"ownership":"shared_custody","retained":"shared_worktree"}),
                transaction_store: Some(shared.join("assets")),
            });
        }
        for stage in ["pre-commit", "pre-push"] {
            dependencies.push(read_dependency(&hooks.join(stage))?);
        }
        return Ok(SetupPlan {
            transaction_store: None,
            serialization,
            inventory,
            root: root.to_owned(),
            enabled,
            changes: vec![],
            dependencies,
            allowed: vec![hooks],
            evidence: json!({"selected":false,"ownership":"setup","retained":"shared_worktree"}),
        });
    }
    let (changes, hook_root, _) =
        plan_named(process, root, !enabled, "setup-guard-hooks.json").await?;
    if existing.bytes.is_some() {
        for change in changes.iter().filter(|c| c.path != own) {
            let proofs = AssetStore::owned_pair_across_at(
                &source_stores(&private, &shared),
                &own,
                &existing,
                &change.path,
                &change.before,
                None,
            )?
            .ok_or_else(|| {
                rejected("The setup guard ownership or permissions cannot be proved.")
            })?;
            dependencies.extend(proofs);
        }
    }
    dependencies.retain(|d| !changes.iter().any(|c| c.path == d.path && !c.unchanged()));
    Ok(SetupPlan {
        transaction_store: (own.starts_with(&shared) && changes.iter().any(|c| !c.unchanged()))
            .then(|| shared.join("assets")),
        serialization,
        inventory,
        root: root.to_owned(),
        enabled,
        changes,
        dependencies,
        // Git may spell its metadata root differently from a caller's
        // canonical Windows checkout path. Authorize the discovered receipt
        // directory explicitly, alongside the discovered hook directory.
        allowed: vec![hook_root, private, shared],
        evidence: json!({"selected":enabled,"ownership":"setup"}),
    })
}

#[cfg(test)]
mod coordinated_health_tests {
    use super::*;

    #[test]
    fn composite_guard_repair_requires_complete_identical_writes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let hook = Change::new(root.join("pre-commit"), Some(b"canonical hook".to_vec())).unwrap();
        let receipt = Change::new(
            root.join("setup-guard-hooks.json"),
            Some(b"receipt".to_vec()),
        )
        .unwrap();
        let guard = GuardHealthPlan {
            root: root.clone(),
            hook_root: root.clone(),
            receipt_parent: root.clone(),
            changes: vec![hook.clone(), receipt.clone()],
            dependencies: vec![],
        };
        let plan = |changes| {
            assets::MaintenancePlan::new(root.join("assets"), vec![root.clone()], changes, vec![])
        };
        assert!(
            guard
                .covered_by(&plan(vec![hook.clone(), receipt.clone()]))
                .unwrap()
        );
        assert!(!guard.covered_by(&plan(vec![])).unwrap());
        assert!(guard.covered_by(&plan(vec![hook.clone()])).is_err());
        let mut drifted = receipt.clone();
        drifted.before.bytes = Some(b"concurrent receipt".to_vec());
        assert!(
            guard
                .covered_by(&plan(vec![hook.clone(), drifted]))
                .is_err()
        );
        let mut different = receipt;
        different.after = Some(b"different target".to_vec());
        assert!(guard.covered_by(&plan(vec![hook, different])).is_err());
    }
}
