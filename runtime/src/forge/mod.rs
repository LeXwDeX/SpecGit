//! Native protocol boundary. Opaque observations retain full readback equality.
use crate::{
    delivery_model::{Check, PullRequest},
    diagnostic::{Code, Diagnostic},
    native_checks, native_delivery,
    probe::ForgeRead,
    project::{Provider, Repository},
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
        facts: native_delivery::request_value(&raw, repo, id)?,
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
pub async fn closing_issues(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    request_id: u64,
) -> Result<Vec<u64>, Diagnostic> {
    if project_id == 0 || request_id == 0 {
        return Err(Diagnostic::input(
            "Positive native project and request IDs are required.",
        ));
    }
    if reader.provider != repo.provider || reader.host != repo.host {
        return Err(closing_identity());
    }
    match repo.provider {
        Provider::Github => github::closing_issues(reader, repo, project_id, request_id).await,
        Provider::Gitlab => gitlab::closing_issues(reader, repo, project_id, request_id).await,
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
