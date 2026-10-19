use super::protocol::{WriteTransport, id, malformed, text};
use crate::{
    delivery_model::{CandidateRead, CandidateSearch, HistoryIssue, Issue, PullRequest},
    diagnostic::{Code, Diagnostic},
    forge_read::{ForgeRead, Pagination, encode},
    identity::Repository,
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

pub(crate) use crate::forge_routes::github_prefix as prefix;
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
    Ok(issue_read(reader, repo, project_id, number).await?.issue)
}

pub(crate) async fn issue_read(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    number: u64,
) -> Result<crate::delivery_model::IssueRead, Diagnostic> {
    let v = reader
        .get(&format!("{}/issues/{number}", prefix(repo)))
        .await?;
    let result = issue_value(&v, project_id)?;
    if result.id != number {
        return Err(malformed());
    }
    Ok(crate::delivery_model::IssueRead {
        issue: result,
        milestone: milestone_context(&v, repo),
    })
}

fn milestone_context(raw: &Value, repo: &Repository) -> crate::delivery_model::MilestoneContext {
    use crate::delivery_model::{Milestone, MilestoneContext};
    let unknown = || MilestoneContext::Unknown {
        reason:
            "The GitHub milestone is missing, malformed, or has unverified repository identity."
                .into(),
    };
    let Some(value) = raw.get("milestone") else {
        return unknown();
    };
    if value.is_null() {
        return MilestoneContext::None;
    }
    let parsed = (|| {
        let id = id(value, "id").ok()?;
        let number = super::protocol::id(value, "number").ok()?;
        let title = text(value, "title").ok()?;
        let state = text(value, "state").ok()?;
        let url = text(value, "html_url").ok()?;
        // An exact native path proves the repository and number. No query,
        // credentials, escapes, fragment or parser normalization is accepted.
        if !["open", "closed"].contains(&state.as_str())
            || title.trim().is_empty()
            || !["https://", "http://"].iter().any(|scheme| {
                url.strip_prefix(scheme)
                    .and_then(|s| s.strip_suffix(&format!("/milestone/{number}")))
                    .is_some_and(|s| {
                        s.eq_ignore_ascii_case(&format!("{}/{}", repo.host, repo.path))
                    })
            })
        {
            return None;
        }
        Some(Milestone::Github {
            id,
            number,
            title,
            state,
            url,
        })
    })();
    parsed
        .map(|milestone| MilestoneContext::Linked { milestone })
        .unwrap_or_else(unknown)
}
fn title_query(query: &str) -> String {
    let summary = if crate::spec::kind(query).is_ok() {
        query.split_once(':').map_or(query, |(_, summary)| summary)
    } else {
        query
    };
    let summary: String = summary
        .chars()
        .map(|c| {
            if matches!(c, ':' | '"' | '\\') || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();
    format!(
        "in:title \"{}\"",
        summary.split_whitespace().collect::<Vec<_>>().join(" ")
    )
}
fn verify_search_repository(row: &Value, repo: &Repository) -> Result<(), Diagnostic> {
    if !text(row, "repository_url")?.ends_with(&format!("/repos/{}", repo.path)) {
        return Err(malformed());
    }
    Ok(())
}
pub(crate) async fn candidates(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    query: &str,
) -> Result<CandidateSearch, Diagnostic> {
    let route = format!(
        "search/issues?q={}",
        encode(&format!(
            "repo:{} is:issue is:open {}",
            repo.path,
            title_query(query)
        ))
    );
    const PAGE_LIMIT: usize = 10;
    reader.pagination_started(PAGE_LIMIT);
    let mut rows = vec![];
    let mut pages_fetched = 0;
    let mut items_seen = 0;
    let mut complete = false;
    for page in 1..=PAGE_LIMIT {
        let value = reader
            .get(&format!("{route}&per_page=100&page={page}"))
            .await?;
        pages_fetched += 1;
        reader.page_fetched();
        let items = value
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                reader.mark_inspection_incomplete();
                malformed()
            })?;
        if items.len() > 100 {
            reader.mark_inspection_incomplete();
            return Err(malformed());
        }
        items_seen += items.len();
        reader.page_items_seen(items.len());
        if value.get("incomplete_results").and_then(Value::as_bool) != Some(false) {
            reader.mark_inspection_incomplete();
            return Err(Diagnostic::new(
                Code::OutputLimit,
                "issue_search",
                "Native issue search is incomplete.",
                "Narrow the specification query or adopt exact issue IDs.",
            ));
        }
        rows.extend(items.iter().cloned());
        if items.len() < 100 {
            complete = true;
            break;
        }
    }
    if !complete {
        reader.mark_inspection_incomplete();
        return Err(Diagnostic::new(
            Code::OutputLimit,
            "issue_search",
            "Issue candidates exceed the complete search budget.",
            "Narrow the query or select exact IDs.",
        ));
    }
    let mut out = vec![];
    for row in rows {
        verify_search_repository(&row, repo)?;
        let candidate = issue(reader, repo, project_id, id(&row, "number")?).await?;
        // Search rows can lag behind an issue being closed.
        if candidate.state != "closed" {
            out.push(candidate);
        }
    }
    let (history, history_diagnostics) = match history(reader, repo, query).await {
        Ok(history) => (history, vec![]),
        Err(d) if d.code == Code::Cancelled => return Err(d),
        Err(d) => (vec![], vec![d]),
    };
    Ok(CandidateSearch {
        read: CandidateRead {
            issues: out,
            pagination: Pagination {
                pages_fetched,
                items_seen,
                page_limit: PAGE_LIMIT,
                complete,
            },
        },
        history,
        history_diagnostics,
    })
}

