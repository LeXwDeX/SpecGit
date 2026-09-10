use super::protocol::{WriteTransport, id, malformed, text};
use crate::{
    delivery_model::{Issue, PullRequest},
    diagnostic::{Code, Diagnostic},
    probe::{ForgeRead, encode},
    project::Repository,
};
use serde_json::{Value, json};
pub(super) fn request_route(repo: &Repository, id: u64) -> String {
    format!("{}/pulls/{id}", prefix(repo))
}
pub(super) fn auto_merge(raw: &Value) -> crate::delivery_model::AutoMerge {
    use crate::delivery_model::AutoMerge;
    match raw.get("auto_merge") {
        Some(Value::Null) => AutoMerge::NotRegistered,
        Some(v)
            if v.get("merge_method")
                .and_then(Value::as_str)
                .is_some_and(|s| ["merge", "squash", "rebase"].contains(&s))
                && v.pointer("/enabled_by/id")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| id > 0) =>
        {
            AutoMerge::Registered
        }
        _ => AutoMerge::Unknown,
    }
}

pub(crate) fn prefix(repo: &Repository) -> String {
    format!("repos/{}", repo.path)
}
fn labels(v: &Value) -> Result<Vec<String>, Diagnostic> {
    v.get("labels")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?
        .iter()
        .map(|v| text(v, "name"))
        .collect()
}
fn body(v: &Value) -> Result<String, Diagnostic> {
    match v.get("body") {
        Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(malformed()),
    }
}
fn issue_value(v: &Value, _project_id: u64) -> Result<Issue, Diagnostic> {
    if v.get("pull_request").is_some() {
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
        id: id(v, "number")?,
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
        "search/issues?q={}",
        encode(&format!("repo:{} is:issue is:open {query}", repo.path))
    );
    let mut rows = vec![];
    for page in 1..=10 {
        let value = reader
            .get(&format!("{route}&per_page=100&page={page}"))
            .await?;
        if value.get("incomplete_results").and_then(Value::as_bool) != Some(false) {
            return Err(Diagnostic::new(
                Code::OutputLimit,
                "issue_search",
                "Native issue search is incomplete.",
                "Narrow the specification query or adopt exact issue IDs.",
            ));
        }
        let items = value
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(malformed)?;
        if items.len() > 100 {
            return Err(malformed());
        }
        rows.extend(items.iter().cloned());
        if items.len() < 100 {
            break;
        }
        if page == 10 {
            return Err(Diagnostic::new(
                Code::OutputLimit,
                "issue_search",
                "Issue candidates exceed the complete search budget.",
                "Narrow the query or select exact IDs.",
            ));
        }
    }
    let mut out = vec![];
    for row in rows {
        out.push(issue(reader, repo, project_id, id(&row, "number")?).await?);
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
    let source = v.get("head").ok_or_else(malformed)?;
    let target = v.get("base").ok_or_else(malformed)?;
    let (source, target, head, source_project, target_project) = (
        text(source, "ref")?,
        text(target, "ref")?,
        text(source, "sha")?,
        id(source.get("repo").ok_or_else(malformed)?, "id")?,
        id(target.get("repo").ok_or_else(malformed)?, "id")?,
    );
    let mut state = text(v, "state")?;
    if v.get("merged")
        .and_then(Value::as_bool)
        .ok_or_else(malformed)?
    {
        state = "merged".into();
    }
    if !crate::project::valid_oid(&head)
        || !["open", "opened", "closed", "merged"].contains(&state.as_str())
    {
        return Err(malformed());
    }
    let result = PullRequest {
        id: id(v, "number")?,
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
    let owner = repo.path.split('/').next().ok_or_else(malformed)?;
    let route = format!(
        "{}/pulls?state=all&head={}",
        prefix(repo),
        encode(&format!("{owner}:{source}"))
    );
    let rows = reader.list(&route, None, 10).await?;
    let mut results = vec![];
    for row in rows {
        results.push(pull_request(reader, repo, id(&row, "number")?).await?);
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
    let sha = text(value.get("commit").ok_or_else(malformed)?, "sha")?;
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
        .get(&format!("{}/compare/{base}...{head}", prefix(repo)))
        .await?;
    let files = value
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?;
    if value
        .get("ahead_by")
        .and_then(Value::as_u64)
        .ok_or_else(malformed)?
        == 0
    {
        return Ok(false);
    }
    Ok(!files.is_empty())
}
pub(crate) async fn update_request_body(
    writer: &WriteTransport,
    number: u64,
    body: &str,
) -> Result<(), Diagnostic> {
    writer
        .write(
            "PATCH",
            &request_route(&writer.repo, number),
            json!({"body":body}),
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
            "POST",
            &format!("{}/issues/{number}/labels", prefix(&writer.repo)),
            json!({"labels":labels}),
        )
        .await?;
    Ok(())
}
pub(crate) async fn ready(writer: &WriteTransport, number: u64) -> Result<(), Diagnostic> {
    writer
        .ready(vec![
            "pr".into(),
            "ready".into(),
            number.to_string(),
            "--repo".into(),
            format!("{}/{}", writer.repo.host, writer.repo.path),
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
            json!({"name":tag.name,"color":tag.color,"description":tag.description}),
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
            json!({"title":title,"body":body,"labels":labels}),
        )
        .await?;
    id(&value, "number")
}
pub(crate) async fn create_request(
    writer: &WriteTransport,
    source: &str,
    target: &str,
    title: &str,
    body: &str,
) -> Result<u64, Diagnostic> {
    let value = writer
        .write(
            "POST",
            &format!("{}/pulls", prefix(&writer.repo)),
            json!({"head":source,"base":target,"title":title,"body":body,"draft":true}),
        )
        .await?;
    id(&value, "number")
}

fn branches_route(repo: &Repository) -> String {
    format!("{}/branches", prefix(repo))
}
