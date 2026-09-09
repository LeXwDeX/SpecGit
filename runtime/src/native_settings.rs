//! Explicit native settings writes are separate from the read-only observer.
use crate::{
    diagnostic::{Code, Diagnostic, classify_failure},
    probe::{ForgeRead, ProjectFacts, encode},
    process::{Process, Request, resolve_executable},
    project::{Context, Provider},
};
use serde_json::json;
use std::path::Path;
#[derive(Debug, Clone, serde::Serialize)]
pub struct CleanupChange {
    pub requested: bool,
    pub changed: bool,
    pub observed: Option<bool>,
}
pub async fn configure_cleanup(
    process: &Process,
    cwd: &Path,
    context: &Context,
    reader: &ForgeRead,
    before: &ProjectFacts,
    requested: bool,
) -> Result<CleanupChange, Diagnostic> {
    let current = reader.project(&context.repository).await?;
    if current.id != before.id
        || current.default_branch != before.default_branch
        || current.native_source_cleanup != before.native_source_cleanup
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "native_settings",
            "Native project settings changed during inspection.",
            "Read the new settings before explicitly retrying.",
        ));
    }
    if current.native_source_cleanup == Some(requested) {
        return Ok(CleanupChange {
            requested,
            changed: false,
            observed: Some(requested),
        });
    }
    // Only this one boolean is representable: no default/protection/closure API.
    let (method, endpoint, body) = match context.repository.provider {
        Provider::Github => (
            "PATCH",
            format!("repos/{}", context.repository.path),
            json!({"delete_branch_on_merge":requested}),
        ),
        Provider::Gitlab => (
            "PUT",
            format!("projects/{}", encode(&context.repository.path)),
            json!({"remove_source_branch_after_merge":requested}),
        ),
    };
    let mut request = Request::new(
        resolve_executable(context.repository.provider.executable())?,
        cwd,
        "native_settings",
    )
    .args([
        "api",
        "--hostname",
        &context.repository.host,
        "--method",
        method,
        "--input",
        "-",
        &endpoint,
    ]);
    request.input = serde_json::to_vec(&body)
        .map_err(|_| Diagnostic::input("Cannot encode the selected setting."))?;
    let result = process.run(request).await?;
    if result.code != 0 {
        return Err(classify_failure("native_settings", &result.stderr));
    }
    let after = reader.project(&context.repository).await.map_err(|_| {
        Diagnostic::new(
            Code::MalformedResponse,
            "native_settings",
            "The settings write returned success but readback is unavailable.",
            "Inspect the native setting before retrying; the write may have applied.",
        )
    })?;
    if after.id != before.id
        || after.default_branch != before.default_branch
        || after.native_issue_closing != before.native_issue_closing
        || after.native_source_cleanup != Some(requested)
    {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "native_settings",
            "Native settings readback does not match the selected change and preserved fields.",
            "Inspect the native project; a write may have applied and no compensating write was attempted.",
        ));
    }
    Ok(CleanupChange {
        requested,
        changed: true,
        observed: after.native_source_cleanup,
    })
}
