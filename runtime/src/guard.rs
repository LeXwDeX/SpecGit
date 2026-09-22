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

pub async fn install(process: &Process, cwd: &Path, uninstall: bool) -> Result<Value, Diagnostic> {
    let Some(root) = root(process, cwd).await? else {
        return Err(Diagnostic::new(
            Code::MissingProject,
            "git_guard",
            "Git-hook installation requires a working tree.",
            "Run the command from the intended repository.",
        ));
    };
    let git_dir = String::from_utf8(
        project::git(process, &root, &["rev-parse", "--absolute-git-dir"]).await?,
    )
    .map_err(|_| Diagnostic::input("Git returned a non-UTF-8 metadata path."))?;
    let hooks = String::from_utf8(
        project::git(
            process,
            &root,
            &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        )
        .await?,
    )
    .map_err(|_| Diagnostic::input("Git returned a non-UTF-8 hooks path."))?;
    let effective = PathBuf::from(hooks.trim_end_matches(['\r', '\n']));
    let common_dir = String::from_utf8(
        project::git(
            process,
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?,
    )
    .map_err(|_| Diagnostic::input("Git returned a non-UTF-8 common metadata path."))?;
    let common_dir = PathBuf::from(common_dir.trim_end_matches(['\r', '\n']));
    let hook_root = if effective.file_name().is_some_and(|name| name == "_")
        && effective
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == ".husky")
    {
        effective
            .parent()
            .ok_or_else(|| Diagnostic::input("Invalid Husky hooks path."))?
            .to_owned()
    } else {
        effective
    };
    if !hook_root.starts_with(&root) && !hook_root.starts_with(&common_dir) {
        return Err(rejected(
            "The effective Git hooks path is external to this repository and its common Git directory.",
        ));
    }
    assets::safe_path(&hook_root)?;
    let receipt_path =
        PathBuf::from(git_dir.trim_end_matches(['\r', '\n'])).join("specgit-v2/guard-hooks.json");
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
        .ok_or_else(|| Diagnostic::input("Invalid Git-hook receipt path."))?;
    let store = AssetStore::lock(
        &receipt_parent.join("transactions"),
        &[hook_root, receipt_parent.to_owned()],
        Duration::from_secs(2),
    )?;
    let applied = store.apply(changes)?;
    Ok(json!({
        "installed": !uninstall,
        "hooks": receipt.map(|receipt| receipt.hooks.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
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
    if selected.issues.is_empty()
        || !selected.issues.iter().all(|issue| {
            selected
                .intents
                .iter()
                .any(|intent| intent.issue == Some(*issue))
        })
        || target.is_some_and(|target| target != selected.target)
    {
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
    let value = String::from_utf8(bytes)
        .map_err(|_| Diagnostic::input("Git returned a non-UTF-8 project root."))?;
    Ok(Some(PathBuf::from(value.trim_end_matches(['\r', '\n']))))
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
    let declaration = match config::read(&root)? {
        Some(declaration) => declaration,
        None => return Ok(()),
    };
    if matches!(stage, Stage::PrePush) && pushed.is_empty() {
        return Ok(());
    }
    if matches!(stage, Stage::PreCommit)
        && project::git(
            process,
            &root,
            &[
                "diff",
                "--cached",
                "--name-only",
                "-z",
                "--diff-filter=ACMR",
            ],
        )
        .await?
        .is_empty()
    {
        return Ok(());
    }
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
