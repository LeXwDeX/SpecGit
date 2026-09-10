use crate::{
    assets::{AssetStore, Change},
    config::{self, Declaration, Language},
    diagnostic::{Code, Diagnostic},
    guidance,
    probe::{self, Capability, ForgeRead},
    process::Process,
    project::{self, Provider},
    report::Report,
    templates,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Default)]
pub struct Options {
    pub remote: Option<String>,
    pub provider: Option<Provider>,
    pub api_host: Option<String>,
    pub target: Option<String>,
    pub language: Option<Language>,
    pub config_file: Option<PathBuf>,
    pub mirror_claude: bool,
    pub native_delete_source: Option<bool>,
    pub inspect_only: bool,
    pub dry_run: bool,
    pub native_auto_merge: Option<bool>,
    pub manual_observe: bool,
    pub rollback: Option<String>,
}
pub use crate::delivery_model::Flow;
pub use crate::delivery_model::flow;
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    let mut language = options.language.unwrap_or_default();
    let mut report = match prepare_and_run(options, process, cwd, &mut language).await {
        Ok(r) => r,
        Err(d) => Report::failure("init", d),
    };
    crate::i18n::report(&mut report, language);
    report
}

async fn prepare_and_run(
    options: Options,
    process: Process,
    cwd: &Path,
    language: &mut Language,
) -> Result<Report, Diagnostic> {
    let bytes = project::git(&process, cwd, &["rev-parse", "--show-toplevel"]).await?;
    let root = PathBuf::from(
        String::from_utf8(bytes)
            .map_err(|_| Diagnostic::input("Invalid Git root."))?
            .trim_end_matches(['\r', '\n']),
    )
    .canonicalize()
    .map_err(|_| Diagnostic::input("Git root is unavailable."))?;
    let git_dir = PathBuf::from(
        String::from_utf8(
            project::git(&process, &root, &["rev-parse", "--absolute-git-dir"]).await?,
        )
        .map_err(|_| Diagnostic::input("Invalid Git directory."))?
        .trim_end_matches(['\r', '\n']),
    );
    if options.native_delete_source.is_some() {
        return Err(Diagnostic::input(
            "Native settings are managed outside SpecGit; inspect and configure them with an authorized native tool.",
        ));
    }
    let private_root = git_dir.join("specgit-v2");
    if let Some(id) = &options.rollback {
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
            &[root.clone(), private_root.clone()],
            Duration::from_secs(2),
        )?;
        return Ok(Report::success(
            "init",
            "rolled_back",
            json!({"transaction":store.rollback(id)?,"remote_state":"not_checked"}),
        ));
    }
    let before = config::snapshot(&root)?;
    let declaration_change = Change {
        path: root.join(".specgit.yaml"),
        permissions: before.permissions.clone(),
        before,
        after: None,
    };
    let existing = declaration_change
        .before
        .bytes
        .as_ref()
        .map(|bytes| Declaration::parse(bytes))
        .transpose()?;
    if existing.is_none() && crate::migration_assets::legacy_present(&root)? {
        return Err(Diagnostic::new(
            Code::MigrationRequired,
            "init",
            "Existing v1 integration must be retired before initializing v2.",
            "Preview specgit migrate --config-file <v2.yaml>; preserve orphaned configuration and old work instead of enabling a competing integration.",
        ));
    }
    let previous = existing.clone().unwrap_or_default();
    let mut declaration = if let Some(path) = &options.config_file {
        Declaration::parse(templates::read_text(path)?.as_bytes())?
    } else {
        previous.clone()
    };
    if let Some(remote) = &options.remote {
        declaration.remote = Some(remote.clone());
    }
    if let Some(provider) = options.provider {
        declaration.provider = Some(provider);
    }
    if let Some(target) = &options.target {
        declaration.target = Some(target.clone());
    }
    if let Some(language) = options.language {
        declaration.language = language;
    }
    if options.manual_observe && options.native_auto_merge == Some(true) {
        return Err(Diagnostic::input(
            "Manual observation conflicts with native auto-merge=true.",
        ));
    }
    if let Some(enabled) = options.native_auto_merge {
        declaration.agent.native_auto_merge = enabled;
    }
    if options.manual_observe {
        declaration.agent.native_auto_merge = false;
    }
    *language = declaration.language;
    declaration.validate()?;
    let context = config::resolve(
        &process,
        &root,
        declaration.remote.as_deref(),
        declaration.provider,
        options.api_host.as_deref(),
    )
    .await?;
    declaration.remote = Some(context.remote.clone());
    // Retain explicit custom-host selection. Standard native hosts remain derivable.
    if declaration.provider.is_none()
        && !matches!(
            context.repository.host.as_str(),
            "github.com" | "gitlab.com"
        )
    {
        declaration.provider = Some(context.repository.provider);
    }
    let candidates = templates::discover(&root)?;
    let values = BTreeMap::new();
    let issue = templates::prepare(
        &root,
        &declaration.templates.issue,
        declaration.language,
        true,
        None,
        &values,
    )?;
    let pr = templates::prepare(
        &root,
        &declaration.templates.pr,
        declaration.language,
        false,
        None,
        &values,
    )?;
    let mut probes = probe::commands(&process, &root, context.repository.provider).await;
    let reader = ForgeRead::new(
        process.clone(),
        &root,
        context.repository.provider,
        &context.repository.host,
    )?;
    probes.push(probe::account(&reader).await);
    let facts = match reader.project(&context.repository).await {
        Ok(f) => f,
        Err(d) => {
            let mut report = Report::failure("init", d);
            report.evidence = json!({"probes":probes,"written":false,"project":"unknown"});
            return Ok(report);
        }
    };
    if !config::valid_branch(&facts.default_branch) {
        return Err(Diagnostic::new(
            Code::MalformedResponse,
            "init",
            "Native default branch is invalid.",
            "Inspect the project through the authenticated CLI.",
        ));
    }
    let request = crate::forge::capabilities::request_target(&reader, &context, &facts).await?;
    let effective_target = request
        .as_ref()
        .map(|(_, target)| target.as_str())
        .or(declaration.target.as_deref());
    let mut native_flow = flow(&facts, effective_target);
    if request.as_ref().is_some_and(|(_, actual)| {
        declaration
            .target
            .as_ref()
            .is_some_and(|expected| expected != actual)
    }) {
        native_flow
            .warnings
            .push("configured_request_target_mismatch");
    }
    let capabilities =
        crate::forge::capabilities::inspect(&reader, &facts, &native_flow.target).await;
    let manual_choice = options.manual_observe
        || options.native_auto_merge == Some(false)
        || (existing.is_some()
            && !previous.agent.native_auto_merge
            && !declaration.agent.native_auto_merge);
    let confirmation = capabilities.needs_choice() && !manual_choice;
    let failed = probes.iter().any(|p| p.status != Capability::Available);
    let mut evidence = json!({"context":context,"probes":probes,"project":facts,"flow":native_flow,"capabilities":capabilities,"request":request,"templates":{"issue":{"source":issue.source,"required_sections":issue.required_sections},"pr":{"source":pr.source,"required_sections":pr.required_sections},"local_candidates":candidates,"inherited_native_templates":"not_checked"},"declaration":declaration,"written":false,"initial_adoption":existing.is_none()});
    if failed {
        let mut report = Report::success("init", "unknown", evidence);
        report.exit = 3;
        return Ok(report);
    }
    if confirmation {
        let mut report = Report::failure(
            "init",
            Diagnostic::new(
                Code::ConfirmationRequired,
                "native_capabilities",
                "Native capabilities are unsupported or unknown; an explicit operating choice is required.",
                "Choose --manual-observe, or have an authorized administrator configure/verify native support and rerun init --check. No project files were written.",
            ),
        );
        report.status = "confirmation_required".into();
        report.evidence = evidence;
        return Ok(report);
    }
    if options.inspect_only {
        return Ok(Report::success("init", "inspected", evidence));
    }
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
        &[root.clone(), private_root],
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
    if crate::forge::capabilities::request_target(&reader, &current, &fresh).await? != request {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "init_request",
            "The native request target changed during initialization.",
            "Inspect the current request and retry.",
        ));
    }
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
