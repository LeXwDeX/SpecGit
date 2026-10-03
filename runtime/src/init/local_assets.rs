//! Local assets are previewed and committed as recoverable transactions after native revalidation.
use super::Options;
use super::native::Native;
use crate::{
    assets::{AssetStore, Change},
    config::{self, Declaration},
    diagnostic::{Code, Diagnostic},
    guidance,
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
    pub fn rollback(&self, options: &Options, id: &str) -> Result<Report, Diagnostic> {
        let Self {
            root,
            private_root,
            exclude_parent,
            ..
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
        let store = AssetStore::lock(
            &private_root.join("assets"),
            &[root.clone(), private_root.clone(), exclude_parent.clone()],
            Duration::from_secs(2),
        )?;
        Ok(Report::success(
            "init",
            "rolled_back",
            json!({"transaction":store.rollback(id)?,"remote_state":"not_checked"}),
        ))
    }
}

pub(super) struct Plan {
    pub paths: Paths,
    pub declaration_change: Change,
    pub previous: Declaration,
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
        previous,
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
    changes.extend(guidance::changes(
        &root,
        &private_root,
        &previous,
        &declaration,
        options.mirror_claude,
    )?);
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
    let store = AssetStore::lock(
        &context.git_dir.join("specgit-v2/assets"),
        &[root.clone(), private_root, exclude_parent],
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
    let applied = match store.apply(changes) {
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
