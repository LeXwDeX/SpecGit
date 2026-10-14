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
    let receipt_path = git_dir.join("specgit-v2/guard-hooks.json");
    let receipt_snapshot = Snapshot::read(&receipt_path)?;
    let previous: Option<Receipt> = receipt_snapshot
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
        receipt.version != 1
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
    let receipt = (!uninstall).then_some(Receipt {
        version: 1,
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

    /// Hold the guard transaction lock while re-reading the effective Git
    /// path, ownership receipt, sibling consumers and hook permissions.
    pub async fn apply(self, process: &Process) -> Result<assets::Applied, Diagnostic> {
        if self.assets().is_empty() {
            return Ok(assets::Applied {
                transaction: String::new(),
                changes: 0,
            });
        }
        let store = AssetStore::lock(
            &self.receipt_parent.join("transactions"),
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
    let pending = AssetStore::pending_at(&private.join("transactions"))?;
    if !pending.is_empty() {
        return Err(Diagnostic::new(
            Code::RollbackConflict,
            "git_guard_health",
            &format!(
                "Unfinished Git guard transaction(s): {}.",
                pending.join(", ")
            ),
            &format!(
                "Preserve and inspect the guard transaction journal under {} for id(s) {}; recover each verified id before using guard or doctor again. This CLI has no guard rollback command.",
                private.join("transactions/transactions").display(),
                pending.join(", ")
            ),
        ));
    }
    let receipt_path = private.join("guard-hooks.json");
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
    if receipt.version != 1 || receipt.hooks.len() != 2 {
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
    let (changes, planned_root, receipt_parent) = plan(process, &root, false).await?;
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
        let consumers = config::worktree::sibling_consumers(process, &root).await?;
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
    for sibling in config::worktree::siblings(process, root).await? {
        let Some(bytes) = Snapshot::read(&sibling.private_root.join("guard-hooks.json"))?.bytes
        else {
            continue;
        };
        // A malformed sibling receipt names no owner; the generic conflict still applies.
        let Some(receipt) = crate::input::json(&bytes, 1_048_576, 16)
            .ok()
            .and_then(|value| serde_json::from_value::<Receipt>(value).ok())
        else {
            continue;
        };
        if receipt.version != 1
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
            sibling.hooks == parent
                || matches!((sibling.hooks.canonicalize(), parent.canonicalize()), (Ok(a), Ok(b)) if a == b)
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
            return Ok(Some(sibling.root));
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

pub async fn install(process: &Process, cwd: &Path, uninstall: bool) -> Result<Value, Diagnostic> {
    let (changes, hook_root, receipt_parent) = plan(process, cwd, uninstall).await?;
    if uninstall && let Some(root) = root(process, cwd).await? {
        // Hooks live in the shared directory, but the receipt is per worktree.
        let consumers: Vec<_> = config::worktree::sibling_consumers(process, &root)
            .await?
            .into_iter()
            .filter(|consumer| config::worktree::shares_hooks(consumer, &hook_root))
            .collect();
        if !consumers.is_empty() {
            let retained: Vec<_> = changes
                .iter()
                .filter(|c| c.path.starts_with(&hook_root))
                .map(|c| &c.path)
                .collect();
            return Ok(json!({
                "installed": true,
                "hooks": ["pre-commit", "pre-push"],
                "retained": {
                    "reason": "shared_initialized_worktree",
                    "paths": retained,
                    "shared_consumers": consumers,
                    "remedy": "Sibling worktrees still rely on these shared hook blocks; the blocks and this worktree's receipt were kept. Retire those worktrees first, then uninstall again."
                },
                "transaction": null
            }));
        }
    }
    let store = AssetStore::lock(
        &receipt_parent.join("transactions"),
        &[hook_root, receipt_parent],
        Duration::from_secs(2),
    )?;
    let applied = store.apply(changes)?;
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
