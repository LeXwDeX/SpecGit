//! Read-only cutover barrier. Absence of local files is never remote retirement evidence.
use crate::{
    config,
    diagnostic::{Code, Diagnostic},
    native_delivery::{branch_head, prefix},
    native_file,
    probe::{ForgeRead, encode},
    project::{Provider, Repository},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Retirement {
    pub project_id: u64,
    pub default_branch: String,
    pub commit: String,
    pub scanned_paths: Vec<String>,
    pub blockers: Vec<String>,
    pub unfinished_runs: Vec<u64>,
    pub active_schedules: Vec<(u64, String)>,
}
fn malformed() -> Diagnostic {
    Diagnostic::new(
        Code::MalformedResponse,
        "migration_remote",
        "Native writer inventory is incomplete or inconsistent.",
        "Inspect native workflow/pipeline configuration and unfinished runs before activating v2.",
    )
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, Diagnostic> {
    v.get(key).and_then(Value::as_str).ok_or_else(malformed)
}
fn id(v: &Value) -> Result<u64, Diagnostic> {
    v.get("id")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(malformed)
}
async fn contents(
    reader: &ForgeRead,
    repo: &Repository,
    commit: &str,
    path: &str,
) -> Result<String, Diagnostic> {
    config::relative_path(path)?;
    let base = prefix(repo);
    let endpoint = if repo.provider == Provider::Github {
        format!(
            "{base}/contents/{}?ref={commit}",
            path.split('/').map(encode).collect::<Vec<_>>().join("/")
        )
    } else {
        format!("{base}/repository/files/{}?ref={commit}", encode(path))
    };
    let value = reader.get(&endpoint).await?;
    let size = value
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(malformed)?;
    if size > config::MAX_BYTES as u64 || string(&value, "encoding")? != "base64" {
        return Err(malformed());
    }
    if repo.provider == Provider::Github {
        if string(&value, "path")? != path
            || string(&value, "type")? != "file"
            || !native_file::object_id(string(&value, "sha")?)
        {
            return Err(malformed());
        }
    } else if string(&value, "file_path")? != path
        || string(&value, "commit_id")? != commit
        || !native_file::object_id(string(&value, "blob_id")?)
    {
        return Err(malformed());
    }
    let compact: String = string(&value, "content")?
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if compact.len() > config::MAX_BYTES * 2 {
        return Err(malformed());
    }
    let bytes = STANDARD.decode(compact).map_err(|_| malformed())?;
    if bytes.len() as u64 != size {
        return Err(malformed());
    }
    String::from_utf8(bytes).map_err(|_| malformed())
}
fn inspect_ci(text: &str) -> bool {
    // Migration retires v1 integration rather than inferring the semantics of arbitrary shell.
    text.to_ascii_lowercase().contains("specgit") || text.contains("spec_git/")
}
async fn counted(reader: &ForgeRead, endpoint: &str, key: &str) -> Result<Vec<Value>, Diagnostic> {
    let separator = if endpoint.contains('?') { '&' } else { '?' };
    let mut expected = None;
    let mut rows = vec![];
    let mut ids = BTreeSet::new();
    for page in 1..=10 {
        let value = reader
            .get(&format!("{endpoint}{separator}per_page=100&page={page}"))
            .await?;
        let total = value
            .get("total_count")
            .and_then(Value::as_u64)
            .filter(|n| *n <= 1000)
            .ok_or_else(malformed)?;
        if expected.is_some_and(|n| n != total) {
            return Err(malformed());
        }
        expected = Some(total);
        let current = value
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(malformed)?;
        if current.len() > 100 {
            return Err(malformed());
        }
        for row in current {
            if !ids.insert(id(row)?) {
                return Err(malformed());
            }
            rows.push(row.clone());
        }
        if rows.len() as u64 > total {
            return Err(malformed());
        }
        if current.len() < 100 || rows.len() as u64 == total {
            if rows.len() as u64 != total {
                return Err(malformed());
            }
            return Ok(rows);
        }
    }
    Err(malformed())
}
#[derive(Deserialize)]
struct CiIncludes {
    include: Option<Includes>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Includes {
    Many(Vec<Include>),
    One(Include),
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Include {
    Text(String),
    Local(LocalInclude),
    Unknown(serde::de::IgnoredAny),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalInclude {
    local: String,
    #[serde(default)]
    rules: Option<serde::de::IgnoredAny>,
}
fn includes(bytes: &str) -> Result<Vec<Option<String>>, Diagnostic> {
    let config: CiIncludes = serde_yaml_ng::from_str(bytes).map_err(|_| malformed())?;
    let values = match config.include {
        None => vec![],
        Some(Includes::One(i)) => vec![i],
        Some(Includes::Many(v)) => v,
    };
    if values.len() > 64 {
        return Err(malformed());
    }
    Ok(values
        .into_iter()
        .map(|v| match v {
            Include::Text(s) => Some(s),
            Include::Local(v) => {
                let _ = v.rules;
                Some(v.local)
            }
            Include::Unknown(_) => None,
        })
        .collect())
}
pub async fn inspect(reader: &ForgeRead, repo: &Repository) -> Result<Retirement, Diagnostic> {
    let facts = reader.project(repo).await?;
    let commit = branch_head(reader, repo, &facts.default_branch).await?;
    let base = prefix(repo);
    let mut result = Retirement {
        project_id: facts.id,
        default_branch: facts.default_branch.clone(),
        commit: commit.clone(),
        scanned_paths: vec![],
        blockers: vec![],
        unfinished_runs: vec![],
        active_schedules: vec![],
    };
    if repo.provider == Provider::Github {
        let workflows = counted(reader, &format!("{base}/actions/workflows"), "workflows").await?;
        let mut ids = BTreeSet::new();
        for workflow in workflows {
            if !ids.insert(id(&workflow)?) {
                return Err(malformed());
            }
            let state = string(&workflow, "state")?;
            if [
                "disabled_manually",
                "disabled_inactivity",
                "disabled_fork",
                "deleted",
            ]
            .contains(&state)
            {
                continue;
            }
            if state != "active" {
                return Err(malformed());
            }
            let path = string(&workflow, "path")?;
            if !path.starts_with(".github/workflows/") {
                return Err(malformed());
            }
            let bytes = contents(reader, repo, &commit, path).await?;
            result.scanned_paths.push(path.to_owned());
            if inspect_ci(&bytes) {
                result.blockers.push(path.to_owned());
            }
            // Dynamic reusable jobs can conceal a retired writer outside this repository.
            if bytes.lines().any(|line| {
                line.trim_start().starts_with("uses:") && line.contains("/.github/workflows/")
            }) {
                result
                    .blockers
                    .push(format!("unverified_reusable_workflow:{path}"));
            }
        }
        // A disabled workflow can still have an already dispatched writer. Require a quiescent cutover.
        for state in ["queued", "in_progress", "waiting", "pending", "requested"] {
            for run in counted(
                reader,
                &format!("{base}/actions/runs?status={state}"),
                "workflow_runs",
            )
            .await?
            {
                if string(&run, "status")? != state {
                    return Err(malformed());
                }
                result.unfinished_runs.push(id(&run)?);
            }
        }
    } else {
        let project = reader.get(&base).await?;
        let selected = project
            .get("ci_config_path")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(".gitlab-ci.yml");
        config::relative_path(selected)?;
        let rows = reader
            .list(
                &format!("{base}/repository/tree?ref={commit}&recursive=true"),
                None,
                32,
            )
            .await?;
        let mut paths = BTreeMap::new();
        for row in rows {
            let path = string(&row, "path")?.to_owned();
            config::relative_path(&path)?;
            if !native_file::object_id(string(&row, "id")?) || paths.insert(path, row).is_some() {
                return Err(malformed());
            }
        }
        let mut queue = vec![(selected.to_owned(), Vec::<String>::new())];
        let mut visited = BTreeSet::new();
        while let Some((path, mut ancestors)) = queue.pop() {
            if ancestors.contains(&path) || ancestors.len() >= 8 || visited.len() >= 64 {
                return Err(malformed());
            }
            if !visited.insert(path.clone()) {
                continue;
            }
            let Some(row) = paths.get(&path) else {
                if path == ".gitlab-ci.yml" && ancestors.is_empty() {
                    continue;
                }
                return Err(malformed());
            };
            if string(row, "type")? != "blob"
                || !["100644", "100755"].contains(&string(row, "mode")?)
            {
                return Err(malformed());
            }
            let bytes = contents(reader, repo, &commit, &path).await?;
            result.scanned_paths.push(path.clone());
            if inspect_ci(&bytes) {
                result.blockers.push(path.clone());
            }
            ancestors.push(path.clone());
            for include in includes(&bytes)? {
                let Some(local) = include else {
                    result.blockers.push(format!("unverified_include:{path}"));
                    continue;
                };
                let relative = local.strip_prefix('/').unwrap_or(&local);
                if relative.contains(['$', '*', '?', '[', ']', '{', '}'])
                    || config::relative_path(relative).is_err()
                {
                    result.blockers.push(format!("unverified_include:{path}"));
                    continue;
                }
                queue.push((relative.to_owned(), ancestors.clone()));
            }
        }
        for state in [
            "created",
            "waiting_for_resource",
            "preparing",
            "waiting_for_callback",
            "canceling",
            "pending",
            "running",
            "scheduled",
            "manual",
        ] {
            for source in ["", "&source=parent_pipeline"] {
                for run in reader
                    .list(
                        &format!("{base}/pipelines?status={state}{source}"),
                        None,
                        10,
                    )
                    .await?
                {
                    if string(&run, "status")? != state {
                        return Err(malformed());
                    }
                    result.unfinished_runs.push(id(&run)?);
                }
            }
        }
    }
    if repo.provider == Provider::Gitlab {
        let mut schedule_ids = BTreeSet::new();
        for schedule in reader
            .list(&format!("{base}/pipeline_schedules?scope=active"), None, 10)
            .await?
        {
            let schedule_id = id(&schedule)?;
            if schedule.get("active").and_then(Value::as_bool) != Some(true)
                || !schedule_ids.insert(schedule_id)
            {
                return Err(malformed());
            }
            let reference = string(&schedule, "ref")?;
            result
                .active_schedules
                .push((schedule_id, reference.to_owned()));
            if reference.strip_prefix("refs/heads/").unwrap_or(reference) != facts.default_branch {
                result
                    .blockers
                    .push(format!("unverified_schedule_ref:{schedule_id}:{reference}"));
            }
        }
        result.active_schedules.sort();
    }
    result.scanned_paths.sort();
    result.scanned_paths.dedup();
    result.blockers.sort();
    result.blockers.dedup();
    result.unfinished_runs.sort();
    result.unfinished_runs.dedup();
    let final_facts = reader.project(repo).await?;
    if final_facts.id != facts.id
        || final_facts.default_branch != facts.default_branch
        || branch_head(reader, repo, &facts.default_branch).await? != commit
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "migration_remote",
            "Native project identity changed during writer inspection.",
            "Refresh the native inventory before migration.",
        ));
    }
    Ok(result)
}
