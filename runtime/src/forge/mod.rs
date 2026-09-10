//! Native protocol boundary. Opaque observations retain full readback equality.
use crate::{
    delivery_model::{Check, PullRequest},
    diagnostic::Diagnostic,
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
