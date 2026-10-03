//! Read-only diagnostics and offline project status.
use specgit::{
    diagnostic::Diagnostic,
    probe::{self, Capability, ForgeRead},
    process::Process,
    project::Provider,
    report::Report,
};
use std::path::{Path, PathBuf};

pub(super) async fn doctor(
    process: Process,
    cwd: &Path,
    provider: Provider,
    remote: Option<String>,
    api_host: Option<String>,
    account_only: bool,
) -> Report {
    let mut probes = probe::commands(&process, cwd, provider).await;
    let context = if account_only {
        None
    } else {
        match specgit::project::resolve(
            &process,
            cwd,
            remote.as_deref(),
            Some(provider),
            api_host.as_deref(),
        )
        .await
        {
            Ok(context) => Some(context),
            Err(d) => {
                let mut report = Report::failure("doctor", d);
                report.evidence =
                    serde_json::json!({"probes":probes,"write_permissions":"not_checked"});
                return report;
            }
        }
    };
    let host = context
        .as_ref()
        .map(|c| c.repository.host.as_str())
        .or(api_host.as_deref())
        .unwrap_or(match provider {
            Provider::Github => "github.com",
            Provider::Gitlab => "gitlab.com",
        });
    let reader = match ForgeRead::new(process, cwd, provider, host) {
        Ok(r) => r,
        Err(d) => return Report::failure("doctor", d),
    };
    probes.push(probe::account(&reader).await);
    probes.push(if let Some(context) = &context {
        probe::inspect(&reader, context).await
    } else {
        probe::Probe::not_checked("project_api")
    });
    let failed = probes
        .iter()
        .any(|p| !matches!(p.status, Capability::Available | Capability::NotChecked));
    let mut report = Report::success(
        "doctor",
        if failed { "unknown" } else { "ready" },
        serde_json::json!({"probes":probes,"write_permissions":"not_checked"}),
    );
    if failed {
        report.exit = 3;
    }
    report
}

pub(super) async fn status(
    process: Process,
    cwd: &Path,
    remote: Option<String>,
    provider: Option<Provider>,
) -> Report {
    let root = match specgit::project::git(&process, cwd, &["rev-parse", "--show-toplevel"]).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => PathBuf::from(s.trim_end_matches(['\r', '\n'])),
            Err(_) => {
                return Report::failure("status", Diagnostic::input("Invalid Git root."));
            }
        },
        Err(d) => return Report::failure("status", d),
    };
    let declaration = match specgit::config::read(&root) {
        Ok(d) => d,
        Err(d) => return Report::failure("status", d),
    };
    let selected_remote = remote
        .as_deref()
        .or_else(|| declaration.as_ref().and_then(|d| d.remote.as_deref()));
    let selected_provider = provider.or_else(|| declaration.as_ref().and_then(|d| d.provider));
    match specgit::config::resolve(&process, &root, selected_remote, selected_provider, None).await
    {
        Ok(context) => {
            let selection = match specgit::selection::classify(&context) {
                Ok(specgit::selection::ReadOutcome::Absent) => None,
                Ok(specgit::selection::ReadOutcome::Current(current_selection)) => {
                    Some(current_selection)
                }
                Ok(specgit::selection::ReadOutcome::BranchMismatch { checkpoint, .. }) => {
                    let mut report = Report::success(
                        "status",
                        "checkpoint_branch_mismatch",
                        serde_json::json!({"context":context,"declaration":declaration,"selection":null,"checkpoint":checkpoint,"write_eligible":false,"remote_state":"not_checked"}),
                    );
                    report.next_actions.push(serde_json::json!({"kind":"return_to_checkpoint_branch","branch":checkpoint.recorded_branch,"remedy":"Return to the recorded branch to resume this checkpoint."}));
                    report.next_actions.push(serde_json::json!({"kind":"use_independent_worktree","remedy":"Use a separate worktree for an independent delivery; do not move or discard this checkpoint."}));
                    return report;
                }
                Err(d) => return Report::failure("status", d),
            };
            Report::success(
                "status",
                if declaration.is_some() {
                    "initialized"
                } else {
                    "uninitialized"
                },
                serde_json::json!({"context":context,"declaration":declaration,"selection":selection,"remote_state":"not_checked"}),
            )
        }
        Err(d) => Report::failure("status", d),
    }
}
