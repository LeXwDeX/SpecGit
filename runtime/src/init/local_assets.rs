//! Local assets are previewed and committed as recoverable transactions after native revalidation.
use super::Options;
use super::native::Native;
use crate::{
    assets::{AssetStore, Change},
    config::{self, Declaration},
    diagnostic::{Code, Diagnostic},
    process::Process,
    project::{self, Context},
    report::Report,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) struct Paths {
    pub root: PathBuf,
    pub private_root: PathBuf,
    pub exclude: PathBuf,
    pub exclude_parent: PathBuf,
}
impl Paths {
    pub async fn load(
        options: &Options,
        process: &Process,
        cwd: &Path,
    ) -> Result<Self, Diagnostic> {
        let bytes = project::git(process, cwd, &["rev-parse", "--show-toplevel"]).await?;
        let root = PathBuf::from(
            String::from_utf8(bytes)
                .map_err(|_| Diagnostic::input("Invalid Git root."))?
                .trim_end_matches(['\r', '\n']),
        )
        .canonicalize()
        .map_err(|_| Diagnostic::input("Git root is unavailable."))?;
        let git_dir = PathBuf::from(
            String::from_utf8(
                project::git(process, &root, &["rev-parse", "--absolute-git-dir"]).await?,
            )
            .map_err(|_| Diagnostic::input("Invalid Git directory."))?
            .trim_end_matches(['\r', '\n']),
        );
        if options.native_delete_source.is_some() {
            return Err(Diagnostic::input(
                "Native settings are managed outside SpecGit; inspect and configure them with an authorized native tool.",
            ));
        }
        let exclude = crate::local_exclude::path(process, &root).await?;
        let exclude_parent = exclude
            .parent()
            .ok_or_else(|| Diagnostic::input("Invalid exclude parent."))?
            .to_owned();
        let private_root = git_dir.join("specgit-v2");
        Ok(Self {
            root,
            private_root,
            exclude,
            exclude_parent,
        })
    }
    pub async fn rollback(
        &self,
        options: &Options,
        process: &Process,
        id: &str,
    ) -> Result<Report, Diagnostic> {
        let Self {
            root,
            private_root,
            exclude,
            exclude_parent,
        } = self;
        if options.inspect_only
            || options.remote.is_some()
            || options.provider.is_some()
            || options.native_delete_source.is_some()
            || options.config_file.is_some()
            || options.language.is_some()
            || options.target.is_some()
            || options.mirror_claude
            || options.api_host.is_some()
            || options.native_auto_merge.is_some()
            || options.manual_observe
            || options.dry_run
        {
            return Err(Diagnostic::input(
                "Rollback cannot be combined with initialization changes.",
            ));
        }
        let hook_root = config::worktree::hooks(process, root).await?;
        let serialization = config::worktree::lock_native_guard(process, root).await?;
        let allowed = config::worktree::rollback_allowed_roots(&[
            root.clone(),
            private_root.clone(),
            exclude_parent.clone(),
            hook_root,
        ])?;
        let store = AssetStore::lock(
            &private_root.join("assets"),
            &allowed,
            Duration::from_secs(2),
        )?;
        let (transaction, retained) = config::worktree::rollback_with_lock(
            &serialization,
            &store,
            process,
            root,
            exclude,
            id,
        )
        .await?;
        Ok(Report::success(
            "init",
            "rolled_back",
            json!({"transaction":transaction,"retained":retained,"remote_state":"not_checked"}),
        ))
    }
}

pub(super) struct Plan {
    pub paths: Paths,
    pub declaration_change: Change,
    pub declaration: Declaration,
    pub context: Context,
    pub native: Native,
}

