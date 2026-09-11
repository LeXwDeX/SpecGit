use clap::{CommandFactory, Parser, Subcommand};
use specgit::{
    diagnostic::{Code, Diagnostic},
    probe::{self, Capability, ForgeRead},
    process::Process,
    project::Provider,
    report::Report,
};
use std::{
    io::{self, Write},
    path::PathBuf,
};

#[derive(Parser)]
#[command(
    name = "specgit",
    version,
    about = "Native issue-based delivery harness (Rust 2 development)"
)]
struct Cli {
    #[arg(long, global = true)]
    json: bool,
    /// Render human text even when stdout is redirected.
    #[arg(long, global = true, conflicts_with = "json")]
    human: bool,
    /// Return the offline command/input/output contract without executing an operation.
    #[arg(long, global = true)]
    schema: bool,
    /// Read an explicit bounded JSON request from a file, or - for stdin.
    #[arg(long, global = true)]
    input_file: Option<PathBuf>,
    #[arg(long, global = true)]
    cwd: Option<PathBuf>,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    /// Preview, retire or explicitly migrate v1 integration with restorable local transactions.
    Migrate(specgit::migrate::Options),
    /// Prepare, create or adopt complete specs using native issues and a local checkpoint.
    Issue(specgit::issue::Options),
    /// Create or adopt a native request after real pushed changes, preserving issue references.
    Pr(specgit::pr::Options),
    /// Observe current checks or lifecycle with a bounded, resumable subscription.
    Watch(specgit::watch::Options),
    /// Refresh pending events or explicitly acknowledge transport receipt.
    Inbox(specgit::watch::InboxOptions),
    /// Inspect native flow and install the shared project declaration and guidance.
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
    /// Install global owned assets; explicit registration is separate from host verification.
    Setup {
        #[arg(long)]
        root: Option<PathBuf>,
        #[arg(long, value_enum)]
        provider: Option<Provider>,
        #[arg(long)]
        api_host: Option<String>,
        #[arg(long)]
        register_claude: bool,
        #[arg(long, requires = "register_claude")]
        claude_settings: Option<PathBuf>,
        /// Install Codex's native skill and managed global instructions.
        #[arg(long)]
        register_codex: bool,
        #[arg(long, requires = "register_codex")]
        codex_root: Option<PathBuf>,
        /// Install OpenCode's native skill and managed global instructions.
        #[arg(long)]
        register_opencode: bool,
        #[arg(long, requires = "register_opencode")]
        opencode_root: Option<PathBuf>,
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
        #[arg(long)]
        state_root: Option<PathBuf>,
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
fn argument_diagnostic(raw: &[std::ffi::OsString]) -> Diagnostic {
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
        RETIRED.contains(&value.split('=').next().unwrap_or(value))
            || ["bind", "unbind", "accept", "finish", "merge", "promotion"].contains(&value)
            || value == "--merge"
    }) {
        return Diagnostic::new(
            Code::InvalidInput,
            "major_version",
            "This v1 command or option is retired in SpecGit 2; its meaning is not reinterpreted.",
            "Use the retained v1 executable for an unmigrated project. Preview explicit migration with specgit migrate --config-file <v2.yaml>; use issue/pr for native associations and authorized gh/glab operations for native auto-merge.",
        );
    }
    Diagnostic::input("Invalid command arguments; run specgit --help.")
}
#[tokio::main]
async fn main() {
    let mut raw: Vec<_> = std::env::args_os().collect();
    let mut json = raw.iter().any(|s| s == "--json")
        || (!raw.iter().any(|s| s == "--human")
            && !std::io::IsTerminal::is_terminal(&std::io::stdout()));
    if raw
        .iter()
        .take_while(|s| *s != "--")
        .any(|s| s == "--schema")
    {
        let mut command = Cli::command();
        if let Some(name) = raw
            .iter()
            .skip(1)
            .filter_map(|s| s.to_str())
            .find(|s| command.get_subcommands().any(|c| c.get_name() == *s))
        {
            command.build();
            command = command
                .find_subcommand(name)
                .expect("known command")
                .clone();
        }
        let root_name = command.get_name().to_owned();
        let mut contract = specgit::cli_contract::schema_with_effects(&mut command, |path| {
            let name = path.last().map(String::as_str).unwrap_or(&root_name);
            serde_json::json!({"authorization":"existing_session_only","remote_writes":match name {"issue"|"pr"=>"explicit_issue_or_request_content_only",_=>"none"},"local_writes":"mode_dependent_see_options","forbidden":["merge","close_issue","delete_branch","administer_settings"],"framing":if name=="hook" {"host_event_protocol"} else {"single_json_document"}})
        });
        contract["cli_version"] = env!("CARGO_PKG_VERSION").into();
        emit(Report::success("schema", "ok", contract), true);
        return;
    }
    let input_path = explicit_input_path(&raw);
    if let Some(path) = input_path {
        let cancellation = tokio_util::sync::CancellationToken::new();
        let input = tokio::select! {
            result = specgit::cli_contract::read_input(&path, specgit::cli_contract::MAX_INPUT_BYTES, specgit::cli_contract::INPUT_DEADLINE, cancellation.clone()) => result,
            _ = interrupted() => { cancellation.cancel(); Err(specgit::cli_contract::InputError::Cancelled) },
        };
        let normalized = input.and_then(|bytes| {
            specgit::cli_contract::normalize_input(&mut Cli::command(), &raw, &bytes)
        });
        match normalized {
            Ok(args) => {
                raw = args;
                json = !raw.iter().any(|s| s == "--human");
            }
            Err(error) => {
                let code = match error {
                    specgit::cli_contract::InputError::Cancelled => Code::Cancelled,
                    specgit::cli_contract::InputError::TooLarge => Code::InputLimit,
                    specgit::cli_contract::InputError::Deadline => Code::Timeout,
                    specgit::cli_contract::InputError::Unavailable => Code::IoFailed,
                    specgit::cli_contract::InputError::Invalid(_) => Code::InvalidInput,
                };
                let report = Report::failure(
                    "input",
                    Diagnostic::new(
                        code,
                        "input",
                        &error.to_string(),
                        "Inspect --schema and supply one bounded explicit JSON request.",
                    ),
                );
                let exit = report.exit;
                emit(report, true);
                std::process::exit(i32::from(exit));
            }
        }
    }
    let cli = match Cli::try_parse_from(&raw) {
        Ok(cli) => cli,
        Err(error) => {
            if error.use_stderr() {
                emit(Report::failure("input", argument_diagnostic(&raw)), json);
            } else if json {
                emit(
                    Report::success("help", "ok", serde_json::json!({"text":error.to_string()})),
                    true,
                );
            } else {
                let _ = error.print();
            }
            if error.use_stderr() {
                std::process::exit(2);
            }
            return;
        }
    };
    let cwd = match cli
        .cwd
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
        .canonicalize()
    {
        Ok(path) => path,
        Err(_) => {
            emit(
                Report::failure(
                    "input",
                    Diagnostic::input("Working directory is unavailable."),
                ),
                json,
            );
            std::process::exit(2);
        }
    };
    if let Commands::Hook {
        event,
        state_root,
        observe,
    } = &cli.command
    {
        let output = specgit::hook::stdin(event, state_root.as_deref(), *observe).await;
        if let Some(value) = output.json {
            println!("{}", value);
        }
        if let Some(message) = output.diagnostic {
            eprintln!("{}", message);
        }
        // Tokio stdin uses a blocking reader. Exit after framing so a stalled
        // host stdin cannot hold runtime shutdown past the hook deadline.
        std::process::exit(0);
    }
    let process = Process::default();
    let cancel = process.cancellation.clone();
    let task = tokio::spawn(async move {
        match cli.command {
            Commands::Migrate(options) => {
                Box::pin(specgit::migrate::run(options, process, &cwd)).await
            }
            Commands::Issue(options) => specgit::issue::run(options, process, &cwd).await,
            Commands::Pr(options) => Box::pin(specgit::pr::run(options, process, &cwd)).await,
            Commands::Watch(options) => Box::pin(specgit::watch::run(options, process, &cwd)).await,
            Commands::Inbox(options) => {
                Box::pin(specgit::watch::inbox(options, process, &cwd)).await
            }
            Commands::Init {
                remote,
                provider,
                api_host,
                target,
                language,
                config_file,
                mirror_claude,
                native_auto_merge,
                manual_observe,
                dry_run,
                inspect,
                rollback,
            } => {
                specgit::init::run(
                    specgit::init::Options {
                        remote,
                        provider,
                        api_host,
                        target,
                        language,
                        config_file,
                        mirror_claude,
                        native_delete_source: None,
                        native_auto_merge,
                        manual_observe,
                        dry_run,
                        inspect_only: inspect,
                        rollback,
                    },
                    process,
                    &cwd,
                )
                .await
            }

            Commands::Hook { .. } => unreachable!("hook has its own framing"),
            Commands::Setup {
                root,
                provider,
                api_host,
                register_claude,
                claude_settings,
                register_codex,
                codex_root,
                register_opencode,
                opencode_root,
                uninstall,
                dry_run,
                rollback,
            } => {
                let root = match root.map(Ok).unwrap_or_else(specgit::setup::default_root) {
                    Ok(p) => p,
                    Err(d) => return Report::failure("setup", d),
                };
                let settings = if register_claude {
                    match claude_settings
                        .map(Ok)
                        .unwrap_or_else(specgit::setup::claude_settings)
                    {
                        Ok(p) => Some(p),
                        Err(d) => return Report::failure("setup", d),
                    }
                } else {
                    None
                };
                let mut host_roots = std::collections::BTreeMap::new();
                for (host, register, path) in [
                    ("codex", register_codex, codex_root),
                    ("opencode", register_opencode, opencode_root),
                ] {
                    if register {
                        match path
                            .map(Ok)
                            .unwrap_or_else(|| specgit::setup::host_root(host))
                        {
                            Ok(root) => {
                                host_roots.insert(host.to_owned(), root);
                            }
                            Err(d) => return Report::failure("setup", d),
                        }
                    }
                }
                specgit::setup::run(
                    specgit::setup::Options {
                        root,
                        provider,
                        api_host,
                        claude_settings: settings,
                        host_roots,
                        uninstall,
                        dry_run,
                        rollback,
                    },
                    process,
                    &cwd,
                )
                .await
            }
            Commands::Doctor {
                provider,
                remote,
                api_host,
                account_only,
            } => {
                let mut probes = probe::commands(&process, &cwd, provider).await;
                let context = if account_only {
                    None
                } else {
                    match specgit::project::resolve(
                        &process,
                        &cwd,
                        remote.as_deref(),
                        Some(provider),
                        api_host.as_deref(),
                    )
                    .await
                    {
                        Ok(context) => Some(context),
                        Err(d) => {
                            let mut report = Report::failure("doctor", d);
                            report.evidence = serde_json::json!({"probes":probes,"write_permissions":"not_checked"});
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
                let reader = match ForgeRead::new(process, &cwd, provider, host) {
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
            Commands::Status { remote, provider } => {
                let root =
                    match specgit::project::git(&process, &cwd, &["rev-parse", "--show-toplevel"])
                        .await
                    {
                        Ok(bytes) => match String::from_utf8(bytes) {
                            Ok(s) => PathBuf::from(s.trim_end_matches(['\r', '\n'])),
                            Err(_) => {
                                return Report::failure(
                                    "status",
                                    Diagnostic::input("Invalid Git root."),
                                );
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
                let selected_provider =
                    provider.or_else(|| declaration.as_ref().and_then(|d| d.provider));
                match specgit::config::resolve(
                    &process,
                    &root,
                    selected_remote,
                    selected_provider,
                    None,
                )
                .await
                {
                    Ok(context) => {
                        let selection = match specgit::selection::read(&context) {
                            Ok(s) => s,
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
        }
    });
    tokio::pin!(task);
    let result = tokio::select! {
        result=&mut task=>result,
        _=interrupted()=> {cancel.cancel(); task.await},
    };
    let mut report = result.unwrap_or_else(|_| {
        Report::failure(
            "runtime",
            Diagnostic::new(
                Code::ProcessFailed,
                "runtime",
                "The runtime stopped unexpectedly.",
                "Retry and report a reproducible diagnostic.",
            ),
        )
    });
    if cancel.is_cancelled() {
        report = Report::failure(
            "runtime",
            Diagnostic::new(
                Code::Cancelled,
                "runtime",
                "The operation was interrupted.",
                "Resume explicitly when ready.",
            ),
        );
    }
    let exit = report.exit;
    emit(report, json);
    std::process::exit(i32::from(exit));
}
fn explicit_input_path(raw: &[std::ffi::OsString]) -> Option<std::ffi::OsString> {
    let mut args = raw.iter().skip(1).take_while(|s| *s != "--");
    while let Some(arg) = args.next() {
        if arg == "--input-file" {
            return args.next().cloned();
        }
        if let Some(value) = arg.to_str().and_then(|s| s.strip_prefix("--input-file=")) {
            return Some(value.into());
        }
    }
    None
}
async fn interrupted() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut hangup = signal(SignalKind::hangup()).expect("install SIGHUP handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
            _ = hangup.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
fn emit(report: Report, json: bool) {
    if json {
        let mut stdout = io::stdout().lock();
        if serde_json::to_writer(&mut stdout, &report).is_ok() {
            let _ = writeln!(stdout);
        }
    } else {
        println!("{}: {}", report.operation, report.status);
        for diagnostic in &report.diagnostics {
            eprintln!("{diagnostic}");
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&report.evidence).unwrap_or_default()
        );
    }
}
