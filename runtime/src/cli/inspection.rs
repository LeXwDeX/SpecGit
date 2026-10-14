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
    let local = if account_only {
        None
    } else {
        match LocalInspection::read(
            &process,
            cwd,
            remote.as_deref(),
            Some(provider),
            api_host.as_deref(),
        )
        .await
        {
            Ok(local) => Some(local),
            Err(d) => {
                let mut report = Report::failure("doctor", d);
                report.evidence =
                    serde_json::json!({"probes":probes,"write_permissions":"not_checked"});
                return report;
            }
        }
    };
    let context = local.as_ref().map(|local| &local.context);
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
    let write_permissions = if let Some(context) = &context {
        let project_probe = probes.last().expect("project probe was appended");
        project_probe
            .evidence
            .get("write_permissions")
            .cloned()
            .unwrap_or_else(|| {
                serde_json::to_value(specgit::forge::capabilities::write_permissions(
                    &context.repository,
                    None,
                ))
                .expect("permissions serialize")
            })
    } else {
        serde_json::json!("not_checked")
    };
    if let Some(account) = probes
        .iter_mut()
        .find(|probe| probe.operation == "account_api" && probe.status == Capability::Available)
    {
        account.evidence["write_permissions"] = write_permissions.clone();
    }
    let failed = probes
        .iter()
        .any(|p| !matches!(p.status, Capability::Available | Capability::NotChecked));
    let environment = probe::environment(&reader).await;
    let mut report = Report::success(
        "doctor",
        if failed {
            "unknown"
        } else if local.as_ref().is_some_and(LocalInspection::branch_mismatch) {
            "checkpoint_branch_mismatch"
        } else {
            "ready"
        },
        serde_json::json!({"probes":probes,"write_permissions":write_permissions,"environment":environment,"local":local.as_ref().map(LocalInspection::summary).unwrap_or_else(local_not_checked)}),
    );
    if let Some(local) = &local {
        local.add_next_actions(&mut report);
    }
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
    let local = match LocalInspection::read(&process, cwd, remote.as_deref(), provider, None).await
    {
        Ok(local) => local,
        Err(d) => return Report::failure("status", d),
    };
    let mut report = match &local.selection {
        specgit::selection::ReadOutcome::BranchMismatch { checkpoint, .. } => Report::success(
            "status",
            "checkpoint_branch_mismatch",
            serde_json::json!({"context":local.context,"declaration":local.declaration,"selection":null,"checkpoint":checkpoint,"write_eligible":false,"remote_state":"not_checked"}),
        ),
        selection => {
            let selection = match selection {
                specgit::selection::ReadOutcome::Current(selection) => Some(selection),
                _ => None,
            };
            Report::success(
                "status",
                local.status(),
                serde_json::json!({"context":local.context,"declaration":local.declaration,"selection":selection,"remote_state":"not_checked"}),
            )
        }
    };
    local.add_next_actions(&mut report);
    report
}

/// Shared typed local reads; neither command consumes the other's JSON report.
struct LocalInspection {
    context: specgit::project::Context,
    declaration: Option<specgit::config::Declaration>,
    selection: specgit::selection::ReadOutcome,
}

impl LocalInspection {
    async fn read(
        process: &Process,
        cwd: &Path,
        remote: Option<&str>,
        provider: Option<Provider>,
        api_host: Option<&str>,
    ) -> Result<Self, Diagnostic> {
        let bytes = specgit::project::git(process, cwd, &["rev-parse", "--show-toplevel"]).await?;
        let root = String::from_utf8(bytes).map_err(|_| Diagnostic::input("Invalid Git root."))?;
        let root = PathBuf::from(root.trim_end_matches(['\r', '\n']));
        let declaration = specgit::config::read(&root)?;
        let remote = remote.or_else(|| declaration.as_ref().and_then(|d| d.remote.as_deref()));
        let provider = provider.or_else(|| declaration.as_ref().and_then(|d| d.provider));
        let context = specgit::config::resolve(process, &root, remote, provider, api_host).await?;
        let selection = specgit::selection::classify(&context)?;
        Ok(Self {
            context,
            declaration,
            selection,
        })
    }

    fn branch_mismatch(&self) -> bool {
        matches!(
            self.selection,
            specgit::selection::ReadOutcome::BranchMismatch { .. }
        )
    }

    fn status(&self) -> &'static str {
        if self.branch_mismatch() {
            "checkpoint_branch_mismatch"
        } else if self.declaration.is_some() {
            "initialized"
        } else {
            "uninitialized"
        }
    }

    fn summary(&self) -> serde_json::Value {
        let checkpoint = match &self.selection {
            specgit::selection::ReadOutcome::Absent => serde_json::json!({"status":"absent"}),
            specgit::selection::ReadOutcome::Current(selection) => serde_json::json!({
                "status":"current", "recorded_branch":selection.branch,
                "recorded_target":selection.target, "issues":selection.issues, "request":selection.request
            }),
            specgit::selection::ReadOutcome::BranchMismatch { checkpoint, .. } => {
                serde_json::to_value(checkpoint).expect("checkpoint metadata serializes")
            }
        };
        serde_json::json!({
            "status":self.status(), "context":self.context,
            "target":self.declaration.as_ref().and_then(|d| d.target.as_deref()),
            "checkpoint":checkpoint, "remote_state":"not_checked"
        })
    }

    fn add_next_actions(&self, report: &mut Report) {
        if let specgit::selection::ReadOutcome::BranchMismatch { checkpoint, .. } = &self.selection
        {
            report.next_actions.push(serde_json::json!({"kind":"return_to_checkpoint_branch","branch":checkpoint.recorded_branch,"remedy":"Return to the recorded branch to resume this checkpoint."}));
            report.next_actions.push(serde_json::json!({"kind":"use_independent_worktree","remedy":"Use a separate worktree for an independent delivery; do not move or discard this checkpoint."}));
        }
    }
}

fn local_not_checked() -> serde_json::Value {
    serde_json::json!({"status":"not_checked","context":null,"target":null,"checkpoint":{"status":"not_checked"},"remote_state":"not_checked"})
}