pub(super) async fn apply(
    options: &Options,
    process: Process,
    plan: Plan,
    mut evidence: Value,
) -> Result<Report, Diagnostic> {
    let Plan {
        paths,
        declaration_change,
        declaration,
        context,
        native,
    } = plan;
    let Paths {
        root,
        private_root,
        exclude,
        exclude_parent,
    } = paths;
    let mut declaration_change = declaration_change;
    declaration_change.after = Some(declaration.bytes()?);
    let mut changes = vec![declaration_change];
    let crate::setup::project::Initialization {
        changes: integration,
        observations,
        executable,
        guard_enabled,
    } = crate::setup::project::initialization_changes(
        &root,
        &private_root.join("agent-assets"),
        options.mirror_claude,
    )?;
    changes.extend(integration);
    let guard_plan = crate::guard::setup_plan(&process, &root, guard_enabled).await?;
    changes.extend(guard_plan.changes);
    let native_dependencies = guard_plan.dependencies;
    let native_allowed = guard_plan.allowed;
    let native_inventory = guard_plan.inventory;
    let native_serialization = guard_plan.serialization;
    // Keep init's selection marker without claiming setup's guidance assets.
    let marker_path = private_root.join("guidance.json");
    let marker = Change::new(
        marker_path.clone(),
        Some(
            serde_json::to_vec_pretty(
                &json!({"version":1,"generator":env!("CARGO_PKG_VERSION"),"blocks":{}}),
            )
            .map_err(|_| Diagnostic::input("Initialization marker cannot be represented."))?,
        ),
    )?;
    changes.retain(|c| c.path != marker_path);
    changes.push(marker);
    // Routing is a local asset; no native write capability is available.
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
    evidence["local_exclusion"] =
        crate::local_exclude::plan(&process, &root, &exclude, &mut changes).await?;
    if options.dry_run {
        evidence["planned_paths"] = json!(
            changes
                .iter()
                .map(|change| &change.path)
                .collect::<Vec<_>>()
        );
        return Ok(Report::success("init", "dry_run", evidence));
    }
    let mut allowed = vec![root.clone(), private_root, exclude_parent];
    allowed.extend(native_allowed);
    let _native_lock = AssetStore::lock(
        &native_serialization,
        std::slice::from_ref(&native_serialization),
        Duration::from_secs(2),
    )?;
    native_inventory.verify()?;
    let store = AssetStore::lock(
        &context.git_dir.join("specgit-v2/assets"),
        &allowed,
        Duration::from_secs(2),
    )?;
    let pending = store.pending_transactions()?;
    if !pending.is_empty() {
        return Err(Diagnostic::new(
            Code::RollbackConflict,
            "init",
            "An interrupted asset transaction requires recovery.",
            "Recover the recorded transaction before another project refresh.",
        ));
    }
    unchanged(options, &process, &root, &declaration, &context, &native).await?;
    for change in &changes {
        let current = crate::assets::Snapshot::read(&change.path)?;
        if !(Change {
            path: change.path.clone(),
            before: change.before.clone(),
            after: current.bytes,
            permissions: current.permissions,
        })
        .unchanged()
        {
            return Err(Diagnostic::new(
                Code::ConcurrentEdit,
                "init",
                "A project asset or its permissions changed while acquiring the lock.",
                "Preview initialization again.",
            ));
        }
    }
    if let Some((source, expected)) = executable {
        crate::setup::project::recheck_executable(&root, &source, &expected)?;
    }
    let applied = match store.apply_recording_checked(changes, &observations, |_| {
        crate::setup::project::verify_dependencies(&native_dependencies)
    }) {
        Ok(a) => a,
        Err(d) => {
            let mut report = Report::failure("init", d);
            report.evidence = evidence;
            return Ok(report);
        }
    };
    evidence["written"] = Value::Bool(true);
    evidence["transaction"] = json!(applied);
    Ok(Report::success("init", "initialized", evidence))
}

async fn unchanged(
    options: &Options,
    process: &Process,
    root: &Path,
    declaration: &Declaration,
    context: &Context,
    native: &Native,
) -> Result<(), Diagnostic> {
    let Native {
        reader,
        facts,
        request,
        ..
    } = native;
    let current = config::resolve(
        process,
        root,
        declaration.remote.as_deref(),
        declaration.provider,
        options.api_host.as_deref(),
    )
    .await?;
    if current.head != context.head
        || current.branch != context.branch
        || current.repository != context.repository
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "init",
            "Project identity changed during initialization.",
            "Inspect the new branch and remote before retrying.",
        ));
    }
    let fresh = reader.project(&context.repository).await?;
    if fresh.id != facts.id || fresh.default_branch != facts.default_branch {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "init",
            "Native project identity/default changed during initialization.",
            "Inspect the updated native flow before retrying.",
        ));
    }
    if crate::forge::capabilities::request_target(reader, &current, &fresh).await? != *request {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "init_request",
            "The native request target changed during initialization.",
            "Inspect the current request and retry.",
        ));
    }
    Ok(())
}
