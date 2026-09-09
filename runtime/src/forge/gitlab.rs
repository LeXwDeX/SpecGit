use crate::{
    delivery_model::{Mode, PullRequest, Strategy},
    diagnostic::{Code, Diagnostic},
    native_delivery::{self, prefix},
    probe::ForgeRead,
    project::Repository,
};
use serde_json::{Value, json};
pub(super) fn request_route(repo: &Repository, id: u64) -> String {
    format!("{}/merge_requests/{id}", prefix(repo))
}
pub(super) fn branches_route(repo: &Repository) -> String {
    format!("{}/repository/branches", prefix(repo))
}
pub(super) fn associations_route(repo: &Repository, commit: &str) -> String {
    format!(
        "{}/repository/commits/{commit}/merge_requests",
        prefix(repo)
    )
}
pub(super) fn queued(raw: &Value) -> bool {
    raw.get("merge_when_pipeline_succeeds")
        .and_then(Value::as_bool)
        == Some(true)
}
#[derive(PartialEq, Eq)]
pub struct Capability(Value);
fn unknown(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::UnsupportedOperation,
        "merge",
        message,
        "Inspect the exact request in the native forge. No fallback merge, issue closure or branch deletion was attempted.",
    )
}
pub async fn capability(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    r: &PullRequest,
    mode: Mode,
    strategy: Strategy,
) -> Result<Capability, Diagnostic> {
    if strategy == Strategy::Rebase {
        return Err(unknown(
            "GitLab rebase changes the assessed head and is not delegated by merge.",
        ));
    }
    let project = reader.get(&native_delivery::prefix(repo)).await?;
    let raw = reader.get(&request_route(repo, r.id)).await?;
    if project.get("id").and_then(Value::as_u64) != Some(project_id)
        || project.get("merge_trains_enabled").and_then(Value::as_bool) != Some(false)
    {
        return Err(unknown(
            "GitLab merge-train routing is enabled or cannot be proven disabled.",
        ));
    }
    // glab omits API Squash when its bool flag is false, even if explicitly set.
    // A project-enforced 'never' policy is the only qualified no-squash path.
    let squash = project.get("squash_option").and_then(Value::as_str);
    if (strategy == Strategy::Merge && squash != Some("never"))
        || (strategy == Strategy::Squash
            && !matches!(squash, Some("always" | "default_on" | "default_off")))
    {
        return Err(unknown(
            "The native GitLab squash policy cannot enforce the requested strategy through glab.",
        ));
    }
    // glab consumes legacy `pipeline` separately from `head_pipeline`; it
    // silently omits AutoMerge when that legacy field is absent.
    if mode == Mode::Auto
        && (["head_pipeline", "pipeline"].iter().any(|field| {
            let pipeline = &raw[field];
            !pipeline.is_object()
                || pipeline
                    .get("id")
                    .and_then(Value::as_u64)
                    .is_none_or(|id| id == 0)
                || pipeline.get("sha").and_then(Value::as_str) != Some(&r.head)
        }) || raw["head_pipeline"]["id"] != raw["pipeline"]["id"])
    {
        return Err(unknown(
            "GitLab auto-merge requires a confirmed current-head pipeline; glab otherwise submits an immediate merge.",
        ));
    }
    if native_delivery::request_value(&raw, repo, r.id)? != *r {
        return Err(unknown(
            "The native request changed during merge capability qualification.",
        ));
    }
    Ok(Capability(
        json!({"squash_option":squash,"merge_trains_enabled":false,"head_pipeline":raw.get("head_pipeline"),"pipeline":raw.get("pipeline")}),
    ))
}
