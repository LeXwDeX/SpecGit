//! Native protection/approval reads remain distinct from declared additional checks.
use crate::{
    diagnostic::Diagnostic,
    native_checks::{malformed, number, text},
    native_delivery::{PullRequest, prefix},
    probe::{ForgeRead, encode},
    project::{Provider, Repository},
};
use serde::Serialize;
use serde_json::{Value, json};
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RequiredCheck {
    pub name: String,
    pub app: Option<u64>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Requirements {
    pub checks: Vec<RequiredCheck>,
    pub pipeline_required: bool,
    pub approvals_required: u64,
    pub approvals_satisfied: bool,
    pub mergeable: bool,
    #[serde(skip)]
    pub snapshot: Value,
}
fn add(checks: &mut Vec<RequiredCheck>, name: &str, app: Option<u64>) -> Result<(), Diagnostic> {
    if name.is_empty() || name.len() > 255 {
        return Err(malformed());
    }
    let check = RequiredCheck {
        name: name.into(),
        app,
    };
    if !checks.contains(&check) {
        checks.push(check);
    }
    Ok(())
}
fn count(v: &Value, key: &str) -> Result<u64, Diagnostic> {
    v.get(key).and_then(Value::as_u64).ok_or_else(malformed)
}
pub async fn read(
    reader: &ForgeRead,
    repo: &Repository,
    request: &PullRequest,
    raw: &Value,
) -> Result<Requirements, Diagnostic> {
    let base = prefix(repo);
    let mut checks = vec![];
    if repo.provider == Provider::Github {
        let branch = reader
            .get(&format!("{base}/branches/{}", encode(&request.target)))
            .await?;
        if text(&branch, "name")? != request.target {
            return Err(malformed());
        }
        let protected = branch
            .get("protected")
            .and_then(Value::as_bool)
            .ok_or_else(malformed)?;
        let protection = if protected {
            reader
                .get(&format!(
                    "{base}/branches/{}/protection",
                    encode(&request.target)
                ))
                .await?
        } else {
            Value::Null
        };
        let mut required = 0;
        if protected {
            match protection.get("required_status_checks") {
                Some(Value::Null) => {}
                Some(status) => {
                    for name in status
                        .get("contexts")
                        .and_then(Value::as_array)
                        .ok_or_else(malformed)?
                    {
                        add(&mut checks, name.as_str().ok_or_else(malformed)?, None)?;
                    }
                    for check in status
                        .get("checks")
                        .and_then(Value::as_array)
                        .ok_or_else(malformed)?
                    {
                        let app = match check.get("app_id") {
                            Some(Value::Null) => None,
                            Some(n) => Some(n.as_u64().filter(|n| *n > 0).ok_or_else(malformed)?),
                            None => return Err(malformed()),
                        };
                        add(&mut checks, text(check, "context")?, app)?;
                    }
                }
                None => return Err(malformed()),
            }
            match protection.get("required_pull_request_reviews") {
                Some(Value::Null) => {}
                Some(v) => required = count(v, "required_approving_review_count")?,
                None => return Err(malformed()),
            }
        }
        let rules = reader
            .list(
                &format!("{base}/rules/branches/{}", encode(&request.target)),
                None,
                10,
            )
            .await?;
        for rule in &rules {
            match text(rule, "type")? {
                "required_status_checks" => {
                    for check in rule["parameters"]
                        .get("required_status_checks")
                        .and_then(Value::as_array)
                        .ok_or_else(malformed)?
                    {
                        let app = match check.get("integration_id") {
                            Some(Value::Null) => None,
                            Some(v) => Some(v.as_u64().filter(|n| *n > 0).ok_or_else(malformed)?),
                            None => return Err(malformed()),
                        };
                        add(&mut checks, text(check, "context")?, app)?;
                    }
                }
                "pull_request" => {
                    required = required.max(count(
                        &rule["parameters"],
                        "required_approving_review_count",
                    )?)
                }
                _ => {} // The native mergeability read still enforces non-check rules, including queues and deployments.
            }
        }
        let reviews = reader
            .list(&format!("{base}/pulls/{}/reviews", request.id), None, 10)
            .await?;
        let mut latest = std::collections::BTreeMap::<u64, &Value>::new();
        for review in &reviews {
            let user = number(&review["user"], "id")?;
            let id = number(review, "id")?;
            let state = text(review, "state")?;
            if ![
                "APPROVED",
                "CHANGES_REQUESTED",
                "COMMENTED",
                "DISMISSED",
                "PENDING",
            ]
            .contains(&state)
            {
                return Err(malformed());
            }
            if ["COMMENTED", "PENDING"].contains(&state) {
                continue;
            }
            if latest
                .get(&user)
                .is_none_or(|old| old["id"].as_u64().is_some_and(|n| n < id))
            {
                latest.insert(user, review);
            }
        }
        let mut approvals = 0;
        let mut changes = false;
        for review in latest.values() {
            if text(review, "state")? == "CHANGES_REQUESTED" {
                changes = true;
            }
            if text(review, "state")? == "APPROVED" && text(review, "commit_id")? == request.head {
                approvals += 1;
            }
        }
        let mergeable = raw
            .get("mergeable")
            .and_then(Value::as_bool)
            .ok_or_else(malformed)?;
        let state = text(raw, "mergeable_state")?;
        if ![
            "clean",
            "unstable",
            "blocked",
            "behind",
            "draft",
            "dirty",
            "unknown",
            "has_hooks",
        ]
        .contains(&state)
            || state == "unknown"
        {
            return Err(malformed());
        }
        Ok(Requirements {
            checks,
            pipeline_required: false,
            approvals_required: required,
            approvals_satisfied: !changes && approvals >= required,
            mergeable: mergeable && state == "clean",
            snapshot: json!({"branch":branch,"protection":protection,"rules":rules,"reviews":reviews,"mergeable":mergeable,"mergeable_state":state}),
        })
    } else {
        let project = reader.get(&base).await?;
        if number(&project, "id")? != request.target_project {
            return Err(malformed());
        }
        let pipeline_required = project
            .get("only_allow_merge_if_pipeline_succeeds")
            .and_then(Value::as_bool)
            .ok_or_else(malformed)?;
        let branch = reader
            .get(&format!(
                "{base}/repository/branches/{}",
                encode(&request.target)
            ))
            .await?;
        if text(&branch, "name")? != request.target
            || branch.get("protected").and_then(Value::as_bool).is_none()
        {
            return Err(malformed());
        }
        let protections = reader
            .list(&format!("{base}/protected_branches"), None, 10)
            .await?;
        let approvals = reader
            .get(&format!("{base}/merge_requests/{}/approvals", request.id))
            .await?;
        let required = count(&approvals, "approvals_required")?;
        let left = count(&approvals, "approvals_left")?;
        let state = text(raw, "detailed_merge_status")?;
        if ["unchecked", "checking", "preparing", "approvals_syncing"].contains(&state) {
            return Err(malformed());
        }
        Ok(Requirements {
            checks,
            pipeline_required,
            approvals_required: required,
            approvals_satisfied: left == 0,
            mergeable: state == "mergeable",
            snapshot: json!({"project":{"id":request.target_project,"pipeline_required":pipeline_required},"branch":branch,"protection":protections,"approvals":approvals,"detailed_merge_status":state}),
        })
    }
}
