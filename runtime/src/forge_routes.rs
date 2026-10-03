//! Pure provider-specific native API route construction.
use crate::identity::{Provider, Repository};

pub fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
pub(crate) fn github_prefix(repo: &Repository) -> String {
    format!("repos/{}", repo.path)
}

pub(crate) fn gitlab_prefix(repo: &Repository) -> String {
    format!("projects/{}", encode(&repo.path))
}

pub fn prefix(repo: &Repository) -> String {
    match repo.provider {
        Provider::Github => github_prefix(repo),
        Provider::Gitlab => gitlab_prefix(repo),
    }
}
