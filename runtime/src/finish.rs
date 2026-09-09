//! Read-only acceptance from immutable declarations and fresh native lifecycle evidence.
use crate::{
    config::Declaration,
    delivery_context::Workspace,
    diagnostic::{Code, Diagnostic},
    native_checks::{self, Check},
    native_delivery::{self, PullRequest},
    native_file,
    native_requirements::{self, RequiredCheck},
    process::Process,
    project::Provider,
    report::Report,
    selection, spec,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
#[derive(Debug, clap::Args)]
pub struct Options {
    /// Observe this exact native request; otherwise use the local locator or current source branch.
    #[arg(long)]
    pub request: Option<u64>,
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    match Box::pin(execute(options, process, cwd)).await {
        Ok(report) => report,
        Err(d) => Report::failure("finish", d),
    }
}
fn changed() -> Diagnostic {
    Diagnostic::new(
        Code::ConcurrentEdit,
        "finish",
        "Native head, target, rules or check attempts changed during observation.",
        "Read a fresh complete snapshot before acceptance.",
    )
}
fn reject(reason: &str, evidence: Value) -> Report {
    Report {
        schema_version: 2,
        version: env!("CARGO_PKG_VERSION"),
        operation: "finish".into(),
        status: "rejected".into(),
        exit: 1,
        evidence,
        diagnostics: vec![Diagnostic::new(
            Code::EvidenceRejected,
            "finish",
            reason,
            "Resolve the reported native blockers and obtain fresh evidence.",
        )],
    }
}
async fn checks(w: &Workspace, r: &PullRequest, raw: &Value) -> Result<Vec<Check>, Diagnostic> {
    if w.context.repository.provider == Provider::Github {
        native_checks::github(&w.reader, &w.context.repository, &r.head).await
    } else {
        native_checks::gitlab(&w.reader, raw, &r.head).await
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
async fn execute(options: Options, process: Process, cwd: &Path) -> Result<Report, Diagnostic> {
    if options.request == Some(0) {
        return Err(Diagnostic::input("Request IDs must be positive."));
    }
    let w = Workspace::load(process, cwd).await?;
    let repo = &w.context.repository;
    let selected = selection::read(&w.context)?;
    if selected
        .as_ref()
        .is_some_and(|s| s.project_id != w.facts.id || s.target != w.target)
    {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "finish",
            "The local selection belongs to a different native project or target.",
            "Reconcile the exact native request and current selection before acceptance.",
        ));
    }
    let number = if let Some(n) = options
        .request
        .or(selected.as_ref().and_then(|s| s.request))
    {
        n
    } else {
        let rows = native_delivery::request_candidates(&w.reader, repo, w.branch()?).await?;
        if rows.len() != 1 {
            return Err(Diagnostic::new(
                Code::AmbiguousRequest,
                "finish",
                "Observation requires one exact native request.",
                "Select its exact --request ID after inspecting native candidates.",
            ));
        }
        rows[0].id
    };
    let route = format!(
        "{}/{}/{number}",
        native_delivery::prefix(repo),
        if repo.provider == Provider::Github {
            "pulls"
        } else {
            "merge_requests"
        }
    );
    let raw = w.reader.get(&route).await?;
    let r = native_delivery::request_value(&raw, repo, number)?;
    if r.target_project != w.facts.id
        || r.target != w.target
        || r.source != w.branch()?
        || r.head != w.context.head
    {
        return Ok(reject(
            "Request project/source/head/target differs from the selected worktree.",
            json!({"request":r,"local_head":w.context.head,"target":w.target,"project_id":w.facts.id}),
        ));
    }
    if r.source_project != w.facts.id {
        return Err(Diagnostic::new(
            Code::UnsupportedOperation,
            "finish",
            "Fork source declaration/commit reads require separately verified repository identity.",
            "Use a same-project delivery until the fork observation capability is verified.",
        ));
    }
    let target = native_delivery::branch_head(&w.reader, repo, &r.target).await?;
    let approved = native_file::root_file(&w.reader, repo, &target, ".specgit.yaml").await?;
    let candidate = native_file::root_file(&w.reader, repo, &r.head, ".specgit.yaml").await?;
    let source = candidate.bytes.as_deref().ok_or_else(|| {
        Diagnostic::new(
            Code::MalformedResponse,
            "finish",
            "The current pushed head has no shared v2 declaration.",
            "Commit the shared project declaration before native acceptance.",
        )
    })?;
    let candidate_rules = Declaration::parse(source)?;
    let initial_adoption = approved.bytes.is_none();
    let approved_bytes = approved.bytes.as_deref().unwrap_or(source);
    let rules = Declaration::parse(approved_bytes)?;
    let expected_target = rules.target.as_deref().unwrap_or(&w.facts.default_branch);
    if expected_target != r.target
        || rules.provider.is_some_and(|p| p != repo.provider)
        || candidate_rules.provider.is_some_and(|p| p != repo.provider)
    {
        return Ok(reject(
            "Shared native declaration targets a different branch/provider.",
            json!({"request":r,"approved_target":expected_target}),
        ));
    }
    let ids = match spec::references(&r.body) {
        Ok(ids) if !ids.is_empty() => ids,
        _ => {
            return Ok(reject(
                "Every deliberate native request association must resolve explicitly.",
                json!({"request":r}),
            ));
        }
    };
    if selected.as_ref().is_some_and(|s| {
        s.issues.iter().any(|id| !ids.contains(id)) || s.intents.iter().any(|i| i.issue.is_none())
    }) {
        return Ok(reject(
            "Selected issue intent and native references differ; explicit reconciliation is required.",
            json!({"request":r,"native_issues":ids,"selected_issues":selected.as_ref().map(|s|&s.issues)}),
        ));
    }
    let mut issues = vec![];
    let mut violations = spec::check(&rules, false, &r.title, &r.body, &r.labels);
    for id in ids {
        let issue = native_delivery::issue(&w.reader, repo, w.facts.id, id).await?;
        violations.extend(spec::check(
            &rules,
            true,
            &issue.title,
            &issue.body,
            &issue.labels,
        ));
        issues.push(issue);
    }
    let declaration = json!({"source":if initial_adoption {"initial_adoption"} else {"target_revision"},"target_commit":target,"approved_digest":digest(approved_bytes),"candidate_digest":digest(source),"candidate_changed":source!=approved_bytes,"candidate_rules":candidate_rules});
    // Completion is a native lifecycle fact, independently of later policy changes.
    if r.state == "merged" {
        let branches = w
            .reader
            .list(
                &format!(
                    "{}/{}",
                    native_delivery::prefix(repo),
                    if repo.provider == Provider::Github {
                        "branches"
                    } else {
                        "repository/branches"
                    }
                ),
                None,
                10,
            )
            .await;
        let cleanup = match branches {
            Ok(rows) => {
                let mut names = std::collections::BTreeSet::new();
                for row in &rows {
                    if !names.insert(native_checks::text(row, "name")?.to_owned()) {
                        return Err(native_checks::malformed());
                    }
                }
                if names.contains(&r.source) {
                    "present"
                } else {
                    "deleted"
                }
            }
            Err(_) => "unknown",
        };
        stable(&w, &r, &raw, &route, &target, &issues).await?;
        let completed = issues.iter().all(|i| i.state == "closed");
        let evidence = json!({"request":r,"issues":issues,"declaration":declaration,"spec_violations":violations,"source_cleanup":cleanup,"flow":crate::init::flow(&w.facts,Some(&w.target))});
        return Ok(if completed {
            Report::success("finish", "completed", evidence)
        } else {
            let mut report = reject(
                "Native merge is confirmed but associated issues remain open.",
                evidence,
            );
            report.status = "merged_issues_open".into();
            report
        });
    }
    let requirements = native_requirements::read(&w.reader, repo, &r, &raw).await?;
    let current_checks = checks(&w, &r, &raw).await?;
    let mut required = requirements.checks.clone();
    for name in &rules.verification.required_checks {
        let item = RequiredCheck {
            name: name.clone(),
            app: None,
        };
        if !required.contains(&item) {
            required.push(item);
        }
    }
    let mut blockers = vec![];
    if w.context.dirty {
        blockers.push("local_worktree_dirty".to_owned());
    }
    if r.draft {
        blockers.push("request_draft".to_owned());
    }
    if !["open", "opened"].contains(&r.state.as_str()) {
        blockers.push("request_closed".into());
    }
    if !violations.is_empty() {
        blockers.push("spec_invalid".into());
    }
    if !requirements.approvals_satisfied {
        blockers.push("approvals_unsatisfied".into());
    }
    if !requirements.mergeable {
        blockers.push("native_merge_blocked".into());
    }
    if requirements.pipeline_required && !current_checks.iter().any(|c| c.source == "pipeline") {
        blockers.push("head_pipeline_missing".into());
    }
    for check in &required {
        let matches: Vec<_> = current_checks
            .iter()
            .filter(|c| c.name == check.name && check.app.is_none_or(|app| c.app == Some(app)))
            .collect();
        if matches.is_empty() {
            blockers.push(format!("check_missing:{}", check.name));
        } else if matches.iter().any(|c| !c.successful()) {
            blockers.push(format!("check_not_successful:{}", check.name));
        }
    }
    for check in &current_checks {
        if check.allow_failure {
            continue;
        }
        if check.status != "completed" {
            blockers.push(format!("check_pending:{}", check.name));
        } else if check.failed() {
            blockers.push(format!("check_failed:{}", check.name));
        }
    }
    // Re-observe all check/attempt and protection inputs, not just PR updated_at.
    if checks(&w, &r, &raw).await? != current_checks
        || native_requirements::read(&w.reader, repo, &r, &raw).await? != requirements
    {
        return Err(changed());
    }
    stable(&w, &r, &raw, &route, &target, &issues).await?;
    let evidence = json!({"request":r,"issues":issues,"declaration":declaration,"spec_violations":violations,"requirements":requirements,"required_checks":required,"checks":current_checks,"blockers":blockers,"flow":crate::init::flow(&w.facts,Some(&w.target))});
    Ok(if blockers.is_empty() {
        Report::success(
            "finish",
            if initial_adoption {
                "accepted_initial_adoption"
            } else {
                "accepted"
            },
            evidence,
        )
    } else {
        reject(
            "Current native evidence contains delivery blockers.",
            evidence,
        )
    })
}
async fn stable(
    w: &Workspace,
    r: &PullRequest,
    raw: &Value,
    route: &str,
    target: &str,
    issues: &[native_delivery::Issue],
) -> Result<(), Diagnostic> {
    for issue in issues {
        if native_delivery::issue(&w.reader, &w.context.repository, w.facts.id, issue.id).await?
            != *issue
        {
            return Err(changed());
        }
    }
    if w.reader.get(route).await? != *raw
        || native_delivery::branch_head(&w.reader, &w.context.repository, &r.target).await?
            != target
    {
        return Err(changed());
    }
    w.unchanged().await
}
