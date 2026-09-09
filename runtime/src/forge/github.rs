use crate::{native_delivery::prefix, project::Repository};
use serde_json::Value;
pub(super) fn request_route(repo: &Repository, id: u64) -> String {
    format!("{}/pulls/{id}", prefix(repo))
}
pub(super) fn branches_route(repo: &Repository) -> String {
    format!("{}/branches", prefix(repo))
}
pub(super) fn associations_route(repo: &Repository, commit: &str) -> String {
    format!("{}/commits/{commit}/pulls", prefix(repo))
}
pub(super) fn queued(raw: &Value) -> bool {
    raw.get("auto_merge").is_some_and(|v| {
        v.is_object()
            && v.get("merge_method")
                .and_then(Value::as_str)
                .is_some_and(|s| ["merge", "squash", "rebase"].contains(&s))
            && v.pointer("/enabled_by/id")
                .and_then(Value::as_u64)
                .is_some_and(|id| id > 0)
    })
}
