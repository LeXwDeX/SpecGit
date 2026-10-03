//! Public command declarations and argument diagnostics.
use clap::{Parser, Subcommand};
use specgit::{
    diagnostic::{Code, Diagnostic},
    project::Provider,
};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "specgit",
    version,
    about = "Native issue-based delivery harness"
)]
pub(super) struct Cli {
    #[arg(long, global = true)]
    pub(super) json: bool,
    /// Render human text even when stdout is redirected.
    #[arg(long, global = true, conflicts_with = "json")]
    pub(super) human: bool,
    /// Return the offline command/input/output contract without executing an operation.
    #[arg(long, global = true)]
    pub(super) schema: bool,
    /// Read an explicit bounded JSON request from a file, or - for stdin.
    #[arg(long, global = true)]
    pub(super) input_file: Option<PathBuf>,
    #[arg(long, global = true)]
    pub(super) cwd: Option<PathBuf>,
    #[command(subcommand)]
    pub(super) command: Commands,
}
#[derive(Subcommand)]
pub(super) enum Commands {
    /// Preview, retire or explicitly migrate v1 integration with restorable local transactions.
    Migrate(specgit::migrate::Options),
    /// Preview or reversibly remove only this project's proven owned integrations.
    Remove(specgit::remove::Options),
    /// Prepare, create or adopt complete specs using native issues and a local checkpoint.
    Issue(specgit::issue::Options),
    /// Create or adopt a native request after real pushed changes, preserving issue references.
    Pr(specgit::pr::Options),
    /// Observe current checks or lifecycle with a bounded, resumable subscription.
    Watch(specgit::watch::Options),
    /// Refresh pending events or explicitly acknowledge transport receipt.
    Inbox(specgit::watch::InboxOptions),
    /// Inspect native flow and install the local project declaration and guidance.
    Init {
        #[arg(long)]
        remote: Option<String>,
        #[arg(long, value_enum)]
        provider: Option<Provider>,
        #[arg(long)]
        api_host: Option<String>,
        #[arg(long)]
        target: Option<String>,
        #[arg(long, value_enum)]
        language: Option<specgit::config::Language>,
        #[arg(long)]
        config_file: Option<PathBuf>,
        #[arg(long)]
        mirror_claude: bool,
        /// Explicit preference; native capability must be proven before enabling.
        #[arg(long, action=clap::ArgAction::Set, conflicts_with="manual_observe")]
        native_auto_merge: Option<bool>,
        /// Accept manual / observe-only operation when native capability is unavailable.
        #[arg(long)]
        manual_observe: bool,
        #[arg(long)]
        dry_run: bool,
        #[arg(long, visible_alias = "check")]
        inspect: bool,
        #[arg(long)]
        rollback: Option<String>,
    },
    /// Install only project-owned agent assets; registration is not host verification.
    Setup {
        /// Project is the only supported scope, permanently; the shared CLI is installed separately.
        #[arg(long, value_enum, default_value = "project")]
        scope: specgit::setup::Scope,
        /// Select an integration explicitly; repeat for multiple agents.
        #[arg(long, value_enum, action = clap::ArgAction::Append)]
        agent: Vec<specgit::setup::Agent>,
        /// Opt in only on a custom OpenCode supporting Claude-compatible command hooks.
        #[arg(long, conflicts_with_all = ["uninstall", "rollback"])]
        opencode_claude_hooks: bool,
        #[arg(long, conflicts_with = "rollback")]
        uninstall: bool,
        #[arg(long, conflicts_with = "rollback")]
        dry_run: bool,
        #[arg(long)]
        rollback: Option<String>,
    },
    /// Native host adapter: event JSON framing, not the ordinary --json report protocol.
    Hook {
        #[arg(long)]
        event: String,
        /// Bounded native observation for the host's asynchronous PostToolUse hook.
        #[arg(long)]
        observe: bool,
    },
    /// Enforce the local Issue checkpoint from a Git pre-commit or pre-push hook.
    Guard {
        #[arg(long, value_enum, conflicts_with_all = ["install", "uninstall"])]
        stage: Option<specgit::guard::Stage>,
        #[arg(long, conflicts_with_all = ["stage", "uninstall"])]
        install: bool,
        #[arg(long, conflicts_with_all = ["stage", "install"])]
        uninstall: bool,
    },
    /// Probe native command support and authenticated read-only API access.
    Doctor {
        #[arg(long, value_enum)]
        provider: Provider,
        #[arg(long)]
        remote: Option<String>,
        #[arg(long)]
        api_host: Option<String>,
        /// Probe an account outside Git; project access remains not_checked.
        #[arg(long)]
        account_only: bool,
    },
    /// Show offline Git/project identity; no forge or network child is invoked.
    Status {
        #[arg(long)]
        remote: Option<String>,
        #[arg(long, value_enum)]
        provider: Option<Provider>,
    },
}
pub(super) fn argument_diagnostic(raw: &[std::ffi::OsString]) -> Diagnostic {
    if raw.iter().any(|arg| arg == "setup")
        && raw.iter().filter_map(|arg| arg.to_str()).any(|arg| {
            [
                "--root",
                "--provider",
                "--api-host",
                "--register-claude",
                "--claude-settings",
                "--register-codex",
                "--codex-root",
                "--register-opencode",
                "--opencode-root",
            ]
            .contains(&arg.split('=').next().unwrap_or(arg))
                || matches!(arg, "global" | "--scope=global")
        })
    {
        return Diagnostic::new(
            Code::InvalidInput,
            "setup",
            "SpecGit integration is permanently project-only; global setup and external host roots are unsupported.",
            "Install the shared CLI separately, initialize the project, then preview specgit setup --agent <agent> --dry-run.",
        );
    }
    const RETIRED: &[&str] = &[
        "--automation",
        "--merge-target",
        "--close-issues",
        "--close-target",
        "--scope",
        "--plan-checks",
        "--no-protect",
        "--no-ignore",
        "--configure-rules",
        "--force",
    ];
    if raw.iter().skip(1).filter_map(|v| v.to_str()).any(|value| {
        (RETIRED.contains(&value.split('=').next().unwrap_or(value))
            && !(value.split('=').next() == Some("--scope")
                && raw.iter().any(|arg| arg == "setup")))
            || ["bind", "unbind", "accept", "finish", "merge", "promotion"].contains(&value)
            || value == "--merge"
    }) {
        return Diagnostic::new(
            Code::InvalidInput,
            "major_version",
            "This v1 command or option is retired in SpecGit 2; its meaning is not reinterpreted.",
            "Preview explicit migration with specgit migrate --config-file <v2.yaml>; use issue/pr for native associations and authorized gh/glab operations for native auto-merge.",
        );
    }
    Diagnostic::input("Invalid command arguments; run specgit --help.")
}
