//! Static project checks and typed maintenance plans. No host hooks are run here.
use serde::Serialize;
use serde_json::{Value, json};
use specgit::{
    assets::{Applied, MaintenanceAsset, MaintenancePlan},
    config::{self, Declaration},
    diagnostic::{Code, Diagnostic},
    process::Process,
    project,
};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
pub(super) struct Check {
    pub id: &'static str,
    pub status: &'static str,
    pub severity: &'static str,
    pub repairable: bool,
    pub evidence: Value,
    pub diagnostic: Option<Diagnostic>,
}
impl Check {
    pub fn fact(id: &'static str, status: &'static str, evidence: Value) -> Self {
        Self {
            id,
            status,
            severity: if matches!(status, "needs_initialization" | "not_installed") {
                "warning"
            } else {
                "info"
            },
            repairable: false,
            evidence,
            diagnostic: None,
        }
    }
    pub fn failed(id: &'static str, diagnostic: Diagnostic) -> Self {
        Self {
            id,
            status: "unknown",
            severity: "error",
            repairable: false,
            evidence: Value::Null,
            diagnostic: Some(diagnostic),
        }
    }
}

pub(super) enum Plan {
    Assets(MaintenancePlan),
    Guard(specgit::guard::GuardHealthPlan),
}
impl Plan {
    pub fn assets(&self) -> Vec<MaintenanceAsset> {
        match self {
            Self::Assets(p) => p.assets(),
            Self::Guard(p) => p.assets(),
        }
    }
    fn depend_on_snapshot(&mut self, path: &Path, snapshot: &specgit::assets::Snapshot) {
        match self {
            Self::Assets(p) => p.depend_on_snapshot(path, snapshot),
            Self::Guard(p) => p.depend_on_snapshot(path, snapshot),
        }
    }
}

#[derive(Serialize)]
pub(super) struct RepairResult {
    pub id: &'static str,
    pub status: &'static str,
    pub transaction: Option<Applied>,
    pub diagnostic: Option<Diagnostic>,
}

