//! Native protocol boundary. Opaque observations retain full readback equality.
use crate::{
    delivery_model::{Check, PullRequest},
    diagnostic::Diagnostic,
    native_checks, native_delivery, native_requirements,
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
    pub fn queued(&self) -> bool {
        match self.provider {
            Provider::Github => github::queued(&self.raw),
            Provider::Gitlab => gitlab::queued(&self.raw),
        }
    }
    pub fn anchors(&self) -> Vec<&str> {
        ["squash_commit_sha", "merge_commit_sha"]
            .into_iter()
            .filter_map(|key| self.raw[key].as_str())
            .filter(|s| crate::native_file::object_id(s))
            .collect()
    }
    pub fn is_squash_anchor(&self, anchor: &str) -> bool {
        self.raw["squash_commit_sha"].as_str() == Some(anchor)
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
pub async fn requirements(
    reader: &ForgeRead,
    repo: &Repository,
    r: &RequestObservation,
) -> Result<native_requirements::Observation, Diagnostic> {
    native_requirements::read(reader, repo, &r.facts, &r.raw).await
}
pub use crate::delivery_model::SourceCleanup;
pub async fn source_cleanup(
    reader: &ForgeRead,
    repo: &Repository,
    source: &str,
) -> Result<SourceCleanup, Diagnostic> {
    let route = match repo.provider {
        Provider::Github => github::branches_route(repo),
        Provider::Gitlab => gitlab::branches_route(repo),
    };
    let rows = match reader.list(&route, None, 10).await {
        Ok(rows) => rows,
        Err(_) => return Ok(SourceCleanup::Unknown),
    };
    let mut names = std::collections::BTreeSet::new();
    for row in &rows {
        if !names.insert(native_checks::text(row, "name")?) {
            return Err(native_checks::malformed());
        }
    }
    Ok(if names.contains(source) {
        SourceCleanup::Present
    } else {
        SourceCleanup::Deleted
    })
}
#[derive(PartialEq, Eq)]
pub struct Associations {
    pub requests: Vec<u64>,
    raw: Vec<Value>,
}
pub async fn associations(
    reader: &ForgeRead,
    repo: &Repository,
    commit: &str,
) -> Result<Associations, Diagnostic> {
    let (route, key) = match repo.provider {
        Provider::Github => (github::associations_route(repo, commit), "number"),
        Provider::Gitlab => (gitlab::associations_route(repo, commit), "iid"),
    };
    let raw = reader.list(&route, None, 2).await?;
    let requests = raw
        .iter()
        .map(|r| native_checks::number(r, key))
        .collect::<Result<_, _>>()?;
    Ok(Associations { requests, raw })
}
