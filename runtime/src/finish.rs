//! CLI presentation of fresh typed delivery assessment.
use crate::{observation, process::Process, report::Report};
use std::path::Path;
#[derive(Debug, clap::Args)]
pub struct Options {
    /// Observe this exact native request; otherwise use the local locator or current source branch.
    #[arg(long)]
    pub request: Option<u64>,
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    Report::assessment(
        "finish",
        observation::observe(options.request, process, cwd).await,
    )
}
