//! Project initialization coordinates read-only native inspection and local asset transactions.
use crate::{config::Language, process::Process, project::Provider, report::Report};
use serde_json::json;
use std::path::{Path, PathBuf};
mod availability;
mod checks;
mod declaration;
mod local_assets;
mod native;
mod preparation;

#[derive(Default)]
pub struct Options {
    pub remote: Option<String>,
    pub provider: Option<Provider>,
    pub api_host: Option<String>,
    pub target: Option<String>,
    pub language: Option<Language>,
    pub config_file: Option<PathBuf>,
    pub mirror_claude: bool,
    pub native_delete_source: Option<bool>,
    pub inspect_only: bool,
    pub dry_run: bool,
    pub native_auto_merge: Option<bool>,
    pub manual_observe: bool,
    pub rollback: Option<String>,
}
pub use crate::delivery_model::Flow;
pub use crate::delivery_model::flow;

pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    let mut language = options.language.unwrap_or_default();
    let inspect_only = options.inspect_only;
    let process = if inspect_only {
        process.with_inspection_budget(crate::process::configured_inspection_budget())
    } else {
        process
    };
    let summary_process = process.clone();
    let mut report = match preparation::prepare_and_run(options, process, cwd, &mut language).await
    {
        Ok(r) => r,
        Err(d) => {
            if inspect_only {
                summary_process.mark_inspection_incomplete();
            }
            Report::failure("init", d)
        }
    };
    if inspect_only {
        if let Err(diagnostic) = summary_process.ensure_inspection_budget("init_inspection") {
            let evidence = report.evidence;
            report = Report::failure("init", diagnostic);
            report.evidence = evidence;
        }
        attach_inspection(&mut report, &summary_process);
    }
    crate::i18n::report(&mut report, language);
    report
}

fn attach_inspection(report: &mut Report, process: &Process) {
    let Some(summary) = process.inspection_summary() else {
        return;
    };
    if !report.evidence.is_object() {
        report.evidence = json!({});
    }
    if let Some(evidence) = report.evidence.as_object_mut() {
        evidence.insert(
            "inspection".into(),
            serde_json::to_value(summary).expect("inspection summary serializes"),
        );
    }
}
