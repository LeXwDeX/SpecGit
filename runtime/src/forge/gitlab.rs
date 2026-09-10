use super::protocol::{WriteTransport, id, malformed, text};
use crate::{
    delivery_model::{Issue, PullRequest},
    diagnostic::{Code, Diagnostic},
    probe::{ForgeRead, encode},
    project::Repository,
};
use serde_json::{Value, json};
pub(super) fn request_route(repo: &Repository, id: u64) -> String {
    format!("{}/merge_requests/{id}", prefix(repo))
}
pub(super) fn auto_merge(raw: &Value) -> crate::delivery_model::AutoMerge {
    use crate::delivery_model::AutoMerge;
    match raw
        .get("merge_when_pipeline_succeeds")
        .and_then(Value::as_bool)
    {
        Some(true) => AutoMerge::Registered,
        Some(false) => AutoMerge::NotRegistered,
        None => AutoMerge::Unknown,
    }
}

pub(crate) fn prefix(repo: &Repository) -> String {
    format!("projects/{}", encode(&repo.path))
}
fn labels(v: &Value) -> Result<Vec<String>, Diagnostic> {
    v.get("labels")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?
        .iter()
        .map(|v| v.as_str().map(String::from).ok_or_else(malformed))
        .collect()
}
fn body(v: &Value) -> Result<String, Diagnostic> {
    match v.get("description") {
        Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(malformed()),
    }
}
fn issue_value(v: &Value, _project_id: u64) -> Result<Issue, Diagnostic> {
    if v.get("pull_request").is_some() || id(v, "project_id")? != _project_id {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "issue",
            "The native object is not an issue in the selected project.",
            "Select an exact same-project issue ID.",
        ));
    }
    let state = text(v, "state")?;
    if !["open", "opened", "closed"].contains(&state.as_str()) {
        return Err(malformed());
    }
    Ok(Issue {
        id: id(v, "iid")?,
        title: text(v, "title")?,
        body: body(v)?,
        labels: labels(v)?,
        state,
        updated_at: text(v, "updated_at")?,
    })
}
pub(crate) async fn issue(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    number: u64,
) -> Result<Issue, Diagnostic> {
    let v = reader
        .get(&format!("{}/issues/{number}", prefix(repo)))
        .await?;
    let result = issue_value(&v, project_id)?;
    if result.id != number {
        return Err(malformed());
    }
    Ok(result)
}
pub(crate) async fn candidates(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    query: &str,
) -> Result<Vec<Issue>, Diagnostic> {
    let route = format!(
        "{}/issues?state=opened&search={}&in=title",
        prefix(repo),
        encode(query)
    );
    let rows = reader.list(&route, None, 10).await?;
    let mut out = vec![];
    for row in rows {
        out.push(issue(reader, repo, project_id, id(&row, "iid")?).await?);
    }
    Ok(out)
}
pub(crate) async fn label_pool(
    reader: &ForgeRead,
    repo: &Repository,
) -> Result<Vec<String>, Diagnostic> {
    reader
        .list(&format!("{}/labels", prefix(repo)), None, 10)
        .await?
        .iter()
        .map(|v| text(v, "name"))
        .collect()
}
pub(crate) async fn pull_request(
    reader: &ForgeRead,
    repo: &Repository,
    number: u64,
) -> Result<PullRequest, Diagnostic> {
    let v = reader.get(&request_route(repo, number)).await?;
    request_value(&v, number)
}
pub(crate) fn request_value(v: &Value, number: u64) -> Result<PullRequest, Diagnostic> {
    let (source, target, head, source_project, target_project) = (
        text(v, "source_branch")?,
        text(v, "target_branch")?,
        text(v, "sha")?,
        id(v, "source_project_id")?,
        id(v, "target_project_id")?,
    );
    let state = text(v, "state")?;
    if !crate::project::valid_oid(&head)
        || !["open", "opened", "closed", "merged"].contains(&state.as_str())
    {
        return Err(malformed());
    }
    let result = PullRequest {
        id: id(v, "iid")?,
        title: text(v, "title")?,
        body: body(v)?,
        labels: labels(v)?,
        state,
        draft: v
            .get("draft")
            .and_then(Value::as_bool)
            .ok_or_else(malformed)?,
        head,
        source,
        target,
        source_project,
        target_project,
        updated_at: text(v, "updated_at")?,
    };
    if result.id != number {
        return Err(malformed());
    }
    Ok(result)
}
pub(crate) async fn request_candidates(
    reader: &ForgeRead,
    repo: &Repository,
    source: &str,
) -> Result<Vec<PullRequest>, Diagnostic> {
    let route = format!(
        "{}/merge_requests?scope=all&source_branch={}",
        prefix(repo),
        encode(source)
    );
    let rows = reader.list(&route, None, 10).await?;
    let mut results = vec![];
    for row in rows {
        results.push(pull_request(reader, repo, id(&row, "iid")?).await?);
    }
    Ok(results)
}
pub(crate) async fn branch_head(
    reader: &ForgeRead,
    repo: &Repository,
    branch: &str,
) -> Result<String, Diagnostic> {
    let value = reader
        .get(&format!("{}/{}", branches_route(repo), encode(branch)))
        .await?;
    if text(&value, "name")? != branch {
        return Err(malformed());
    }
    let sha = text(value.get("commit").ok_or_else(malformed)?, "id")?;
    if !crate::project::valid_oid(&sha) {
        return Err(malformed());
    }
    Ok(sha)
}
/// Proves at least one changed file, never an exhaustive diff inventory.
pub(crate) async fn has_changes(
    reader: &ForgeRead,
    repo: &Repository,
    base: &str,
    head: &str,
) -> Result<bool, Diagnostic> {
    if !crate::project::valid_oid(base) || !crate::project::valid_oid(head) {
        return Err(malformed());
    }
    let value = reader
        .get(&format!(
            "{}/repository/compare?from={base}&to={head}",
            prefix(repo)
        ))
        .await?;
    if value.get("compare_timeout").and_then(Value::as_bool) != Some(false) {
        return Err(malformed());
    }
    let files = value
        .get("diffs")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?;
    Ok(!files.is_empty())
}
pub(crate) async fn update_request_body(
    writer: &WriteTransport,
    number: u64,
    body: &str,
) -> Result<(), Diagnostic> {
    writer
        .write(
            "PUT",
            &request_route(&writer.repo, number),
            json!({"description":body}),
        )
        .await?;
    Ok(())
}
pub(crate) async fn add_request_labels(
    writer: &WriteTransport,
    number: u64,
    labels: &[String],
) -> Result<(), Diagnostic> {
    writer
        .write(
            "PUT",
            &request_route(&writer.repo, number),
            json!({"add_labels":labels.join(",")}),
        )
        .await?;
    Ok(())
}
pub(crate) async fn ready(writer: &WriteTransport, number: u64) -> Result<(), Diagnostic> {
    writer
        .ready(vec![
            "mr".into(),
            "update".into(),
            number.to_string(),
            "--repo".into(),
            format!("https://{}/{}", writer.repo.host, writer.repo.path),
            "--ready".into(),
        ])
        .await
}
pub(crate) async fn create_label(
    writer: &WriteTransport,
    tag: &crate::config::Tag,
) -> Result<(), Diagnostic> {
    writer
        .write(
            "POST",
            &format!("{}/labels", prefix(&writer.repo)),
            json!({"name":tag.name,"color":format!("#{}",tag.color),"description":tag.description}),
        )
        .await?;
    Ok(())
}
pub(crate) async fn create_issue(
    writer: &WriteTransport,
    title: &str,
    body: &str,
    labels: &[String],
) -> Result<u64, Diagnostic> {
    let value = writer
        .write(
            "POST",
            &format!("{}/issues", prefix(&writer.repo)),
            json!({"title":title,"description":body,"labels":labels.join(",")}),
        )
        .await?;
    id(&value, "iid")
}
pub(crate) async fn create_request(
    writer: &WriteTransport,
    source: &str,
    target: &str,
    title: &str,
    body: &str,
) -> Result<u64, Diagnostic> {
    let value = writer.write("POST", &format!("{}/merge_requests", prefix(&writer.repo)), json!({"source_branch":source,"target_branch":target,"title":format!("Draft: {title}"),"description":body})).await?;
    id(&value, "iid")
}

fn branches_route(repo: &Repository) -> String {
    format!("{}/repository/branches", prefix(repo))
}
