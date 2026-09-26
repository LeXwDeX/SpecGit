use crate::{
    assets::{AssetStore, Change},
    config::{self, Declaration, InitPolicy, Language},
    diagnostic::{Code, Diagnostic},
    guidance,
    probe::{self, Capability, ForgeRead},
    process::Process,
    project::{self, Provider},
    report::Report,
    templates,
};
use serde::Serialize;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckRequirement {
    Required,
    Recommended,
    Optional,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckFactStatus {
    Verified,
    NotConfigured,
    Failed,
    Unknown,
    NotChecked,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckPresentation {
    Pass,
    Hint,
    Warning,
    Blocking,
}

#[derive(Debug, Serialize)]
struct InitCheck {
    id: &'static str,
    requirement: CheckRequirement,
    requirement_source: &'static str,
    status: CheckFactStatus,
    presentation: CheckPresentation,
    applies_to: &'static [&'static str],
    source: String,
    observed_at: Option<u64>,
    diagnostic: Option<Diagnostic>,
    reason: String,
    next_step: String,
}

#[derive(Serialize)]
struct OperationAssessment {
    operation: &'static str,
    assessment: &'static str,
    relevant_checks: Vec<&'static str>,
    blocked_by: Vec<&'static str>,
    unverified_by: Vec<&'static str>,
    warnings: Vec<&'static str>,
}

const INIT_OPERATIONS: &[&str] = &[
    "local_diagnostics",
    "local_development",
    "issue_inspection",
    "issue_selection",
    "issue_creation",
    "request_delivery",
    "protected_delivery",
    "request_merge",
    "merge_closure",
];

fn operation_assessments(checks: &[InitCheck]) -> Vec<OperationAssessment> {
    INIT_OPERATIONS
        .iter()
        .map(|&operation| {
            let relevant: Vec<_> = checks
                .iter()
                .filter(|check| check.applies_to.contains(&operation))
                .collect();
            let blocked_by: Vec<_> = relevant
                .iter()
                .filter(|check| {
                    check.requirement == CheckRequirement::Required
                        && matches!(check.presentation, CheckPresentation::Blocking)
                })
                .map(|check| check.id)
                .collect();
            let unverified_by: Vec<_> = relevant
                .iter()
                .filter(|check| {
                    check.requirement == CheckRequirement::Required
                        && check.presentation != CheckPresentation::Blocking
                        && matches!(
                            check.status,
                            CheckFactStatus::Unknown | CheckFactStatus::NotChecked
                        )
                })
                .map(|check| check.id)
                .collect();
            let warnings: Vec<_> = relevant
                .iter()
                .filter(|check| {
                    check.requirement == CheckRequirement::Recommended
                        && check.presentation == CheckPresentation::Warning
                })
                .map(|check| check.id)
                .collect();
            let assessment = if !blocked_by.is_empty() {
                "blocked"
            } else if !unverified_by.is_empty() {
                "unverified"
            } else {
                "no_reported_blocker"
            };
            OperationAssessment {
                operation,
                assessment,
                relevant_checks: relevant.iter().map(|check| check.id).collect(),
                blocked_by,
                unverified_by,
                warnings,
            }
        })
        .collect()
}

fn append_check_report(evidence: &mut Value, policy: &InitPolicy) {
    let checks = init_checks(evidence, policy);
    evidence["checks"] =
        serde_json::to_value(&checks).expect("typed initialization checks serialize");
    evidence["operation_assessments"] = json!({
        "scope": "reported_checks_only",
        "note": "These assessments cover only the listed init checks; they do not establish write authorization, complete CI readiness, or delivery completion.",
        "operations": operation_assessments(&checks),
    });
}

fn init_checks(evidence: &Value, policy: &InitPolicy) -> Vec<InitCheck> {
    let mut checks = Vec::new();
    let probes = evidence["probes"].as_array().cloned().unwrap_or_default();
    let find_probe = |operation: &str| {
        probes
            .iter()
            .find(|probe| probe["operation"].as_str() == Some(operation))
    };
    let project_context = &evidence["context"];
    let has_identity = project_context["repository"]["path"].as_str().is_some()
        && project_context["head"].as_str().is_some();
    checks.push(InitCheck {
        id: "project.identity",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: if has_identity { CheckFactStatus::Verified } else { CheckFactStatus::Unknown },
        presentation: if has_identity { CheckPresentation::Pass } else { CheckPresentation::Blocking },
        applies_to: &["local_development", "issue_inspection", "request_delivery"],
        source: "resolved Git root, remote, forge project identity, branch and HEAD".into(),
        observed_at: Some(crate::probe::now()),
        diagnostic: None,
        reason: if has_identity {
            "The repository and current revision were resolved; native project identity was matched.".into()
        } else {
            "The repository and current revision could not both be verified.".into()
        },
        next_step: if has_identity {
            "Use this repository and revision as the scope for subsequent checks.".into()
        } else {
            "Resolve the intended Git repository and forge project, then rerun init --inspect.".into()
        },
    });
    let cli_probe = find_probe("gh_version").or_else(|| find_probe("glab_version"));
    let cli_available = cli_probe.is_some_and(|probe| probe["status"] == "available");
    let cli_status = cli_probe.and_then(|probe| probe["status"].as_str());
    checks.push(InitCheck {
        id: "forge.cli",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: if cli_available { CheckFactStatus::Verified } else if cli_status == Some("unavailable") || cli_status == Some("forbidden") { CheckFactStatus::Failed } else { CheckFactStatus::Unknown },
        presentation: if cli_available { CheckPresentation::Pass } else { CheckPresentation::Blocking },
        applies_to: &["issue_inspection", "issue_creation", "request_delivery"],
        source: cli_probe.and_then(|probe| probe["operation"].as_str()).unwrap_or("native forge CLI version probe").into(),
        observed_at: cli_probe.and_then(|probe| probe["observed_at"].as_u64()),
        diagnostic: None,
        reason: if cli_available { "The native forge CLI is installed and responds to its version probe.".into() } else { format!("The native forge CLI probe status is {}.", cli_status.unwrap_or("not_checked")) },
        next_step: if cli_available { "Use the installed native CLI for the applicable read or write under existing authorization.".into() } else { "Install or repair the matching forge CLI, then rerun init --inspect.".into() },
    });
    let account = find_probe("account_api");
    let account_available = account.is_some_and(|probe| probe["status"] == "available");
    let account_status = account.map(|probe| probe["status"].as_str().unwrap_or("unknown"));
    let account_observed_at = account.and_then(|probe| probe["observed_at"].as_u64());
    let account_diagnostic = account
        .and_then(|probe| probe.get("diagnostic"))
        .and_then(|value| serde_json::from_value::<Diagnostic>(value.clone()).ok());
    let account_failed =
        account_status.is_some_and(|status| matches!(status, "forbidden" | "unavailable"));
    checks.push(InitCheck {
        id: "forge.read_access",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: if account_available {
            CheckFactStatus::Verified
        } else if account_failed {
            CheckFactStatus::Failed
        } else {
            CheckFactStatus::Unknown
        },
        presentation: if account_available { CheckPresentation::Pass } else { CheckPresentation::Blocking },
        applies_to: &["issue_inspection", "issue_creation", "request_delivery"],
        source: "authenticated forge account API read".into(),
        observed_at: account_observed_at,
        diagnostic: account_diagnostic.clone(),
        reason: if account_available {
            "The authenticated account endpoint was readable; native write permissions were not checked.".into()
        } else if let Some(diagnostic) = account_diagnostic.as_ref() {
            diagnostic.message.clone()
        } else {
            format!("The authenticated account read is {status}; no write permission is inferred.", status = account_status.unwrap_or("not_checked"))
        },
        next_step: if account_available {
            "Run the relevant native read or write command under existing authorization.".into()
        } else if let Some(diagnostic) = account_diagnostic.as_ref() {
            diagnostic.remedy.clone()
        } else {
            "Restore authenticated read access, then rerun init --inspect.".into()
        },
    });
    checks.push(InitCheck {
        id: "issue.duplicate_read",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: CheckFactStatus::NotChecked,
        presentation: CheckPresentation::Blocking,
        applies_to: &["issue_selection", "issue_creation"],
        source: "not probed by init; specgit issue --inspect performs the bounded duplicate read"
            .into(),
        observed_at: None,
        diagnostic: None,
        reason:
            "Initialization does not enumerate Issues, so duplicate status is not established here."
                .into(),
        next_step: "Run specgit issue --inspect before selecting or creating an Issue.".into(),
    });
    checks.push(InitCheck {
        id: "issue.write_permission",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: CheckFactStatus::NotChecked,
        presentation: CheckPresentation::Hint,
        applies_to: &["issue_creation"],
        source: "not checked; init never performs a write probe".into(),
        observed_at: None,
        diagnostic: None,
        reason: "Readable account identity does not prove Issue creation permission.".into(),
        next_step: "Create or adopt an Issue only under existing authorization; reconcile an uncertain result by native readback.".into(),
    });
    checks.push(InitCheck {
        id: "request.write_permission",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: CheckFactStatus::NotChecked,
        presentation: CheckPresentation::Hint,
        applies_to: &["request_delivery"],
        source: "not checked; init never performs a request write probe".into(),
        observed_at: None,
        diagnostic: None,
        reason: "Readable account identity does not prove request creation or update permission.".into(),
        next_step: "Create or update a request only under existing authorization; reconcile an uncertain result by native readback.".into(),
    });
    let capabilities = &evidence["capabilities"];
    for (id, key, stages, requirement, detail) in [
        (
            "target.protection",
            "target_protection",
            &["protected_delivery"],
            CheckRequirement::Recommended,
            "Readable target protection is only a partial platform fact; the forge decides applicable rules.",
        ),
        (
            "issue.closing",
            "issue_closing",
            &["merge_closure"],
            CheckRequirement::Required,
            "Issue-closing capability does not prove the selected request will close its linked Issues.",
        ),
        (
            "request.eligibility",
            "request_eligibility",
            &["request_merge"],
            CheckRequirement::Optional,
            "Request eligibility is per-request and cannot be inferred from repository settings.",
        ),
        (
            "auto_merge.setting",
            "auto_merge",
            &["request_merge"],
            CheckRequirement::Optional,
            "The repository auto-merge setting is a preference capability, not authorization or per-request eligibility.",
        ),
    ] {
        let capability = &capabilities[key];
        let native_status = capability["status"].as_str().unwrap_or("unknown");
        let status = if id == "request.eligibility" && evidence["request"].is_null() {
            CheckFactStatus::NotApplicable
        } else {
            match native_status {
                "supported" => CheckFactStatus::Verified,
                "unsupported" => CheckFactStatus::NotConfigured,
                _ => CheckFactStatus::Unknown,
            }
        };
        let presentation = match (requirement, status) {
            (_, CheckFactStatus::Verified) => CheckPresentation::Pass,
            (
                CheckRequirement::Required,
                CheckFactStatus::NotConfigured | CheckFactStatus::Unknown,
            ) => CheckPresentation::Blocking,
            (
                CheckRequirement::Recommended,
                CheckFactStatus::NotConfigured | CheckFactStatus::Unknown,
            ) => CheckPresentation::Warning,
            _ => CheckPresentation::Hint,
        };
        let reason = capability["reason"].as_str().unwrap_or(detail);
        let source = capability["source"]
            .as_str()
            .unwrap_or("native capability inspection");
        let fallback_step = if id == "issue.closing" && native_status == "unsupported" {
            "Choose the native default branch for closing references or select manual observation; read back every Issue after merge."
        } else {
            match status {
                CheckFactStatus::Verified => {
                    "Continue to the applicable operation and re-read its current native state."
                }
                CheckFactStatus::NotConfigured => {
                    "Ask an authorized administrator to configure the platform, or use the supported manual path."
                }
                _ => {
                    "Treat this fact as unknown; inspect through an authorized native tool or use the applicable manual path."
                }
            }
        };
        let next_step = capability["diagnostic"]["remedy"]
            .as_str()
            .unwrap_or(fallback_step);
        checks.push(InitCheck {
            id,
            requirement,
            requirement_source: "builtin",
            status,
            presentation,
            applies_to: stages,
            source: source.into(),
            observed_at: Some(crate::probe::now()),
            diagnostic: None,
            reason: format!("{reason} {detail}"),
            next_step: next_step.into(),
        });
    }
    for check in &mut checks {
        if check.requirement != CheckRequirement::Required
            && policy.required_checks.iter().any(|id| id == check.id)
        {
            check.requirement = CheckRequirement::Required;
            check.requirement_source = "project_declaration";
            check.presentation = match check.status {
                CheckFactStatus::Verified => CheckPresentation::Pass,
                CheckFactStatus::NotApplicable => CheckPresentation::Hint,
                _ => CheckPresentation::Blocking,
            };
        }
    }
    checks
}

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
    let exclude = crate::local_exclude::path(&process, &root).await?;
    let exclude_parent = exclude
        .parent()
        .ok_or_else(|| Diagnostic::input("Invalid exclude parent."))?
        .to_owned();
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
            &[root.clone(), private_root.clone(), exclude_parent.clone()],
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
            report.evidence =
                json!({"probes":probes,"written":false,"project":"unknown","request":null});
            append_check_report(&mut report.evidence, &declaration.init_policy);
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
    if options.inspect_only {
        append_check_report(&mut evidence, &declaration.init_policy);
    }
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
