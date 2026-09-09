//! Complete, identity-bearing current-head check snapshots through read-only native APIs.
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
        "Read the exact current head and complete workflow/pipeline attempts; unknown evidence cannot grant acceptance.",
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
    let base = prefix(repo);
    let runs = counted(
        reader,
        &format!("{base}/actions/runs?head_sha={head}"),
        "workflow_runs",
    )
    .await?;
    let mut workflows: BTreeMap<(u64, String), Value> = BTreeMap::new();
    let mut suites = BTreeSet::new();
    for run in runs {
        if text(&run, "head_sha")? != head {
            return Err(malformed());
        }
        let key = (
            number(&run, "workflow_id")?,
            text(&run, "event")?.to_owned(),
        );
        number(&run, "run_attempt")?;
        suites.insert(number(&run, "check_suite_id")?);
        let id = number(&run, "id")?;
        if workflows
            .get(&key)
            .is_none_or(|old| old["id"].as_u64().is_some_and(|n| n < id))
        {
            workflows.insert(key, run);
        }
    }
    let mut owners = BTreeMap::new();
    let mut checks = BTreeMap::new();
    for ((workflow, event), run) in &workflows {
        let id = number(run, "id")?;
        let attempt = number(run, "run_attempt")?;
        let suite = number(run, "check_suite_id")?;
        if owners.insert(suite, (id, attempt)).is_some() {
            return Err(malformed());
        }
        let (status, conclusion) = github_result(run)?;
        latest(
            &mut checks,
            format!("workflow:{workflow}:{event}"),
            Check {
                lineage: crate::delivery_model::CheckLineage::CurrentHead,
                name: format!("workflow: {} ({event})", text(run, "name")?),
                source: "workflow".into(),
                head: head.into(),
                id,
                app: None,
                workflow: Some(id),
                workflow_attempt: Some(attempt),
                pipeline: None,
                project: None,
                status,
                conclusion,
                started_at: timestamp(run, "run_started_at")?,
                completed_at: None,
                allow_failure: false,
            },
        )?;
    }
    let mut all_jobs = BTreeSet::new();
    let mut selected_jobs = BTreeMap::new();
    for run in workflows.values() {
        let run_id = number(run, "id")?;
        let jobs = counted(
            reader,
            &format!("{base}/actions/runs/{run_id}/jobs?filter=all"),
            "jobs",
        )
        .await?;
        if jobs.is_empty() && run["conclusion"] == "success" {
            return Err(malformed());
        }
        let mut latest_jobs = BTreeMap::<String, Value>::new();
        for job in jobs {
            if number(&job, "run_id")? != run_id || text(&job, "head_sha")? != head {
                return Err(malformed());
            }
            let name = text(&job, "name")?.to_owned();
            let id = number(&job, "id")?;
            let check_url =
                url::Url::parse(text(&job, "check_run_url")?).map_err(|_| malformed())?;
            let expected_host = if repo.host == "github.com" {
                "api.github.com"
            } else {
                &repo.host
            };
            let expected_path = format!(
                "{}/repos/{}/check-runs/{id}",
                if repo.host == "github.com" {
                    ""
                } else {
                    "/api/v3"
                },
                repo.path
            );
            if check_url.scheme() != "https"
                || check_url.host_str() != Some(expected_host)
                || check_url.path() != expected_path
            {
                return Err(malformed());
            }
            if !all_jobs.insert(id) {
                return Err(malformed());
            }
            if latest_jobs
                .get(&name)
                .is_none_or(|old| old["id"].as_u64().is_some_and(|n| n < id))
            {
                latest_jobs.insert(name, job);
            }
        }
        for job in latest_jobs.into_values() {
            selected_jobs.insert(number(&job, "id")?, job);
        }
    }
    let mut matched_jobs = BTreeSet::new();
    let rows = counted(
        reader,
        &format!("{base}/commits/{head}/check-runs?filter=all"),
        "check_runs",
    )
    .await?;
    for row in rows {
        if text(&row, "head_sha")? != head {
            return Err(malformed());
        }
        let app = number(&row["app"], "id")?;
        let actions = text(&row["app"], "slug")? == "github-actions";
        let suite = number(&row["check_suite"], "id")?;
        let owner = owners.get(&suite);
        if actions && owner.is_none() {
            if suites.contains(&suite) {
                continue;
            }
            return Err(malformed());
        }
        let (status, conclusion) = github_result(&row)?;
        let name = text(&row, "name")?.to_owned();
        if actions {
            let id = number(&row, "id")?;
            let Some(job) = selected_jobs.get(&id) else {
                if all_jobs.contains(&id) {
                    continue;
                }
                return Err(malformed());
            };
            if github_result(job)? != (status.clone(), conclusion.clone())
                || text(job, "name")? != name
                || owner.is_none_or(|o| job["run_id"] != o.0)
            {
                return Err(malformed());
            }
            matched_jobs.insert(id);
            let key = format!("check:{app}:{name}");
            if checks
                .get(&key)
                .is_some_and(|old| old.workflow != owner.map(|o| o.0))
            {
                return Err(malformed());
            }
        }
        latest(
            &mut checks,
            format!("check:{app}:{name}"),
            Check {
                lineage: crate::delivery_model::CheckLineage::CurrentHead,
                name,
                source: "check".into(),
                head: head.into(),
                id: number(&row, "id")?,
                app: Some(app),
                workflow: owner.map(|o| o.0),
                workflow_attempt: owner.map(|o| o.1),
                pipeline: None,
                project: None,
                status,
                conclusion,
                started_at: timestamp(&row, "started_at")?,
                completed_at: timestamp(&row, "completed_at")?,
                allow_failure: false,
            },
        )?;
    }
    if matched_jobs.len() != selected_jobs.len() {
        return Err(malformed());
    }
    let statuses = reader
        .list(&format!("{base}/commits/{head}/statuses"), None, 10)
        .await?;
    for row in statuses {
        let state = text(&row, "state")?;
        if !["pending", "success", "failure", "error"].contains(&state) {
            return Err(malformed());
        }
        let name = text(&row, "context")?.to_owned();
        latest(
            &mut checks,
            format!("status:{name}"),
            Check {
                lineage: crate::delivery_model::CheckLineage::CurrentHead,
                name,
                source: "status".into(),
                head: head.into(),
                id: number(&row, "id")?,
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
    Ok(checks.into_values().collect())
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
/// Start at the MR's native head_pipeline, never a generic latest-project pipeline.
pub async fn gitlab(
    reader: &ForgeRead,
    request: &Value,
    head: &str,
) -> Result<Vec<Check>, Diagnostic> {
    let pointer = request.get("head_pipeline").ok_or_else(malformed)?;
    if pointer.is_null() {
        return Ok(vec![]);
    }
    if text(pointer, "sha")? != head || text(request, "sha")? != head {
        return Err(malformed());
    }
    let root = (number(pointer, "project_id")?, number(pointer, "id")?);
    if root.0 != number(request, "source_project_id")?
        && root.0 != number(request, "target_project_id")?
    {
        return Err(malformed());
    }
    let mut queue = vec![(root.0, root.1, head.to_owned(), BTreeSet::new(), vec![])];
    let mut visited = BTreeSet::new();
    let mut checks = BTreeMap::new();
    while let Some((project, pipeline, sha, mut ancestors, links)) = queue.pop() {
        if !ancestors.insert((project, pipeline)) {
            return Err(malformed());
        }
        if !visited.insert((project, pipeline)) {
            continue;
        }
        if visited.len() > 16 {
            return Err(malformed());
        }
        let base = format!("projects/{project}/pipelines/{pipeline}");
        let value = reader.get(&base).await?;
        if number(&value, "id")? != pipeline
            || number(&value, "project_id")? != project
            || text(&value, "sha")? != sha
        {
            return Err(malformed());
        }
        let (status, conclusion) = gitlab_result(text(&value, "status")?)?;
        let prefix = if (project, pipeline) == root {
            String::new()
        } else {
            format!("downstream:{project}/{pipeline}:")
        };
        checks.insert(
            format!("pipeline:{project}/{pipeline}"),
            Check {
                lineage: if (project, pipeline) == root {
                    crate::delivery_model::CheckLineage::CurrentHead
                } else {
                    crate::delivery_model::CheckLineage::downstream(links.clone())
                },
                name: format!("{prefix}pipeline"),
                source: "pipeline".into(),
                head: sha.clone(),
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
            },
        );
        for collection in ["jobs", "trigger_jobs"] {
            // The native API omits retried jobs by default; retain that current-attempt contract.
            let rows = reader
                .list(&format!("{base}/{collection}"), None, 10)
                .await?;
            let mut ids = BTreeSet::new();
            for row in rows {
                let id = number(&row, "id")?;
                if !ids.insert(id) {
                    return Err(malformed());
                }
                let name = text(&row, "name")?;
                let allow_failure = row
                    .get("allow_failure")
                    .and_then(Value::as_bool)
                    .ok_or_else(malformed)?;
                let (status, conclusion) = gitlab_result(text(&row, "status")?)?;
                if collection == "jobs"
                    && (number(&row["pipeline"], "id")? != pipeline
                        || number(&row["pipeline"], "project_id")? != project
                        || text(&row["commit"], "id")? != sha)
                {
                    return Err(malformed());
                }
                let key = format!("{collection}:{project}/{pipeline}:{name}");
                if checks.contains_key(&key) {
                    return Err(malformed());
                }
                checks.insert(
                    key,
                    Check {
                        lineage: if (project, pipeline) == root {
                            crate::delivery_model::CheckLineage::CurrentHead
                        } else {
                            crate::delivery_model::CheckLineage::downstream(links.clone())
                        },
                        name: format!("{prefix}{name}"),
                        source: collection.into(),
                        head: sha.clone(),
                        id,
                        app: None,
                        workflow: None,
                        workflow_attempt: None,
                        pipeline: Some(pipeline),
                        project: Some(project),
                        status,
                        conclusion,
                        started_at: timestamp(&row, "started_at")?,
                        completed_at: timestamp(&row, "finished_at")?,
                        allow_failure,
                    },
                );
                if collection == "trigger_jobs" {
                    match row.get("downstream_pipeline") {
                        Some(Value::Null) if text(&row, "status")? == "skipped" => {}
                        Some(Value::Null) => return Err(malformed()),
                        Some(next) => {
                            let child_sha = text(next, "sha")?;
                            if !crate::project::valid_oid(child_sha) {
                                return Err(malformed());
                            }
                            let child_project = number(next, "project_id")?;
                            let child_pipeline = number(next, "id")?;
                            let mut child_links = links.clone();
                            child_links.push(crate::delivery_model::PipelineLink::observed(
                                (&sha, project, pipeline),
                                id,
                                (child_sha, child_project, child_pipeline),
                            ));
                            queue.push((
                                child_project,
                                child_pipeline,
                                child_sha.into(),
                                ancestors.clone(),
                                child_links,
                            ));
                        }
                        None => return Err(malformed()),
                    }
                }
            }
        }
    }
    Ok(checks.into_values().collect())
}
