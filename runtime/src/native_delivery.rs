//! Delivery operations dispatch to concrete native protocols; observers receive only ForgeRead.
pub use crate::delivery_model::{Issue, PullRequest};
use crate::{
    diagnostic::Diagnostic,
    forge::{github, gitlab, protocol::WriteTransport},
    probe::ForgeRead,
    process::Process,
    project::{Provider, Repository},
};
use serde_json::Value;
use std::path::Path;
pub fn prefix(repo: &Repository) -> String {
    match repo.provider {
        Provider::Github => github::prefix(repo),
        Provider::Gitlab => gitlab::prefix(repo),
    }
}
pub async fn issue(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    number: u64,
) -> Result<Issue, Diagnostic> {
    match repo.provider {
        Provider::Github => github::issue(reader, repo, project_id, number).await,
        Provider::Gitlab => gitlab::issue(reader, repo, project_id, number).await,
    }
}
pub async fn candidates(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    query: &str,
) -> Result<Vec<Issue>, Diagnostic> {
    match repo.provider {
        Provider::Github => github::candidates(reader, repo, project_id, query).await,
        Provider::Gitlab => gitlab::candidates(reader, repo, project_id, query).await,
    }
}
pub async fn label_pool(reader: &ForgeRead, repo: &Repository) -> Result<Vec<String>, Diagnostic> {
    match repo.provider {
        Provider::Github => github::label_pool(reader, repo).await,
        Provider::Gitlab => gitlab::label_pool(reader, repo).await,
    }
}
pub async fn pull_request(
    reader: &ForgeRead,
    repo: &Repository,
    number: u64,
) -> Result<PullRequest, Diagnostic> {
    match repo.provider {
        Provider::Github => github::pull_request(reader, repo, number).await,
        Provider::Gitlab => gitlab::pull_request(reader, repo, number).await,
    }
}
pub fn request_value(v: &Value, repo: &Repository, number: u64) -> Result<PullRequest, Diagnostic> {
    match repo.provider {
        Provider::Github => github::request_value(v, number),
        Provider::Gitlab => gitlab::request_value(v, number),
    }
}
pub async fn request_candidates(
    reader: &ForgeRead,
    repo: &Repository,
    source: &str,
) -> Result<Vec<PullRequest>, Diagnostic> {
    match repo.provider {
        Provider::Github => github::request_candidates(reader, repo, source).await,
        Provider::Gitlab => gitlab::request_candidates(reader, repo, source).await,
    }
}
pub async fn branch_head(
    reader: &ForgeRead,
    repo: &Repository,
    branch: &str,
) -> Result<String, Diagnostic> {
    match repo.provider {
        Provider::Github => github::branch_head(reader, repo, branch).await,
        Provider::Gitlab => gitlab::branch_head(reader, repo, branch).await,
    }
}
pub async fn has_changes(
    reader: &ForgeRead,
    repo: &Repository,
    base: &str,
    head: &str,
) -> Result<bool, Diagnostic> {
    match repo.provider {
        Provider::Github => github::has_changes(reader, repo, base, head).await,
        Provider::Gitlab => gitlab::has_changes(reader, repo, base, head).await,
    }
}
/// Created only for explicit issue/PR operations, never passed into observation or hooks.
pub struct ForgeWrite {
    transport: WriteTransport,
    provider: Provider,
}
impl ForgeWrite {
    pub fn new(process: Process, cwd: &Path, repo: &Repository) -> Result<Self, Diagnostic> {
        Ok(Self {
            transport: WriteTransport::new(process, cwd, repo)?,
            provider: repo.provider,
        })
    }
    pub async fn update_request_body(&self, number: u64, body: &str) -> Result<(), Diagnostic> {
        match self.provider {
            Provider::Github => github::update_request_body(&self.transport, number, body).await,
            Provider::Gitlab => gitlab::update_request_body(&self.transport, number, body).await,
        }
    }
    pub async fn add_request_labels(
        &self,
        number: u64,
        labels: &[String],
    ) -> Result<(), Diagnostic> {
        match self.provider {
            Provider::Github => github::add_request_labels(&self.transport, number, labels).await,
            Provider::Gitlab => gitlab::add_request_labels(&self.transport, number, labels).await,
        }
    }
    pub async fn ready(&self, number: u64) -> Result<(), Diagnostic> {
        match self.provider {
            Provider::Github => github::ready(&self.transport, number).await,
            Provider::Gitlab => gitlab::ready(&self.transport, number).await,
        }
    }
    pub async fn create_label(&self, tag: &crate::config::Tag) -> Result<(), Diagnostic> {
        match self.provider {
            Provider::Github => github::create_label(&self.transport, tag).await,
            Provider::Gitlab => gitlab::create_label(&self.transport, tag).await,
        }
    }
    pub async fn create_issue(
        &self,
        title: &str,
        body: &str,
        labels: &[String],
    ) -> Result<u64, Diagnostic> {
        match self.provider {
            Provider::Github => github::create_issue(&self.transport, title, body, labels).await,
            Provider::Gitlab => gitlab::create_issue(&self.transport, title, body, labels).await,
        }
    }
    pub async fn create_request(
        &self,
        source: &str,
        target: &str,
        title: &str,
        body: &str,
    ) -> Result<u64, Diagnostic> {
        match self.provider {
            Provider::Github => {
                github::create_request(&self.transport, source, target, title, body).await
            }
            Provider::Gitlab => {
                gitlab::create_request(&self.transport, source, target, title, body).await
            }
        }
    }
}
