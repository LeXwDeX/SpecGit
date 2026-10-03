//! Classify supplied init facts without native reads or local writes.
use super::availability;
use crate::{
    config::InitPolicy,
    diagnostic::Diagnostic,
    project::{Context, Repository},
    report::Report,
};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CheckRequirement {
    Required,
    Recommended,
    Optional,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CheckFactStatus {
    Verified,
    NotConfigured,
    Failed,
    Unknown,
    NotChecked,
    NotApplicable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CheckPresentation {
    Pass,
    Hint,
    Warning,
    Blocking,
}

#[derive(Debug, Serialize)]
pub(super) struct InitCheck {
    pub(super) id: &'static str,
    pub(super) requirement: CheckRequirement,
    pub(super) requirement_source: &'static str,
    pub(super) status: CheckFactStatus,
    pub(super) presentation: CheckPresentation,
    pub(super) applies_to: &'static [&'static str],
    pub(super) scope: InitCheckScope,
    pub(super) source: String,
    pub(super) observed_at: Option<u64>,
    pub(super) diagnostic: Option<Diagnostic>,
    pub(super) reason: String,
    pub(super) next_step: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct InitCheckScope {
    repository: Option<Repository>,
    branch: Option<String>,
    commit: Option<String>,
}
impl InitCheckScope {
    pub(super) fn from_context(context: Option<&Context>) -> Self {
        Self {
            repository: context.map(|context| context.repository.clone()),
            branch: context.and_then(|context| context.branch.clone()),
            commit: context.map(|context| context.head.clone()),
        }
    }
}

pub(super) fn append_check_report(
    evidence: &mut Value,
    policy: &InitPolicy,
    scope: InitCheckScope,
) {
    let checks = init_checks(evidence, policy, &scope);
    evidence["checks"] =
        serde_json::to_value(&checks).expect("typed initialization checks serialize");
    evidence["operation_assessments"] = json!({
        "scope": "reported_checks_only",
        "note": "These assessments cover only the listed init checks; they do not establish write authorization, complete CI readiness, or delivery completion.",
        "operations": availability::operation_assessments(&checks),
    });
    evidence["availability"] =
        serde_json::to_value(availability::availability_report(&checks, evidence))
            .expect("typed initialization availability serializes");
}

pub(super) fn failure_report_with_checks(
    diagnostic: Diagnostic,
    mut evidence: Value,
    policy: &InitPolicy,
    scope: InitCheckScope,
) -> Report {
    if evidence["project"] == "unknown" {
        evidence["project_diagnostic"] = json!(diagnostic);
    }
    if evidence["request_read"] == "failed" {
        evidence["request_diagnostic"] = json!(diagnostic);
    }
    append_check_report(&mut evidence, policy, scope);
    let mut report = Report::failure("init", diagnostic);
    report.evidence = evidence;
    report
}

fn init_checks(evidence: &Value, policy: &InitPolicy, scope: &InitCheckScope) -> Vec<InitCheck> {
    let probes = evidence["probes"].as_array().cloned().unwrap_or_default();
    let mut checks = vec![
        identity_check(evidence, scope),
        cli_check(&probes, scope),
        account_check(&probes, scope),
    ];
    checks.extend(delivery_checks(scope));
    checks.extend(capability_checks(evidence, scope));
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

fn find_probe<'a>(probes: &'a [Value], operation: &str) -> Option<&'a Value> {
    probes
        .iter()
        .find(|probe| probe["operation"].as_str() == Some(operation))
}

fn identity_check(evidence: &Value, scope: &InitCheckScope) -> InitCheck {
    let project_context = &evidence["context"];
    let has_identity = project_context["repository"]["path"].as_str().is_some()
        && project_context["head"].as_str().is_some()
        && evidence["project"]["id"].as_u64().is_some_and(|id| id > 0)
        && evidence["project"]["repository"] == project_context["repository"];
    InitCheck {
        id: "project.identity",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: if has_identity {
            CheckFactStatus::Verified
        } else {
            CheckFactStatus::Unknown
        },
        presentation: if has_identity {
            CheckPresentation::Pass
        } else {
            CheckPresentation::Blocking
        },
        applies_to: &["local_development", "issue_inspection", "request_delivery"],
        scope: scope.clone(),
        source: "resolved Git root, remote, forge project identity, branch and HEAD".into(),
        observed_at: Some(crate::probe::now()),
        diagnostic: serde_json::from_value(evidence["project_diagnostic"].clone()).ok(),
        reason: if has_identity {
            "The repository and current revision were resolved; native project identity was matched.".into()
        } else {
            "The repository and current revision could not both be verified.".into()
        },
        next_step: if has_identity {
            "Use this repository and revision as the scope for subsequent checks.".into()
        } else {
            "Resolve the intended Git repository and forge project, then rerun init --inspect."
                .into()
        },
    }
}

fn cli_check(probes: &[Value], scope: &InitCheckScope) -> InitCheck {
    let cli_probe = ["gh_version", "gh", "glab_version", "glab"]
        .into_iter()
        .find_map(|operation| find_probe(probes, operation));
    let cli_available = cli_probe.is_some_and(|probe| probe["status"] == "available");
    let cli_status = cli_probe.and_then(|probe| probe["status"].as_str());
    InitCheck {
        id: "forge.cli",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: if cli_available {
            CheckFactStatus::Verified
        } else if cli_status == Some("unavailable") || cli_status == Some("forbidden") {
            CheckFactStatus::Failed
        } else {
            CheckFactStatus::Unknown
        },
        presentation: if cli_available {
            CheckPresentation::Pass
        } else {
            CheckPresentation::Blocking
        },
        applies_to: &["issue_inspection", "issue_creation", "request_delivery"],
        scope: scope.clone(),
        source: cli_probe
            .and_then(|probe| probe["operation"].as_str())
            .unwrap_or("native forge CLI version probe")
            .into(),
        observed_at: cli_probe.and_then(|probe| probe["observed_at"].as_u64()),
        diagnostic: None,
        reason: if cli_available {
            "The native forge CLI is installed and responds to its version probe.".into()
        } else {
            format!(
                "The native forge CLI probe status is {}.",
                cli_status.unwrap_or("not_checked")
            )
        },
        next_step: if cli_available {
            "Use the installed native CLI for the applicable read or write under existing authorization.".into()
        } else {
            "Install or repair the matching forge CLI, then rerun init --inspect.".into()
        },
    }
}

fn account_check(probes: &[Value], scope: &InitCheckScope) -> InitCheck {
    let account = find_probe(probes, "account_api");
    let account_available = account.is_some_and(|probe| probe["status"] == "available");
    let account_status = account.map(|probe| probe["status"].as_str().unwrap_or("unknown"));
    let account_observed_at = account.and_then(|probe| probe["observed_at"].as_u64());
    let account_diagnostic = account
        .and_then(|probe| probe.get("diagnostic"))
        .and_then(|value| serde_json::from_value::<Diagnostic>(value.clone()).ok());
    let account_failed =
        account_status.is_some_and(|status| matches!(status, "forbidden" | "unavailable"));
    InitCheck {
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
        presentation: if account_available {
            CheckPresentation::Pass
        } else {
            CheckPresentation::Blocking
        },
        applies_to: &["issue_inspection", "issue_creation", "request_delivery"],
        scope: scope.clone(),
        source: "authenticated forge account API read".into(),
        observed_at: account_observed_at,
        diagnostic: account_diagnostic.clone(),
        reason: if account_available {
            "The authenticated account endpoint was readable; native write permissions were not checked.".into()
        } else if let Some(diagnostic) = account_diagnostic.as_ref() {
            diagnostic.message.clone()
        } else {
            format!(
                "The authenticated account read is {status}; no write permission is inferred.",
                status = account_status.unwrap_or("not_checked")
            )
        },
        next_step: if account_available {
            "Run the relevant native read or write command under existing authorization.".into()
        } else if let Some(diagnostic) = account_diagnostic.as_ref() {
            diagnostic.remedy.clone()
        } else {
            "Restore authenticated read access, then rerun init --inspect.".into()
        },
    }
}

fn delivery_checks(scope: &InitCheckScope) -> Vec<InitCheck> {
    vec![
    InitCheck {
        id: "issue.duplicate_read",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: CheckFactStatus::NotChecked,
        presentation: CheckPresentation::Blocking,
        applies_to: &["issue_selection", "issue_creation"],
        scope: scope.clone(),
        source: "not probed by init; specgit issue --inspect performs the bounded duplicate read"
            .into(),
        observed_at: None,
        diagnostic: None,
        reason:
            "Initialization does not enumerate Issues, so duplicate status is not established here."
                .into(),
        next_step: "Run specgit issue --inspect before selecting or creating an Issue.".into(),
    },
    InitCheck {
        id: "issue.write_permission",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: CheckFactStatus::NotChecked,
        presentation: CheckPresentation::Hint,
        applies_to: &["issue_creation"],
        scope: scope.clone(),
        source: "not checked; init never performs a write probe".into(),
        observed_at: None,
        diagnostic: None,
        reason: "Readable account identity does not prove Issue creation permission.".into(),
        next_step: "Create or adopt an Issue only under existing authorization; reconcile an uncertain result by native readback.".into(),
    },
    InitCheck {
        id: "request.write_permission",
        requirement: CheckRequirement::Required,
        requirement_source: "builtin",
        status: CheckFactStatus::NotChecked,
        presentation: CheckPresentation::Hint,
        applies_to: &["request_delivery"],
        scope: scope.clone(),
        source: "not checked; init never performs a request write probe".into(),
        observed_at: None,
        diagnostic: None,
        reason: "Readable account identity does not prove request creation or update permission.".into(),
        next_step: "Create or update a request only under existing authorization; reconcile an uncertain result by native readback.".into(),
    },
    ]
}

fn capability_checks(evidence: &Value, scope: &InitCheckScope) -> Vec<InitCheck> {
    let mut checks = Vec::new();
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
        let status = if id == "request.eligibility"
            && evidence["request_read"] == "verified"
            && evidence["request"].is_null()
        {
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
            scope: scope.clone(),
            source: source.into(),
            observed_at: Some(crate::probe::now()),
            diagnostic: if id == "request.eligibility" {
                serde_json::from_value(evidence["request_diagnostic"].clone()).ok()
            } else {
                None
            },
            reason: format!("{reason} {detail}"),
            next_step: next_step.into(),
        });
    }
    checks
}
