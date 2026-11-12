//! Native protocol boundary. Opaque observations retain full readback equality.
use crate::{
    delivery_model::{Check, Issue, PullRequest},
    diagnostic::{Code, Diagnostic},
    forge_read::ForgeRead,
    identity::{Provider, Repository},
    native_checks,
};
use serde_json::Value;
pub mod github;
pub mod gitlab;
#[derive(Debug, PartialEq, Eq)]
pub struct RequestObservation {
    pub facts: PullRequest,
    raw: Value,
    provider: Provider,
}
impl RequestObservation {
    pub fn auto_merge(&self) -> crate::delivery_model::AutoMerge {
        match self.provider {
            Provider::Github => github::auto_merge(&self.raw),
            Provider::Gitlab => gitlab::auto_merge(&self.raw),
        }
    }
}
fn route(repo: &Repository, id: u64) -> String {
    match repo.provider {
        Provider::Github => github::request_route(repo, id),
        Provider::Gitlab => gitlab::request_route(repo, id),
    }
}
pub async fn request(
    reader: &ForgeRead,
    repo: &Repository,
    id: u64,
) -> Result<RequestObservation, Diagnostic> {
    let raw = reader.get(&route(repo, id)).await?;
    Ok(RequestObservation {
        facts: match repo.provider {
            Provider::Github => github::request_value(&raw, id)?,
            Provider::Gitlab => gitlab::request_value(&raw, id)?,
        },
        raw,
        provider: repo.provider,
    })
}
pub async fn unchanged(
    reader: &ForgeRead,
    repo: &Repository,
    observed: &RequestObservation,
) -> Result<bool, Diagnostic> {
    Ok(reader.get(&route(repo, observed.facts.id)).await? == observed.raw)
}
pub async fn checks(
    reader: &ForgeRead,
    repo: &Repository,
    r: &RequestObservation,
) -> Result<Vec<Check>, Diagnostic> {
    match repo.provider {
        Provider::Github => native_checks::github(reader, repo, &r.facts.head).await,
        Provider::Gitlab => native_checks::gitlab(reader, &r.raw, &r.facts.head).await,
    }
}
pub mod capabilities;
pub(crate) mod protocol;

/// Complete same-project native closing references. An empty result is distinct
/// from unavailable evidence; no body or local-selection fallback is performed.
/// This is the ID projection of `closing_issue_facts`, so a set that embeds an
/// Issue whose facts cannot be decoded is an error here too.
pub async fn closing_issues(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    request_id: u64,
) -> Result<Vec<u64>, Diagnostic> {
    Ok(closing_issue_facts(reader, repo, project_id, request_id)
        .await?
        .into_iter()
        .map(|(issue, _)| issue.id)
        .collect())
}

/// The complete native closing set together with the Issue facts and provider
/// close reason that the same bounded read returns, in ascending Issue order.
/// These are the facts an exact per-Issue read would build, so the Issues of
/// the set need no read of their own. Facts that cannot be decoded fail closed.
pub async fn closing_issue_facts(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    request_id: u64,
) -> Result<Vec<(Issue, Option<String>)>, Diagnostic> {
    match closing_read(reader, repo, project_id, request_id).await? {
        ClosingRead::Complete(facts) => Ok(facts),
        ClosingRead::Unavailable(unavailable) => Err(unavailable),
    }
}

/// Outcome of the native closing read, split by what the failure proves.
pub(crate) enum ClosingRead {
    /// The complete set, with the facts of every Issue in it.
    Complete(Vec<(Issue, Option<String>)>),
    /// The set could not be established (permission, transport, unsupported
    /// operation, incomplete pages, identity). This is diagnostic evidence only
    /// and never an empty set.
    Unavailable(Diagnostic),
}

/// `Err` is reserved for a complete set that embeds an unreadable Issue. A
/// separate Issue read failed the whole observation in that case, so it still
/// does; callers must not downgrade it to an unavailable set.
pub(crate) async fn closing_read(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    request_id: u64,
) -> Result<ClosingRead, Diagnostic> {
    let rows = match closing_rows(reader, repo, project_id, request_id).await {
        Ok(rows) => rows,
        Err(unavailable) => return Ok(ClosingRead::Unavailable(unavailable)),
    };
    // Decode only after the whole set is proven complete and same-project.
    let facts = rows
        .iter()
        .map(|row| match repo.provider {
            Provider::Github => github::closing_fact(row),
            Provider::Gitlab => gitlab::closing_fact(row, project_id),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ClosingRead::Complete(facts))
}

/// Raw native rows of a complete, duplicate-free, same-project set by Issue ID.
async fn closing_rows(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    request_id: u64,
) -> Result<Vec<Value>, Diagnostic> {
    if project_id == 0 || request_id == 0 {
        return Err(Diagnostic::input(
            "Positive native project and request IDs are required.",
        ));
    }
    if reader.provider != repo.provider || reader.host != repo.host {
        return Err(closing_identity());
    }
    match repo.provider {
        Provider::Github => github::closing_nodes(reader, repo, project_id, request_id).await,
        Provider::Gitlab => gitlab::closing_rows(reader, repo, project_id, request_id).await,
    }
}
pub(super) fn closing_identity() -> Diagnostic {
    Diagnostic::new(
        Code::IdentityMismatch,
        "closing_issues",
        "Native closing references do not match the selected project or request.",
        "Inspect the exact native association identities; never adopt a same-number issue from another project.",
    )
}
pub(super) fn closing_malformed() -> Diagnostic {
    Diagnostic::new(
        Code::MalformedResponse,
        "closing_issues",
        "Native closing-reference evidence is missing, malformed or incomplete.",
        "Inspect the native association API; unknown is not an empty closing-reference set.",
    )
}
pub(super) fn closing_limit() -> Diagnostic {
    Diagnostic::new(
        Code::OutputLimit,
        "closing_issues",
        "Native closing references exceed the complete read budget.",
        "Inspect the remaining native associations; this partial response does not establish the complete set.",
    )
}
