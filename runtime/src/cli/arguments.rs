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
    /// Prepare, create or adopt complete specs from `type[(scope)][!]: summary` titles and native issues.
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
        #[arg(long, conflicts_with_all = ["agent", "opencode_claude_hooks", "hook_purpose", "remove_hook_purpose", "opencode_async_rewake", "uninstall", "dry_run", "rollback", "readonly_permissions", "remove_readonly_permissions"])]
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
        /// Install the managed read-only command allowlist for an explicitly selected supported host.
        #[arg(long, requires = "agent", conflicts_with = "remove_readonly_permissions", conflicts_with_all = ["uninstall", "rollback"])]
        readonly_permissions: bool,
        /// Remove the managed read-only command allowlist from explicitly selected recorded hosts.
        #[arg(long, requires = "agent", conflicts_with = "readonly_permissions", conflicts_with_all = ["uninstall", "rollback"])]
        remove_readonly_permissions: bool,
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
    let (positions, command, _, command_index) = super::argument_positions(raw);
    if command.as_deref() == Some("setup")
        && positions
            .iter()
            .filter_map(|&i| raw[i].to_str())
            .any(|arg| {
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
                    || arg == "--scope=global"
            })
        || command.as_deref() == Some("setup")
            && positions
                .iter()
                .any(|&i| raw[i] == "--scope" && raw.get(i + 1).is_some_and(|v| v == "global"))
        || command.as_deref() == Some("setup")
            && command_index
                .and_then(|i| raw.get(i + 1))
                .is_some_and(|arg| arg == "global")
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
    let mut root = raw.iter().skip(1);
    let mut first = None;
    while let Some(arg) = root.next() {
        if arg == "--" {
            break;
        }
        if arg == "--cwd" || arg == "--input-file" {
            root.next();
            continue;
        }
        if !arg.to_string_lossy().starts_with('-') {
            first = arg.to_str();
            break;
        }
    }
    if first.is_some_and(|value| {
        ["bind", "unbind", "accept", "finish", "merge", "promotion"].contains(&value)
    }) || positions
        .iter()
        .filter_map(|&i| raw[i].to_str())
        .any(|value| {
            (RETIRED.contains(&value.split('=').next().unwrap_or(value))
                && !(value.split('=').next() == Some("--scope")
                    && command.as_deref() == Some("setup")))
                || value == "--merge"
        })
    {
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
    use super::{Cli, Commands};
    use clap::{CommandFactory, Parser};
    use std::collections::BTreeSet;

    /// True when the parsed command still pins a preview/check mode that
    /// suppresses writes after a matched read-only prefix.
    fn preview_mode(cli: &Cli) -> bool {
        match &cli.command {
            Commands::Setup {
                catalog, dry_run, ..
            } => *catalog || *dry_run,
            Commands::Init {
                dry_run, inspect, ..
            } => *dry_run || *inspect,
            Commands::Issue(options) => options.dry_run || options.inspect,
            Commands::Pr(options) => options.dry_run || options.inspect,
            Commands::Remove(options) => options.dry_run,
            Commands::Update(options) => options.check || options.dry_run,
            Commands::Skill(options) => options.dry_run,
            Commands::Guard { dry_run, .. } => *dry_run,
            // Doctor has no safe read-only mode: `--offline` does not block `--fix`.
            _ => false,
        }
    }

    #[test]
    fn every_subcommand_has_exactly_one_side_effect_classification() {
        // A new subcommand must be classified here before it can be added.
        let read_only = ["status"];
        let mutating = [
            "migrate", "remove", "issue", "pr", "watch", "inbox", "init", "setup", "guard",
            "doctor", "update", "skill",
        ];
        let host_internal = ["hook"];
        let mut classified = BTreeSet::new();
        for name in read_only.into_iter().chain(mutating).chain(host_internal) {
            assert!(classified.insert(name.to_owned()), "{name} appears twice");
        }
        let defined: BTreeSet<String> = Cli::command()
            .get_subcommands()
            .map(|command| command.get_name().to_owned())
            .filter(|name| name != "help")
            .collect();
        assert_eq!(defined, classified);
    }

    #[test]
    fn managed_read_only_rules_never_match_mutating_invocations() {
        let rules = specgit::setup::permissions::claude_allow_rules();
        let prefixes: Vec<&str> = rules
            .iter()
            .map(|rule| {
                rule.strip_prefix("Bash(")
                    .and_then(|rule| rule.strip_suffix(')'))
                    .and_then(|rule| rule.strip_suffix(" *"))
                    .expect("managed rule shape")
            })
            .collect();
        assert_eq!(rules.len(), 17);
        let matched = |invocation: &str| {
            prefixes.iter().any(|prefix| {
                invocation == *prefix || invocation.starts_with(&format!("{prefix} "))
            })
        };
        // `doctor --offline --fix` parses and writes, so doctor is not allowlisted
        // in any mode: a prefix rule would authorize the repair.
        for prefix in &prefixes {
            assert!(!prefix.contains("doctor"), "{prefix}");
        }
        assert!(!matched("specgit doctor --offline --fix"));
        for invocation in [
            "specgit setup",
            "specgit setup --uninstall",
            "specgit setup --agent claude --readonly-permissions",
            "specgit setup --agent claude --remove-readonly-permissions",
            "specgit init",
            "specgit issue 42",
            "specgit pr",
            "specgit pr --status",
            "specgit remove --apply",
            "specgit migrate --apply",
            "specgit update",
            "specgit guard --install",
            "specgit guard --uninstall",
            "specgit skill --user",
            "specgit watch --request 1 --session session --goal checks",
            "specgit inbox --request 1 --session session --goal checks",
            "specgit doctor --offline",
            "specgit doctor --offline --fix",
            "specgit doctor --fix",
        ] {
            assert!(
                !matched(invocation),
                "{invocation} is matched by a managed rule prefix"
            );
        }
        // A command with both read and write modes must pin the read-only flag.
        for (subcommand, flags) in [
            ("setup", &["--catalog", "--dry-run"][..]),
            ("init", &["--dry-run", "--inspect"][..]),
            ("issue", &["--dry-run", "--inspect"][..]),
            ("pr", &["--dry-run", "--inspect"][..]),
            ("remove", &["--dry-run"][..]),
            (
                "guard",
                &["--install --dry-run", "--uninstall --dry-run"][..],
            ),
            ("skill", &["--user --dry-run"][..]),
            ("update", &["--check"][..]),
        ] {
            for flag in flags {
                let rule = format!("Bash(specgit {subcommand} {flag} *)");
                assert!(rules.contains(&rule), "missing {rule}");
            }
        }
        // A verified merged request makes `pr --status` write the checkpoint.
        assert!(rules.iter().all(|rule| !rule.contains("pr --status")));
        assert!(rules.contains("Bash(specgit --help *)"));
        assert!(rules.contains("Bash(specgit status *)"));

        // A rule prefix accepts any trailing argument, so appending a write-capable
        // flag must be rejected by clap or still pin a preview mode. This covers
        // `prefix + write flag` combinations, not only canonical write commands.
        const WRITE_FLAGS: &[&str] = &[
            "--fix",
            "--apply",
            "--uninstall",
            "--rollback",
            "--remove",
            "--status",
            "--install",
            "--discard-uncertain",
        ];
        let mut accepted = Vec::new();
        for prefix in &prefixes {
            for flag in WRITE_FLAGS {
                let invocation = format!("{prefix} {flag}");
                assert!(matched(&invocation), "{invocation} escapes its own prefix");
                if let Ok(cli) = Cli::try_parse_from(invocation.split_whitespace()) {
                    assert!(
                        preview_mode(&cli),
                        "{invocation} parses after a read-only prefix without a preview mode"
                    );
                    accepted.push(invocation);
                }
            }
        }
        // Only a preview mode that suppresses the appended write may parse.
        assert_eq!(
            accepted,
            [
                "specgit issue --dry-run --discard-uncertain",
                "specgit pr --dry-run --discard-uncertain",
                "specgit setup --dry-run --uninstall",
                "specgit skill --user --dry-run --remove",
            ],
            "unexpected accepted prefix + write flag combinations"
        );
        // `--discard-uncertain` clears a checkpoint write flag, so its only safe
        // mode is the dry-run preview (bounded native reads plus a transaction
        // lock marker; no checkpoint, project or native writes). `--inspect`
        // conflicts and must stay rejected.
        for invocation in [
            "specgit issue --inspect --discard-uncertain",
            "specgit pr --inspect --discard-uncertain",
        ] {
            assert!(matched(invocation), "{invocation} escapes its own prefix");
            assert!(
                Cli::try_parse_from(invocation.split_whitespace()).is_err(),
                "{invocation} must be rejected"
            );
        }
        for invocation in [
            "specgit issue --dry-run --discard-uncertain",
            "specgit pr --dry-run --discard-uncertain",
        ] {
            let cli = Cli::try_parse_from(invocation.split_whitespace())
                .unwrap_or_else(|error| panic!("{invocation}: {error}"));
            assert!(preview_mode(&cli), "{invocation} must stay a preview");
        }
    }

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
