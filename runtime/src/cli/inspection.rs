//! Read-only diagnostics and offline project status.
use specgit::{
    diagnostic::Diagnostic,
    probe::{self, Capability, ForgeRead},
    process::Process,
    project::Provider,
    report::Report,
};
use std::path::{Path, PathBuf};

pub(super) struct DoctorOptions {
    pub provider: Option<Provider>,
    pub remote: Option<String>,
    pub api_host: Option<String>,
    pub account_only: bool,
    pub offline: bool,
    pub fix: bool,
    pub dry_run: bool,
}

pub(super) async fn doctor(process: Process, cwd: &Path, options: DoctorOptions) -> Report {
    use super::health::{self, Check};
    use serde_json::json;
    let DoctorOptions {
        provider,
        remote,
        api_host,
        account_only,
        offline,
        fix,
        dry_run,
    } = options;
    let source = match std::env::current_exe().and_then(|p| p.canonicalize()) {
        Ok(source) => source,
        Err(_) => {
            return Report::failure(
                "doctor",
                Diagnostic::input("The running CLI path is unavailable."),
            );
        }
    };
    let mut health = if account_only {
        None
    } else {
        Some(health::inspect(&process, cwd, &source).await)
    };
    let mut diagnostics = vec![];
    let local = if account_only {
        None
    } else {
        match LocalInspection::read(
            &process,
            cwd,
            remote.as_deref(),
            provider,
            api_host.as_deref(),
        )
        .await
        {
            Ok(local) => Some(local),
            Err(d) => {
                if let Some(health) = &mut health {
                    health
                        .checks
                        .push(Check::failed("local_context", d.clone()));
                }
                diagnostics.push(d);
                None
            }
        }
    };
    let provider = provider
        .or_else(|| local.as_ref().map(|l| l.context.repository.provider))
        .or_else(|| {
            health
                .as_ref()
                .and_then(|h| h.declaration.as_ref().and_then(|d| d.provider))
        });
    if let Some(health) = &mut health {
        health.checks.push(Check::fact(
            "runtime",
            "current",
            json!({"executable":source,"version":env!("CARGO_PKG_VERSION")}),
        ));
        for name in std::iter::once("git").chain(provider.map(Provider::executable)) {
            match specgit::process::resolve_executable(name) {
                Ok(path) => health.checks.push(Check::fact(
                    if name == "git" {
                        "git_executable"
                    } else {
                        "forge_executable"
                    },
                    "current",
                    json!({"executable":path,"behavior":"not_checked"}),
                )),
                Err(d) => health.checks.push(Check::failed(
                    if name == "git" {
                        "git_executable"
                    } else {
                        "forge_executable"
                    },
                    d,
                )),
            }
        }
        if provider.is_none() {
            health.checks.push(Check::fact(
                "platform",
                "not_checked",
                json!({"reason":"Select a provider or an unambiguous supported remote."}),
            ));
        }
    }
    let mut probes = vec![];
    let mut write_permissions = json!("not_checked");
    let mut environment = None;
    if !offline && let Some(provider) = provider {
        probes = probe::commands(&process, cwd, provider).await;
        let context = local.as_ref().map(|local| &local.context);
        let host = context
            .map(|c| c.repository.host.as_str())
            .or(api_host.as_deref())
            .unwrap_or(match provider {
                Provider::Github => "github.com",
                Provider::Gitlab => "gitlab.com",
            });
        // Invalid local identity/configuration must not silently route to a guessed account.
        if account_only || context.is_some() {
            match ForgeRead::new(process.clone(), cwd, provider, host) {
                Ok(reader) => {
                    probes.push(probe::account(&reader).await);
                    probes.push(if let Some(context) = context {
                        probe::inspect(&reader, context).await
                    } else {
                        probe::Probe::not_checked("project_api")
                    });
                    if let Some(context) = context {
                        write_permissions = probes
                            .last()
                            .and_then(|p| p.evidence.get("write_permissions"))
                            .cloned()
                            .unwrap_or_else(|| {
                                json!(specgit::forge::capabilities::write_permissions(
                                    &context.repository,
                                    None
                                ))
                            });
                    }
                    if let Some(account) = probes
                        .iter_mut()
                        .find(|p| p.operation == "account_api" && p.status == Capability::Available)
                    {
                        account.evidence["write_permissions"] = write_permissions.clone();
                    }
                    environment = probe::environment(&reader).await;
                }
                Err(d) => diagnostics.push(d),
            }
        } else {
            probes.extend([
                probe::Probe::not_checked("account_api"),
                probe::Probe::not_checked("project_api"),
            ]);
        }
    } else {
        probes.extend([
            probe::Probe::not_checked("account_api"),
            probe::Probe::not_checked("project_api"),
        ]);
    }
    let failed_probes = probes
        .iter()
        .any(|p| !matches!(p.status, Capability::Available | Capability::NotChecked));
    if let Some(health) = &mut health {
        for probe in &probes {
            if let Some(d) = &probe.diagnostic {
                health
                    .checks
                    .push(Check::failed("platform_probe", d.clone()));
            }
        }
    }
    // A repair can write project assets, so reject repository-location
    // overrides before any plan can be applied. Read-only doctor keeps Git's
    // environment semantics for its probes.
    let repository_environment = if fix && !account_only {
        specgit::project::require_local_repository_environment().err()
    } else {
        None
    };
    if let (Some(health), Some(diagnostic)) = (&mut health, repository_environment.clone())
        && !health
            .checks
            .iter()
            .any(|check| check.id == "project_environment")
    {
        health
            .checks
            .push(Check::failed("project_environment", diagnostic));
    }
    let before = health.as_ref().map(|h| h.summary());
    let plans = health
        .as_ref()
        .map(|h| h.preview())
        .unwrap_or_else(|| json!([]));
    let results = if fix && !dry_run {
        match &mut health {
            // Incomplete inspection cannot establish the prerequisites for any write.
            Some(health) if health.status() != "unknown" => health.apply(&process, &source).await,
            _ => vec![],
        }
    } else {
        vec![]
    };
    let failed_repairs = results
        .iter()
        .any(|r| matches!(r.status, "failed" | "skipped"));
    let recheck = if fix && !dry_run {
        let mut checked = health::inspect(&process, cwd, &source).await;
        // A repair verifies static assets only. Preserve unresolved identity/probe evidence.
        if let Some(previous) = &health {
            checked.checks.extend(
                previous
                    .checks
                    .iter()
                    .filter(|c| {
                        matches!(
                            c.id,
                            "local_context"
                                | "platform_probe"
                                | "runtime"
                                | "git_executable"
                                | "forge_executable"
                                | "platform"
                        )
                    })
                    .cloned(),
            );
        }
        let summary = checked.summary();
        health = Some(checked);
        Some(summary)
    } else {
        None
    };
    // Recheck replaces the inspection, so restore the environment blocker
    // before diagnostics and the final summary are built.
    if let (Some(health), Some(diagnostic)) = (&mut health, repository_environment)
        && !health
            .checks
            .iter()
            .any(|check| check.id == "project_environment")
    {
        health
            .checks
            .push(Check::failed("project_environment", diagnostic));
    }
    if let Some(health) = &mut health {
        for result in &results {
            if let Some(diagnostic) = &result.diagnostic {
                let id = match result.id {
                    "setup" => "setup_repair",
                    "guidance" => "guidance_repair",
                    _ => "guard_repair",
                };
                health.checks.push(Check::failed(id, diagnostic.clone()));
            }
        }
        diagnostics.extend(health.diagnostics());
    }
    // Preserve diagnostic precedence: cancellation, invalid input, failed operation, unknown facts.
    let exit = if diagnostics.iter().any(|d| d.exit() == 130) {
        130
    } else if diagnostics.iter().any(|d| d.exit() == 2) {
        2
    } else if failed_repairs || diagnostics.iter().any(|d| d.exit() == 1) {
        1
    } else if failed_probes
        || !diagnostics.is_empty()
        || health.as_ref().is_some_and(|h| h.status() == "unknown")
    {
        3
    } else {
        0
    };
    let status = if failed_repairs {
        "repair_failed"
    } else if exit != 0 {
        "unknown"
    } else if local.as_ref().is_some_and(LocalInspection::branch_mismatch) {
        "checkpoint_branch_mismatch"
    } else if health.as_ref().is_some_and(|h| h.status() == "attention") {
        "attention_required"
    } else if offline {
        "offline_checked"
    } else {
        "ready"
    };
    let root = health
        .as_ref()
        .and_then(|h| h.root.as_deref())
        .unwrap_or(cwd);
    let agent_guidance = health::guidance(
        health.as_ref().map_or(&[], |h| h.checks.as_slice()),
        root,
        &source,
    );
    let runtime_update = specgit::self_update::check_latest(&process, cwd, offline).await;
    let mut report = Report::success(
        "doctor",
        status,
        json!({"runtime_update":runtime_update,"probes":probes,"write_permissions":write_permissions,"environment":environment,"local":local.as_ref().map(LocalInspection::summary).unwrap_or_else(local_not_checked),"health":health.as_ref().map(|h|h.summary()).unwrap_or_else(||json!({"scope":"account_only","status":"not_checked","checks":[],"host_behavior":"not_verified"})),"repair":{"requested":fix,"dry_run":dry_run,"plans":plans,"results":results,"before":before,"recheck":recheck},"agent_guidance":agent_guidance}),
    );
    if !account_only
        && local.is_none()
        && let Some(evidence) = report.evidence.as_object_mut()
    {
        evidence.remove("local");
    }
    if runtime_update.status == specgit::self_update::RuntimeUpdateStatus::UpdateAvailable {
        report.next_actions.push(json!({
            "kind":"consider_runtime_update",
            "remedy":format!("SpecGit {} is available (running {}). The Agent or user may choose to run `specgit update` within existing authorization; doctor never upgrades the runtime.", runtime_update.latest_version.as_deref().unwrap_or("unknown"), runtime_update.current_version)
        }));
    }
    report.exit = exit;
    let mut effects = specgit::report::Effects::default();
    for result in results.iter().filter(|result| result.status != "skipped") {
        let index = effects.begin(
            "local",
            result.id,
            json!({"transaction":result.transaction,"diagnostic":result.diagnostic}),
        );
        if result.status == "applied" {
            effects.applied(index);
        }
    }
    report.effects = Some(effects);
    for d in diagnostics {
        if !report.diagnostics.contains(&d) {
            report.diagnostics.push(d);
        }
    }
    if let Some(local) = &local {
        local.add_next_actions(&mut report);
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
        // Remove only Git's output delimiter; Unix directory names can end in a newline.
        let root = root.strip_suffix('\n').unwrap_or(&root);
        #[cfg(windows)]
        let root = root.strip_suffix('\r').unwrap_or(root);
        let root = PathBuf::from(root);
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