async fn history(
    reader: &ForgeRead,
    repo: &Repository,
    query: &str,
) -> Result<Vec<HistoryIssue>, Diagnostic> {
    let value = reader
        .get(&format!(
            "search/issues?q={}&per_page=20&page=1",
            encode(&format!(
                "repo:{} is:issue is:closed {}",
                repo.path,
                title_query(query)
            ))
        ))
        .await?;
    if value.get("incomplete_results").and_then(Value::as_bool) != Some(false) {
        return Err(Diagnostic::new(
            Code::OutputLimit,
            "issue_history",
            "Native closed issue search is incomplete.",
            "Inspect closed issues on the native platform; history is reference evidence only.",
        ));
    }
    let rows = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?;
    if rows.len() > 20 {
        return Err(malformed());
    }
    rows.iter()
        .map(|row| {
            verify_search_repository(row, repo)?;
            if row.get("pull_request").is_some() || text(row, "state")? != "closed" {
                return Err(malformed());
            }
            Ok(HistoryIssue {
                id: id(row, "number")?,
                title: text(row, "title")?,
                state: "closed".into(),
                state_reason: optional_history_text(row, "state_reason")?,
                updated_at: text(row, "updated_at")?,
                url: optional_history_text(row, "html_url")?,
            })
        })
        .collect()
}

fn optional_history_text(row: &Value, key: &str) -> Result<Option<String>, Diagnostic> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(malformed()),
    }
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
    if !crate::identity::valid_oid(&head)
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
        // GitHub retains pull requests whose source fork has been deleted.
        if row.pointer("/head/repo").is_some_and(Value::is_null) {
            continue;
        }
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
    if !crate::identity::valid_oid(&sha) {
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
    if !crate::identity::valid_oid(base) || !crate::identity::valid_oid(head) {
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
    tag: &crate::declaration::Tag,
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

pub use crate::forge_read::CLOSING_ISSUES_QUERY;

pub(super) async fn closing_issues(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    request_id: u64,
) -> Result<Vec<u64>, Diagnostic> {
    use std::collections::BTreeSet;
    let (owner, name) = repo
        .path
        .split_once('/')
        .ok_or_else(super::closing_identity)?;
    if owner.is_empty() || name.is_empty() || name.contains('/') || request_id > i32::MAX as u64 {
        return Err(Diagnostic::input(
            "A GitHub owner/repository and bounded request number are required.",
        ));
    }
    let mut after: Option<String> = None;
    let mut cursors = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for _ in 0..10 {
        let value = reader
            .github_closing_issues_page(owner, name, request_id, after.as_deref())
            .await?;
        if let Some(errors) = value.get("errors") {
            let errors = errors.as_array().ok_or_else(super::closing_malformed)?;
            if !errors.is_empty() {
                let code = if errors.iter().any(|e| e["type"] == "FORBIDDEN") {
                    Code::PermissionDenied
                } else if errors.iter().any(|e| e["type"] == "NOT_FOUND") {
                    Code::AmbiguousNotFound
                } else if errors.iter().any(|e| e["type"] == "RATE_LIMITED") {
                    Code::RateLimited
                } else if errors.iter().any(|e| {
                    e["type"] == "undefinedField" || e["extensions"]["code"] == "undefinedField"
                }) {
                    Code::UnsupportedOperation
                } else {
                    Code::MalformedResponse
                };
                return Err(Diagnostic::new(
                    code,
                    "closing_issues",
                    "GitHub did not return a complete closing-reference query result.",
                    "Inspect GraphQL field support and repository permissions; partial data is not complete native association evidence.",
                ));
            }
        }
        let repository = value
            .pointer("/data/repository")
            .ok_or_else(super::closing_malformed)?;
        closing_repository(repository, repo, project_id)?;
        let request = repository
            .get("pullRequest")
            .ok_or_else(super::closing_malformed)?;
        let number = request
            .get("number")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or_else(super::closing_malformed)?;
        if number != request_id {
            return Err(super::closing_identity());
        }
        let connection = request
            .get("closingIssuesReferences")
            .ok_or_else(super::closing_malformed)?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(super::closing_malformed)?;
        if nodes.len() > 100 {
            return Err(super::closing_malformed());
        }
        for node in nodes {
            let issue = node
                .get("number")
                .and_then(Value::as_u64)
                .filter(|id| *id > 0)
                .ok_or_else(super::closing_malformed)?;
            let project = node
                .get("repository")
                .ok_or_else(super::closing_malformed)?;
            closing_repository(project, repo, project_id)?;
            if !ids.insert(issue) {
                return Err(super::closing_malformed());
            }
        }
        let page = connection
            .get("pageInfo")
            .ok_or_else(super::closing_malformed)?;
        let more = page
            .get("hasNextPage")
            .and_then(Value::as_bool)
            .ok_or_else(super::closing_malformed)?;
        if !more {
            return Ok(ids.into_iter().collect());
        }
        let cursor = page
            .get("endCursor")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control))
            .ok_or_else(super::closing_malformed)?;
        if nodes.is_empty() || !cursors.insert(cursor.to_owned()) {
            return Err(super::closing_malformed());
        }
        after = Some(cursor.to_owned());
    }
    Err(super::closing_limit())
}

fn closing_repository(
    value: &Value,
    repo: &Repository,
    expected_id: u64,
) -> Result<(), Diagnostic> {
    let id = value
        .get("databaseId")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or_else(super::closing_malformed)?;
    let name = value
        .get("nameWithOwner")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(super::closing_malformed)?;
    if id != expected_id || !name.eq_ignore_ascii_case(&repo.path) {
        return Err(super::closing_identity());
    }
    Ok(())
}
