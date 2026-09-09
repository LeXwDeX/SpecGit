use crate::{
    assets::{AssetStore, Change},
    config::{self, Declaration, Language},
    diagnostic::{Code, Diagnostic},
    guidance, native_settings,
    probe::{self, Capability, ForgeRead, ProjectFacts},
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
    pub rollback: Option<String>,
}
#[derive(Debug, serde::Serialize)]
pub struct Flow {
    pub target: String,
    pub native_default: String,
    pub targets_native_default: bool,
    pub issue_closing: &'static str,
    pub source_cleanup: &'static str,
    pub warnings: Vec<&'static str>,
}
pub fn flow(facts: &ProjectFacts, target: Option<&str>) -> Flow {
    let target = target.unwrap_or(&facts.default_branch).to_owned();
    let default = target == facts.default_branch;
    let mut warnings = vec![];
    if !default {
        warnings.push("non_default_target");
    }
    let issue_closing = if !default {
        "unsupported_target"
    } else {
        match facts.native_issue_closing {
            Some(true) => "enabled_rules_unverified",
            Some(false) => {
                warnings.push("native_issue_closing_disabled");
                "disabled"
            }
            None => {
                warnings.push("native_issue_closing_unknown");
                "unknown"
            }
        }
    };
    let source_cleanup = match facts.native_source_cleanup {
        Some(true) => "enabled_eligibility_unverified",
        Some(false) => {
            warnings.push("native_source_cleanup_disabled");
            "disabled"
        }
        None => {
            warnings.push("native_source_cleanup_unknown");
            "unknown"
        }
    };
    if facts.native_issue_closing == Some(true) {
        warnings.push("native_closing_rules_unverified");
    }
    Flow {
        target,
        native_default: facts.default_branch.clone(),
        targets_native_default: default,
        issue_closing,
        source_cleanup,
        warnings,
    }
}
async fn request_target(
    reader: &ForgeRead,
    context: &project::Context,
    facts: &ProjectFacts,
) -> Result<Option<(u64, String)>, Diagnostic> {
    let Some(branch) = &context.branch else {
        return Ok(None);
    };
    let endpoint = match context.repository.provider {
        Provider::Github => format!(
            "repos/{}/pulls?state=open&head={}",
            context.repository.path,
            probe::encode(&format!(
                "{}:{branch}",
                context.repository.path.split('/').next().unwrap_or("")
            ))
        ),
        Provider::Gitlab => format!(
            "projects/{}/merge_requests?state=opened&scope=all&source_branch={}",
            facts.id,
            probe::encode(branch)
        ),
    };
    let rows = reader.list(&endpoint, None, 10).await?;
    let mut matches = vec![];
    for row in rows {
        let (source_id, source_branch, target_id, target, number) =
            match context.repository.provider {
                Provider::Github => (
                    row.pointer("/head/repo/id").and_then(Value::as_u64),
                    row.pointer("/head/ref").and_then(Value::as_str),
                    row.pointer("/base/repo/id").and_then(Value::as_u64),
                    row.pointer("/base/ref").and_then(Value::as_str),
                    row.get("number").and_then(Value::as_u64),
                ),
                Provider::Gitlab => (
                    row.get("source_project_id").and_then(Value::as_u64),
                    row.get("source_branch").and_then(Value::as_str),
                    row.get("target_project_id").and_then(Value::as_u64),
                    row.get("target_branch").and_then(Value::as_str),
                    row.get("iid").and_then(Value::as_u64),
                ),
            };
        if source_id.is_none() || source_branch.is_none() {
            return Err(Diagnostic::new(
                Code::MalformedResponse,
                "init_request",
                "Request source identity is unavailable.",
                "Inspect the current native requests before initialization.",
            ));
        }
        if source_id != Some(facts.id) || source_branch != Some(branch.as_str()) {
            continue;
        }
        if target_id != Some(facts.id)
            || target.is_none_or(|s| !config::valid_branch(s))
            || number.is_none_or(|n| n == 0)
        {
            return Err(Diagnostic::new(
                Code::IdentityMismatch,
                "init_request",
                "Request target identity is unavailable or different.",
                "Select the intended repository and inspect its native requests.",
            ));
        }
        matches.push((number.unwrap(), target.unwrap().to_owned()));
    }
    if matches.len() > 1 {
        return Err(Diagnostic::new(
            Code::AmbiguousRequest,
            "init_request",
            "Several native requests match this source branch.",
            "Resolve the ambiguous request association before initialization.",
        ));
    }
    Ok(matches.pop())
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    let explicit = options.language;
    let mut report = match prepare_and_run(options, process, cwd).await {
        Ok(r) => r,
        Err(d) => Report::failure("init", d),
    };
    let language = explicit
        .or_else(|| {
            report
                .evidence
                .pointer("/declaration/language")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
        })
        .unwrap_or_default();
    crate::i18n::report(&mut report, language);
    report
}

async fn prepare_and_run(
    options: Options,
    process: Process,
    cwd: &Path,
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
    let private_root = git_dir.join("specgit-v2");
    if let Some(id) = &options.rollback {
        if options.inspect_only
            || options.native_delete_source.is_some()
            || options.config_file.is_some()
            || options.language.is_some()
            || options.target.is_some()
            || options.mirror_claude
            || options.api_host.is_some()
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
    let request = request_target(&reader, &context, &facts).await?;
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
    let failed = probes.iter().any(|p| p.status != Capability::Available);
    let mut evidence = json!({"context":context,"probes":probes,"project":facts,"flow":native_flow,"request":request,"templates":{"issue":{"source":issue.source,"required_sections":issue.required_sections},"pr":{"source":pr.source,"required_sections":pr.required_sections},"local_candidates":candidates,"inherited_native_templates":"not_checked"},"declaration":declaration,"written":false,"initial_adoption":existing.is_none()});
    if failed {
        let mut report = Report::success("init", "unknown", evidence);
        report.exit = 3;
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
    // All local inputs validate before a requested native write is representable.
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
    if request_target(&reader, &current, &fresh).await? != request {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "init_request",
            "The native request target changed during initialization.",
            "Inspect the current request and retry.",
        ));
    }
    if let Some(requested) = options.native_delete_source {
        match native_settings::configure_cleanup(
            &process, &root, &context, &reader, &fresh, requested,
        )
        .await
        {
            Ok(change) => {
                evidence["native_setting_change"] = json!(change);
                let mut after = fresh.clone();
                after.native_source_cleanup = change.observed;
                evidence["project"] = json!(after);
                evidence["flow"] = json!(flow(&after, effective_target));
            }
            Err(d) => {
                let mut report = Report::failure("init", d);
                evidence["native_setting_change"] =
                    json!({"requested":requested,"outcome":"unknown_inspect_native_setting"});
                report.evidence = evidence;
                return Ok(report);
            }
        }
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