pub(super) struct Inspection {
    pub checks: Vec<Check>,
    pub plans: Vec<(&'static str, Plan)>,
    pub root: Option<PathBuf>,
    private: Option<PathBuf>,
    pub declaration: Option<Declaration>,
    declaration_snapshot: Option<specgit::assets::Snapshot>,
}
impl Inspection {
    fn plan(&mut self, id: &'static str, result: Result<Option<Plan>, Diagnostic>) {
        match result {
            Ok(Some(mut plan)) => {
                // Every repair depends on the same declaration observed during planning.
                if let (Some(root), Some(snapshot)) = (&self.root, &self.declaration_snapshot) {
                    plan.depend_on_snapshot(&root.join(".specgit.yaml"), snapshot);
                }
                let assets = plan.assets();
                let repairable = !assets.is_empty();
                self.checks.push(Check {
                    id,
                    status: if repairable {
                        "change_required"
                    } else {
                        "current"
                    },
                    severity: if repairable { "warning" } else { "info" },
                    repairable,
                    evidence: json!({"assets":assets}),
                    diagnostic: None,
                });
                if repairable {
                    self.plans.push((id, plan));
                }
            }
            Ok(None) => self
                .checks
                .push(Check::fact(id, "not_selected", Value::Null)),
            Err(d) => self.checks.push(Check::failed(id, d)),
        }
    }
    pub fn status(&self) -> &'static str {
        if self.checks.iter().any(|c| c.status == "unknown") {
            "unknown"
        } else if self.checks.iter().any(|c| {
            matches!(
                c.status,
                "change_required" | "needs_initialization" | "not_installed"
            )
        }) {
            "attention"
        } else {
            "healthy"
        }
    }
    pub fn summary(&self) -> Value {
        json!({"scope":"project_static", "status":self.status(), "checks":self.checks, "host_behavior":"not_verified"})
    }
    pub fn preview(&self) -> Value {
        json!(
            self.plans
                .iter()
                .map(|(id, p)| json!({"id":id,"assets":p.assets()}))
                .collect::<Vec<_>>()
        )
    }
    pub fn diagnostics(&self) -> Vec<Diagnostic> {
        self.checks
            .iter()
            .filter_map(|c| c.diagnostic.clone())
            .collect()
    }
    pub async fn apply(&mut self, process: &Process, source: &Path) -> Vec<RepairResult> {
        let mut results = vec![];
        let mut prior = vec![];
        let mut failed = false;
        for (id, plan) in self.plans.drain(..) {
            if process.cancellation.is_cancelled() || failed {
                results.push(RepairResult {
                    id,
                    status: "skipped",
                    transaction: None,
                    diagnostic: Some(Diagnostic::new(
                        if process.cancellation.is_cancelled() {
                            Code::Cancelled
                        } else {
                            Code::ConcurrentEdit
                        },
                        "doctor",
                        "A prerequisite repair did not complete safely.",
                        "Inspect the results and recheck before resuming.",
                    )),
                });
                continue;
            }
            let mut committed = None;
            let outcome = match plan {
                Plan::Guard(plan) => plan.apply(process).await.map(|a| (a, None)),
                Plan::Assets(mut plan) => {
                    (async {
                        if !prior.is_empty() {
                            let baseline = plan.read_set();
                            let root = self
                                .root
                                .as_deref()
                                .ok_or_else(|| Diagnostic::input("Missing repair root."))?;
                            let private = self
                                .private
                                .as_deref()
                                .ok_or_else(|| Diagnostic::input("Missing repair state."))?;
                            plan = match id {
                                "setup" => {
                                    specgit::setup::project::health_plan_with_context(
                                        process,
                                        root,
                                        &private.join("agent-assets"),
                                        source,
                                    )
                                    .await?
                                }
                                "guidance" => specgit::guidance::health_plan(
                                    root,
                                    private,
                                    self.declaration.as_ref().ok_or_else(|| {
                                        Diagnostic::input("Missing repair declaration.")
                                    })?,
                                )?,
                                _ => return Err(Diagnostic::input("Unknown repair component.")),
                            }
                            .ok_or_else(|| {
                                Diagnostic::new(
                                    Code::ConcurrentEdit,
                                    "doctor",
                                    "The selected repair ownership disappeared.",
                                    "Recheck current state before continuing.",
                                )
                            })?;
                            if let Some(snapshot) = &self.declaration_snapshot {
                                plan.depend_on_snapshot(&root.join(".specgit.yaml"), snapshot);
                            }
                            plan.validate_rebase(&baseline, &prior)?;
                        }
                        let applied = plan.apply()?;
                        committed = Some(Applied {
                            transaction: applied.transaction.clone(),
                            changes: applied.changes,
                        });
                        #[cfg(feature = "test-fixtures")]
                        if std::env::var_os("SPECGIT_FIXTURE_DOCTOR_POST_APPLY_FAILURE").is_some() {
                            return Err(Diagnostic::new(
                                Code::ConcurrentEdit,
                                "doctor",
                                "Fixture postimage verification failed after commit.",
                                "Inspect the retained repair transaction before continuing.",
                            ));
                        }
                        let writes = plan.write_set()?;
                        Ok((applied, Some(writes)))
                    })
                    .await
                }
            };
            match outcome {
                Ok((applied, writes)) => {
                    if let Some(writes) = writes {
                        prior.push(writes);
                    }
                    results.push(RepairResult {
                        id,
                        status: "applied",
                        transaction: Some(applied),
                        diagnostic: None,
                    });
                }
                Err(d) => {
                    failed = true;
                    results.push(RepairResult {
                        id,
                        status: "failed",
                        transaction: committed,
                        diagnostic: Some(d),
                    });
                }
            }
        }
        results
    }
}

