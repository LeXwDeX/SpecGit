use super::protocol::{WriteTransport, id, malformed, text};
use crate::{
    delivery_model::{CandidateRead, CandidateSearch, HistoryIssue, Issue, PullRequest},
    diagnostic::{Code, Diagnostic},
    forge_read::{ForgeRead, encode},
    identity::Repository,
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

pub(crate) use crate::forge_routes::gitlab_prefix as prefix;
fn labels(v: &Value) -> Result<Vec<String>, Diagnostic> {
    v.get("labels")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?
        .iter()
        .map(|v| v.as_str().map(String::from).ok_or_else(malformed))
        .collect()
}
pub(crate) fn written_body_matches(submitted: &str, observed: &str) -> bool {
    // GitLab normalizes CRLF and trailing ASCII whitespace on description writes.
    // Keep leading/Unicode whitespace and all native-to-native snapshots exact.
    observed == submitted
        || observed
            == submitted
                .replace("\r\n", "\n")
                .trim_end_matches([' ', '\t', '\r', '\n'])
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
        milestone: milestone_context(&v, repo, project_id),
    })
}

fn milestone_context(
    raw: &Value,
    repo: &Repository,
    project_id: u64,
) -> crate::delivery_model::MilestoneContext {
    use crate::delivery_model::{Milestone, MilestoneContext, MilestoneScope};
    let unknown = || MilestoneContext::Unknown {
        reason: "The embedded GitLab milestone is missing, malformed, or has unverified scope."
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
        let iid = super::protocol::id(value, "iid").ok()?;
        let title = text(value, "title").ok()?;
        let state = text(value, "state").ok()?;
        if !["active", "closed"].contains(&state.as_str()) || title.trim().is_empty() {
            return None;
        }
        let project = value.get("project_id").filter(|v| !v.is_null());
        let group = value.get("group_id").filter(|v| !v.is_null());
        let scope = match (project, group) {
            (Some(p), None) if p.as_u64() == Some(project_id) => {
                MilestoneScope::Project { project_id }
            }
            (None, Some(g)) if g.as_u64().is_some_and(|id| id > 0) => MilestoneScope::Group {
                group_id: g.as_u64()?,
            },
            _ => return None,
        };
        // The embedded API need not supply web_url. Group paths cannot be
        // verified from group_id alone, so do not expose or invent that URL.
        let url = value
            .get("web_url")
            .and_then(Value::as_str)
            .filter(|url| {
                matches!(scope, MilestoneScope::Project { .. })
                    && ["https", "http"].iter().any(|scheme| {
                        *url == format!("{scheme}://{}/{}/-/milestones/{iid}", repo.host, repo.path)
                    })
            })
            .map(str::to_owned);
        Some(Milestone::Gitlab {
            id,
            iid,
            title,
            state,
            scope,
            url,
        })
    })();
    parsed
        .map(|milestone| MilestoneContext::Linked { milestone })
        .unwrap_or_else(unknown)
}
pub(crate) async fn candidates(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    query: &str,
) -> Result<CandidateSearch, Diagnostic> {
    let route = format!(
        "{}/issues?state=opened&search={}&in=title",
        prefix(repo),
        encode(query)
    );
    let page_result = reader.list_report(&route, None, 10).await?;
    if !page_result.pagination.complete {
        reader.mark_inspection_incomplete();
        return Err(Diagnostic::new(
            Code::OutputLimit,
            "issue_search",
            "Issue candidates exceed the complete search budget.",
            "Narrow the query or select exact IDs.",
        ));
    }
    let rows = page_result.rows;
    let mut out = vec![];
    for row in rows {
        let candidate = issue_value(&row, project_id)?;
        if candidate.state != "closed" {
            out.push(candidate);
        }
    }
    let (history, history_diagnostics) = match history(reader, repo, project_id, query).await {
        Ok(history) => (history, vec![]),
        Err(d) if d.code == Code::Cancelled => return Err(d),
        Err(d) => (vec![], vec![d]),
    };
    Ok(CandidateSearch {
        read: CandidateRead {
            issues: out,
            pagination: page_result.pagination,
        },
        history,
        history_diagnostics,
    })
}

async fn history(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    query: &str,
) -> Result<Vec<HistoryIssue>, Diagnostic> {
    // get reads one page. list_report would force per_page=100 and paginate.
    let value = reader
        .get(&format!(
            "{}/issues?state=closed&search={}&in=title&per_page=20",
            prefix(repo),
            encode(query)
        ))
        .await?;
    let rows = value.as_array().ok_or_else(malformed)?;
    if rows.len() > 20 {
        return Err(malformed());
    }
    rows.iter()
        .map(|row| {
            if row.get("pull_request").is_some() || id(row, "project_id")? != project_id {
                return Err(Diagnostic::new(
                    Code::IdentityMismatch,
                    "issue_history",
                    "The closed issue is not in the selected project.",
                    "Inspect same-project closed issues on the native platform.",
                ));
            }
            if text(row, "state")? != "closed" {
                return Err(malformed());
            }
            let url = match row.get("web_url") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) => Some(value.clone()),
                _ => return Err(malformed()),
            };
            Ok(HistoryIssue {
                id: id(row, "iid")?,
                title: text(row, "title")?,
                state: "closed".into(),
                state_reason: None,
                updated_at: text(row, "updated_at")?,
                url,
            })
        })
        .collect()
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
    if !crate::identity::valid_oid(&head)
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
    tag: &crate::declaration::Tag,
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

/// Native GET closes_issues, including server-recognized references from commits.
/// External trackers and cross-project rows cannot establish same-project IDs.
/// https://docs.gitlab.com/api/merge_requests/#list-issues-that-close-on-merge
pub(super) async fn closing_issues(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    request_id: u64,
) -> Result<Vec<u64>, Diagnostic> {
    let rows = reader
        .list(
            &format!("{}/closes_issues", request_route(repo, request_id)),
            None,
            10,
        )
        .await?;
    let mut ids = std::collections::BTreeSet::new();
    for row in rows {
        let project = row
            .get("project_id")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or_else(super::closing_malformed)?;
        let issue = row
            .get("iid")
            .and_then(Value::as_u64)
            .filter(|id| *id > 0)
            .ok_or_else(super::closing_malformed)?;
        if project != project_id {
            return Err(super::closing_identity());
        }
        if !ids.insert(issue) {
            return Err(super::closing_malformed());
        }
    }
    Ok(ids.into_iter().collect())
}
