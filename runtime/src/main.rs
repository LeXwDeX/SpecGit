use clap::{Parser, Subcommand};
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
    #[arg(long, global = true)]
    cwd: Option<PathBuf>,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
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
        #[arg(long, conflicts_with = "rollback")]
        uninstall: bool,
        #[arg(long)]
        rollback: Option<String>,
    },
    /// Native host adapter: event JSON framing, not the ordinary --json report protocol.
    Hook {
        #[arg(long)]
        event: String,
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
#[tokio::main]
async fn main() {
    let raw: Vec<_> = std::env::args_os().collect();
    let json = raw.iter().any(|s| s == "--json");
    let cli = match Cli::try_parse_from(&raw) {
        Ok(cli) => cli,
        Err(error) => {
            if error.use_stderr() {
                emit(
                    Report::failure(
                        "input",
                        Diagnostic::input("Invalid command arguments; run specgit --help."),
                    ),
                    json,
                );
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
    if let Commands::Hook { event, state_root } = &cli.command {
        let output = specgit::hook::stdin(event, state_root.as_deref()).await;
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
            Commands::Hook { .. } => unreachable!("hook has its own framing"),
            Commands::Setup {
                root,
                provider,
                api_host,
                register_claude,
                claude_settings,
                uninstall,
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
                specgit::setup::run(
                    specgit::setup::Options {
                        root,
                        provider,
                        api_host,
                        claude_settings: settings,
                        uninstall,
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
                match specgit::project::resolve(&process, &cwd, remote.as_deref(), provider, None)
                    .await
                {
                    Ok(context)
                        if context
                            .root
                            .join(".specgit.yaml")
                            .symlink_metadata()
                            .is_ok() =>
                    {
                        Report::failure(
                            "status",
                            Diagnostic::new(
                                Code::MigrationRequired,
                                "configuration",
                                "An existing SpecGit declaration requires version-aware inspection.",
                                "Use the existing CLI until the native configuration migration is available; no declaration was modified.",
                            ),
                        )
                    }
                    Ok(context) => Report::success(
                        "status",
                        "uninitialized",
                        serde_json::json!({"context":context,"remote_state":"not_checked","integration":"not_initialized"}),
                    ),
                    Err(d) => Report::failure("status", d),
                }
            }
        }
    });
    tokio::pin!(task);
    let result = tokio::select! {
        result=&mut task=>result,
        _=tokio::signal::ctrl_c()=> {cancel.cancel(); task.await},
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