pub(super) async fn inspect(process: &Process, cwd: &Path, source: &Path) -> Inspection {
    let mut result = Inspection {
        checks: vec![],
        plans: vec![],
        root: None,
        private: None,
        declaration: None,
        declaration_snapshot: None,
    };
    let root = match git_path(process, cwd, &["rev-parse", "--show-toplevel"]).await {
        Ok(root) => root,
        Err(d) => {
            result.checks.push(Check::failed("workspace", d));
            return result;
        }
    };
    result.root = Some(root.clone());
    result
        .checks
        .push(Check::fact("workspace", "current", json!({"root":root})));
    let private = match git_path(process, &root, &["rev-parse", "--absolute-git-dir"]).await {
        Ok(p) => p.join("specgit-v2"),
        Err(d) => {
            result.checks.push(Check::failed("private_state", d));
            return result;
        }
    };
    result.private = Some(private.clone());
    let declaration = config::snapshot(&root).and_then(|snapshot| {
        let parsed = snapshot
            .bytes
            .as_deref()
            .map(Declaration::parse)
            .transpose();
        result.declaration_snapshot = Some(snapshot);
        parsed
    });
    match declaration {
        Ok(Some(d)) => {
            result.checks.push(Check::fact("declaration", "current", json!({"path":root.join(".specgit.yaml")})));
            result.declaration = Some(d);
        }
        Ok(None) => match config::worktree::private_state(&private) {
            Ok(state) if state.is_initialized() || !state.receipts.is_empty() => result.checks.push(Check::failed("declaration", config::worktree::lost_declaration(&root, &state))),
            Ok(_) => result.checks.push(Check::fact("declaration", "needs_initialization", json!({"remedy":"Run specgit init after selecting the intended project configuration."}))),
            Err(d) => result.checks.push(Check::failed("declaration", d)),
        },
        Err(d) => result.checks.push(Check::failed("declaration", d)),
    }
    let declaration_valid = result.declaration.is_some();
    if declaration_valid {
        match config::worktree::private_state(&private) {
            Ok(state) => result.checks.push(Check::fact("initialization", if state.is_initialized() { "current" } else { "needs_initialization" }, json!({"markers":state.markers(),"remedy":"A declaration alone does not prove initialization. Review specgit init --dry-run and select integrations explicitly."}))),
            Err(diagnostic) => result.checks.push(Check::failed("initialization",diagnostic)),
        }
    }
    let setup = specgit::setup::project::health_plan_with_context(
        process,
        &root,
        &private.join("agent-assets"),
        source,
    )
    .await
    .map(|p| p.map(Plan::Assets));
    result.plan("setup", setup);
    if let Some(d) = &result.declaration {
        let guidance =
            specgit::guidance::health_plan(&root, &private, d).map(|p| p.map(Plan::Assets));
        result.plan("guidance", guidance);
    } else {
        result.checks.push(Check::fact("guidance", "not_checked", json!({"reason":"A valid declaration is required to check generated initialization guidance."})));
    }
    let guard = specgit::guard::health_plan(process, &root).await;
    let covered = match &guard {
        Ok(Some(guard)) => result
            .plans
            .iter()
            .find_map(|(id, plan)| {
                if *id == "setup"
                    && let Plan::Assets(plan) = plan
                {
                    Some(guard.covered_by(plan))
                } else {
                    None
                }
            })
            .unwrap_or(Ok(false)),
        _ => Ok(false),
    };
    match covered {
        Ok(true) => result.checks.push(Check {
            id: "guard",
            status: "change_required",
            severity: "warning",
            repairable: true,
            evidence: json!({"assets": [], "repair_owner": "setup"}),
            diagnostic: None,
        }),
        // Every commit must bind an Issue; an initialized project without an
        // effective guard needs attention, whichever worktree owns the hooks.
        Ok(false) => match guard {
            Ok(None) if result.declaration.is_some() => {
                match specgit::guard::installed(process, &root).await {
                    Ok(true) => result
                        .checks
                        .push(Check::fact("guard", "not_selected", Value::Null)),
                    Ok(false) => result.checks.push(Check::fact("guard", "not_installed", json!({"remedy":"Commits are not bound to Issues. Preview specgit setup --hook-purpose guard --dry-run, then apply it under existing authorization."}))),
                    Err(diagnostic) => result.checks.push(Check::failed("guard", diagnostic)),
                }
            }
            guard => result.plan("guard", guard.map(|p| p.map(Plan::Guard))),
        },
        Err(diagnostic) => result.checks.push(Check::failed("guard", diagnostic)),
    }
    if !declaration_valid {
        result.plans.clear();
        for check in &mut result.checks {
            check.repairable = false;
        }
    }
    result
}

