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
    /// Inspect native flow, preserve configuration, and prepare the local Skill and stable guidance entry.
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
    /// Discover integration capabilities, or install shared project guidance and preserve recorded integrations.
    Setup {
        /// List offline installation capabilities without reading a project, probing hosts or writing files.
        #[arg(long, conflicts_with_all = ["agent", "opencode_claude_hooks", "hook_purpose", "remove_hook_purpose", "opencode_async_rewake", "uninstall", "dry_run", "rollback"])]
        catalog: bool,
        /// Project is the only supported scope, permanently; the shared CLI is installed separately.
        #[arg(long, value_enum, default_value = "project")]
        scope: specgit::setup::Scope,
        /// Select named project guidance; hooks require an explicit --hook-purpose, including for new hosts.
        #[arg(long, value_enum, action = clap::ArgAction::Append)]
        agent: Vec<specgit::setup::Agent>,
        /// Opt in only on a custom OpenCode supporting Claude-compatible command hooks.
        #[arg(long, conflicts_with_all = ["uninstall", "rollback"])]
        opencode_claude_hooks: bool,
        /// Explicitly add native Git guard or SessionStart/PreToolUse context to selected agents (all recorded agents if omitted); none preserves choices.
        #[arg(long, value_enum, action = clap::ArgAction::Append, conflicts_with_all = ["uninstall", "rollback"])]
        hook_purpose: Vec<specgit::setup::HookPurpose>,
        /// Remove guard or context from selected recorded agents (all recorded agents if omitted), preserving other integrations.
        #[arg(long, value_enum, action = clap::ArgAction::Append, conflicts_with_all = ["uninstall", "rollback"])]
        remove_hook_purpose: Vec<specgit::setup::RemovableHookPurpose>,
        /// Legacy flag, retained for compatibility; no Stop callback or idle wake is installed.
        #[arg(long, conflicts_with_all = ["uninstall", "rollback"])]
        opencode_async_rewake: bool,
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
        /// Legacy observer flag; allowed events report unsupported, old callbacks quietly return.
        #[arg(long)]
        observe: bool,
    },
    /// Enforce the local Issue checkpoint from a Git pre-commit or pre-push hook.
    Guard {
        #[arg(long, value_enum, conflicts_with_all = ["install", "uninstall"])]
        stage: Option<specgit::guard::Stage>,
        #[arg(long, group = "guard_operation", conflicts_with_all = ["stage", "uninstall"])]
        install: bool,
        #[arg(long, group = "guard_operation", conflicts_with_all = ["stage", "install"])]
        uninstall: bool,
        /// Preview --install or --uninstall without creating hooks, locks or state.
        #[arg(long, requires = "guard_operation", conflicts_with = "stage")]
        dry_run: bool,
    },
    /// Check project health and online release reminders; --fix repairs only recorded integrations.
    Doctor {
        #[arg(long, value_enum)]
        provider: Option<Provider>,
        #[arg(long)]
        remote: Option<String>,
        #[arg(long)]
        api_host: Option<String>,
        /// Probe an account and official runtime releases; local context and project access remain not_checked.
        #[arg(long, requires = "provider")]
        account_only: bool,
        /// Skip authentication, release checks and all platform/network probes.
        #[arg(long, conflicts_with = "account_only")]
        offline: bool,
        /// Repair only proven owned project assets, then check them again.
        #[arg(long, conflicts_with = "account_only")]
        fix: bool,
        /// Preview concrete repairs without creating files, locks or transactions.
        #[arg(long, requires = "fix", conflicts_with = "account_only")]
        dry_run: bool,
    },
    /// Check, verify or apply a signed GitHub Release to the running shared executable.
    Update(specgit::self_update::Options),
    /// Explicitly install, refresh or remove the user Skill; never installs global hooks or state.
    Skill(specgit::skill::Options),
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
            "Install the shared CLI separately, initialize the project, inspect specgit setup --catalog, then preview specgit setup --dry-run.",
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

#[cfg(test)]
mod catalog_contract_tests {
    use super::Cli;
    use clap::CommandFactory;

    #[test]
    fn catalog_commands_parse_and_publish_every_flag() {
        let catalog = specgit::setup::catalog::catalog();
        let mut definition = Cli::command();
        let schema = specgit::cli_contract::schema(&mut definition);
        for item in &catalog.items {
            if matches!(
                item.id,
                specgit::setup::catalog::InstallationId::SessionContext
                    | specgit::setup::catalog::InstallationId::ToolContext
                    | specgit::setup::catalog::InstallationId::GitGuard
            ) {
                assert!(
                    item.commands
                        .iter()
                        .any(|command| command.argv.contains(&"--hook-purpose"))
                );
            }
        }
        for command in catalog
            .entrypoints
            .iter()
            .chain(catalog.items.iter().flat_map(|item| &item.commands))
        {
            let argv: Vec<_> = command
                .argv
                .iter()
                .map(|argument| match *argument {
                    "<agent>" => "claude",
                    "<request>" => "1",
                    "<session>" => "catalog-contract",
                    other => other,
                })
                .collect();
            Cli::command()
                .try_get_matches_from(&argv)
                .unwrap_or_else(|error| panic!("{argv:?}: {error}"));
            let schema_text = serde_json::to_string(&schema).unwrap();
            for argument in argv
                .iter()
                .filter_map(|argument| argument.strip_prefix("--"))
            {
                assert!(
                    schema_text.contains(&format!("\"long\":\"{argument}\"")),
                    "schema omits {argument}"
                );
            }
        }
    }
}
