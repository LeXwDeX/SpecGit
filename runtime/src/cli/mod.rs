//! Input normalization, cancellation and command orchestration.
mod arguments;
mod dispatch;
mod host;
mod inspection;
mod output;

use arguments::{Cli, argument_diagnostic};
use clap::{CommandFactory, Parser};
use output::emit;
use specgit::{
    diagnostic::{Code, Diagnostic},
    process::Process,
    report::Report,
};

pub async fn run() {
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
            serde_json::json!({"authorization":"existing_session_only","remote_writes":match name {"issue"|"pr"=>"explicit_issue_or_request_content_only",_=>"none"},"local_writes":if name=="update" {"running_executable_and_backup_on_apply_only"} else {"mode_dependent_see_options"},"forbidden":["merge","close_issue","delete_branch","administer_settings"],"framing":if name=="hook" {"host_event_protocol"} else if name=="guard" {"git_hook_protocol"} else {"single_json_document"}})
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
    host::run(&cli.command, &cwd).await;
    let process = Process::default();
    let cancel = process.cancellation.clone();
    let task = tokio::spawn(async move { dispatch::run(cli.command, process, cwd).await });
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
