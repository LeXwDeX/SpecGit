//! Bounded native current-head check/status and MR pipeline facts; no CI graph reconstruction.
pub use crate::delivery_model::Check;
use crate::{
    diagnostic::{Code, Diagnostic},
    native_delivery::prefix,
    probe::ForgeRead,
    project::Repository,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
pub fn malformed() -> Diagnostic {
    Diagnostic::new(
        Code::MalformedResponse,
        "checks",
        "Native check evidence is incomplete, stale or ambiguous.",
        "Read the exact current head and complete native result pages; unavailable facts are not successful observations.",
    )
}
pub fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, Diagnostic> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(malformed)
}
pub fn number(v: &Value, key: &str) -> Result<u64, Diagnostic> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(malformed)
}
fn timestamp(v: &Value, key: &str) -> Result<Option<String>, Diagnostic> {
    match v.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() >= 20 && s.as_bytes().get(10) == Some(&b'T') => {
            Ok(Some(s.clone()))
        }
        _ => Err(malformed()),
    }
}
pub async fn counted(reader: &ForgeRead, route: &str, key: &str) -> Result<Vec<Value>, Diagnostic> {
    let mut total = None;
    let mut rows = vec![];
    let mut ids = BTreeSet::new();
    for page in 1..=11 {
        let value = reader
            .get(&format!(
                "{route}{}per_page=100&page={page}",
                if route.contains('?') { '&' } else { '?' }
            ))
            .await?;
        let count = value
            .get("total_count")
            .and_then(Value::as_u64)
            .filter(|n| *n <= 1000)
            .ok_or_else(malformed)?;
        if total.is_some_and(|n| n != count) {
            return Err(malformed());
        }
        total = Some(count);
        let items = value
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(malformed)?;
        if items.len() > 100 {
            return Err(malformed());
        }
        for item in items {
            if !ids.insert(number(item, "id")?) {
                return Err(malformed());
            }
            rows.push(item.clone());
        }
        if items.len() < 100 {
            return if rows.len() as u64 == count {
                Ok(rows)
            } else {
                Err(malformed())
            };
        }
    }
    Err(malformed())
}
fn github_result(v: &Value) -> Result<(String, Option<String>), Diagnostic> {
    let status = text(v, "status")?;
    if ![
        "queued",
        "in_progress",
        "completed",
        "waiting",
        "requested",
        "pending",
    ]
    .contains(&status)
    {
        return Err(malformed());
    }
    let conclusion = match v.get("conclusion") {
        Some(Value::Null) if status != "completed" => None,
        Some(Value::String(s))
            if status == "completed"
                && [
                    "success",
                    "failure",
                    "neutral",
                    "cancelled",
                    "timed_out",
                    "action_required",
                    "stale",
                    "skipped",
                    "startup_failure",
                ]
                .contains(&s.as_str()) =>
        {
            Some(s.clone())
        }
        _ => return Err(malformed()),
    };
    Ok((status.into(), conclusion))
}
fn latest(map: &mut BTreeMap<String, Check>, key: String, check: Check) -> Result<(), Diagnostic> {
    match map.get(&key) {
        Some(old) if old.id == check.id => return Err(malformed()),
        Some(old) if old.id > check.id => {}
        _ => {
            map.insert(key, check);
        }
    }
    Ok(())
}
pub async fn github(
    reader: &ForgeRead,
    repo: &Repository,
    head: &str,
) -> Result<Vec<Check>, Diagnostic> {
    if !crate::project::valid_oid(head) {
        return Err(malformed());
    }
    let base = prefix(repo);
    // The forge selects latest check runs. Do not reconstruct Actions jobs,
    // attempts, suites or cross-workflow ownership from independent API reads.
    let rows = counted(
        reader,
        &format!("{base}/commits/{head}/check-runs?filter=latest"),
        "check_runs",
    )
    .await?;
    let mut checks = Vec::new();
    for row in rows {
        if text(&row, "head_sha")? != head {
            return Err(malformed());
        }
        let (status, conclusion) = github_result(&row)?;
        checks.push(Check {
            name: text(&row, "name")?.into(),
            source: "check".into(),
            head: head.into(),
            id: number(&row, "id")?,
            app: Some(number(&row["app"], "id")?),
            workflow: None,
            workflow_attempt: None,
            pipeline: None,
            project: None,
            status,
            conclusion,
            started_at: timestamp(&row, "started_at")?,
            completed_at: timestamp(&row, "completed_at")?,
            allow_failure: false,
        });
    }
    let statuses = reader
        .list(&format!("{base}/commits/{head}/statuses"), None, 10)
        .await?;
    let mut latest_statuses = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for row in statuses {
        let id = number(&row, "id")?;
        if !ids.insert(id) {
            return Err(malformed());
        }
        let state = text(&row, "state")?;
        if !["pending", "success", "failure", "error"].contains(&state) {
            return Err(malformed());
        }
        let name = text(&row, "context")?.to_owned();
        latest(
            &mut latest_statuses,
            name.clone(),
            Check {
                name,
                source: "status".into(),
                head: head.into(),
                id,
                app: None,
                workflow: None,
                workflow_attempt: None,
                pipeline: None,
                project: None,
                status: if state == "pending" {
                    "in_progress"
                } else {
                    "completed"
                }
                .into(),
                conclusion: (state != "pending").then(|| state.into()),
                started_at: timestamp(&row, "created_at")?,
                completed_at: timestamp(&row, "updated_at")?,
                allow_failure: false,
            },
        )?;
    }
    checks.extend(latest_statuses.into_values());
    Ok(checks)
}
fn gitlab_result(value: &str) -> Result<(String, Option<String>), Diagnostic> {
    Ok(match value {
        "success" => ("completed".into(), Some("success".into())),
        "failed" => ("completed".into(), Some("failure".into())),
        "canceled" => ("completed".into(), Some("cancelled".into())),
        "skipped" => ("completed".into(), Some("skipped".into())),
        "created"
        | "waiting_for_resource"
        | "preparing"
        | "pending"
        | "running"
        | "manual"
        | "scheduled" => (value.into(), None),
        _ => return Err(malformed()),
    })
}
/// Observe the MR's native head_pipeline; the forge owns downstream aggregation.
pub async fn gitlab(
    reader: &ForgeRead,
    request: &Value,
    head: &str,
) -> Result<Vec<Check>, Diagnostic> {
    if !crate::project::valid_oid(head) || text(request, "sha")? != head {
        return Err(malformed());
    }
    let pointer = request.get("head_pipeline").ok_or_else(malformed)?;
    if pointer.is_null() {
        return Ok(vec![]);
    }
    if text(pointer, "sha")? != head {
        return Err(malformed());
    }
    let project = number(pointer, "project_id")?;
    let pipeline = number(pointer, "id")?;
    if project != number(request, "source_project_id")?
        && project != number(request, "target_project_id")?
    {
        return Err(malformed());
    }
    let value = reader
        .get(&format!("projects/{project}/pipelines/{pipeline}"))
        .await?;
    if number(&value, "id")? != pipeline
        || number(&value, "project_id")? != project
        || text(&value, "sha")? != head
    {
        return Err(malformed());
    }
    let (status, conclusion) = gitlab_result(text(&value, "status")?)?;
    Ok(vec![Check {
        name: "pipeline".into(),
        source: "pipeline".into(),
        head: head.into(),
        id: pipeline,
        app: None,
        workflow: None,
        workflow_attempt: None,
        pipeline: Some(pipeline),
        project: Some(project),
        status,
        conclusion,
        started_at: timestamp(&value, "created_at")?,
        completed_at: timestamp(&value, "finished_at")?,
        allow_failure: false,
    }])
}