async fn git_path(process: &Process, cwd: &Path, args: &[&str]) -> Result<PathBuf, Diagnostic> {
    let bytes = project::git(process, cwd, args).await?;
    let text = String::from_utf8(bytes)
        .map_err(|_| Diagnostic::input("Git returned a non-UTF-8 path."))?;
    let text = text.strip_suffix('\n').unwrap_or(&text);
    #[cfg(windows)]
    let text = text.strip_suffix('\r').unwrap_or(text);
    Ok(PathBuf::from(text))
}

pub(super) fn guidance(checks: &[Check], root: &Path, source: &Path) -> Value {
    let tasks: Vec<_> = checks
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            matches!(
                c.status,
                "unknown" | "change_required" | "needs_initialization" | "not_installed"
            )
        })
        .map(|(index, c)| {
            let command = c.repairable.then(|| json!({"executable":source,"argv":["doctor","--offline","--fix","--dry-run"],"cwd":root,"scope":"project","authorization":"existing_session_only"}));
            let reason = c.diagnostic.as_ref().map(|d| d.message.as_str()).unwrap_or_else(|| {
                match (c.id, c.status, c.repairable) {
                    (_, _, true) => "Recorded project assets differ from the current templates.",
                    ("initialization", "needs_initialization", _) => "The project declaration exists, but this worktree has no initialization markers.",
                    ("declaration", "needs_initialization", _) => "No project declaration or initialization state was found.",
                    ("guard", "not_installed", _) => "The native Git guard is not installed, so commits can bypass Issue binding.",
                    _ => "This project check needs attention before initialization.",
                }
            });
            let recommendation = c.diagnostic.as_ref().map(|d| d.remedy.as_str())
                .or_else(|| c.evidence.get("remedy").and_then(Value::as_str))
                .unwrap_or(if c.repairable {"Review the concrete repair preview, then apply under existing authorization."} else {"Choose the intended initialization or integration before writing."});
            json!({"check":c.id,"finding":c.status,"evidence_pointer":format!("/evidence/health/checks/{index}"),"reason":reason,"certainty":if c.status=="unknown"{"unconfirmed"}else{"observed"},"recommendation":recommendation,"command":command,"preconditions":["Recheck current evidence and existing user authorization.","Preserve unknown ownership and manual content."],"verification":"Rerun doctor; verify host activation separately through the specgit-native Skill."})
        })
        .collect();
    json!({"tasks":tasks,"max_rounds":3,"skill":"specgit-native","stop_conditions":["Permission or ownership is unresolved.","The same findings remain without progress.","Three guided attempts have completed."],"scope":"project_static","host_behavior":"not_verified"})
}

#[cfg(test)]
mod tests {
    use super::{Check, guidance};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn guidance_names_missing_initialization_without_claiming_configuration_is_absent() {
        let checks = [Check::fact(
            "initialization",
            "needs_initialization",
            json!({
                "markers":[],
                "remedy":"Review specgit init --dry-run and select integrations explicitly."
            }),
        )];
        let result = guidance(&checks, Path::new("/project"), Path::new("/shared/specgit"));
        let task = &result["tasks"][0];
        assert_eq!(task["check"], "initialization");
        assert!(
            task["reason"]
                .as_str()
                .unwrap()
                .contains("declaration exists")
        );
        assert_eq!(task["recommendation"], checks[0].evidence["remedy"]);
        assert!(task["command"].is_null());

        let missing = [Check::fact(
            "declaration",
            "needs_initialization",
            json!({"remedy":"Run specgit init after selecting the intended project configuration."}),
        )];
        let missing_task = guidance(
            &missing,
            Path::new("/project"),
            Path::new("/shared/specgit"),
        );
        assert_eq!(missing_task["tasks"][0]["check"], "declaration");
        assert!(
            missing_task["tasks"][0]["reason"]
                .as_str()
                .unwrap()
                .contains("No project declaration")
        );
        assert_eq!(
            missing_task["tasks"][0]["recommendation"],
            missing[0].evidence["remedy"]
        );
    }
}
