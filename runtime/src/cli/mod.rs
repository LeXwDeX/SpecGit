//! Input normalization, cancellation and command orchestration.
mod arguments;
mod dispatch;
mod health;
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
    let (positions, subcommand, version, _) = argument_positions(&raw);
    let has = |value: &str| positions.iter().any(|&i| raw[i] == value);
    let mut json =
        has("--json") || (!has("--human") && !std::io::IsTerminal::is_terminal(&std::io::stdout()));
    let discovery = if has("--help") || has("-h") {
        Some("--help")
    } else if version {
        Some("--version")
    } else {
        None
    };
    if let Some(flag) = discovery {
        let mut args = vec![raw[0].clone()];
        if flag == "--help"
            && let Some(name) = subcommand.as_ref()
        {
            args.push(name.into());
        }
        args.push(flag.into());
        let error = Cli::try_parse_from(args).err().expect("discovery flag");
        if json {
            let operation = if flag == "--version" {
                "version"
            } else {
                "help"
            };
            emit(
                Report::success(
                    operation,
                    "ok",
                    serde_json::json!({"text":error.to_string()}),
                ),
                true,
            );
        } else {
            let _ = error.print();
        }
        return;
    }
    if has("--schema") {
        let mut command = Cli::command();
        if let Some(name) = subcommand.as_deref() {
            command.build();
            command = command
                .find_subcommand(name)
                .expect("known command")
                .clone();
        }
        let root_name = command.get_name().to_owned();
        let mut contract = specgit::cli_contract::schema_with_effects(&mut command, |path| {
            let name = path.last().map(String::as_str).unwrap_or(&root_name);
            serde_json::json!({"authorization":"existing_session_only","remote_writes":match name {"issue"|"pr"=>"explicit_issue_or_request_content_only",_=>"none"},"local_writes":match name {"init"=>"declaration_local_skill_stable_entry_native_git_guard_guidance_markers_routing_private_receipts_and_exact_git_exclusions; inspect_and_dry_run_have_no_writes", "setup"=>"selected_project_skills_stable_entries_guidance_routing_private_receipts_SessionStart_PreToolUse_context_native_Git_guard_and_exact_git_exclusions; uninstall_deletes_proven_owned_assets; rollback_restores_proven_owned_assets; observe_declined_no_idle_wake; catalog_is_offline_and_has_no_project_reads_or_asset_writes; dry_run_has_no_writes","doctor"=>"none_by_default; --fix repairs proven owned project assets; --fix --dry-run has no writes", "update"=>"running_executable_and_backup_on_apply_only; refresh_existing_managed_user_skill_via_new_executable", "skill"=>"explicit_user_skill_and_edited_content_backup_only; dry_run_has_no_writes", _=>"mode_dependent_see_options"},"forbidden":["merge","close_issue","delete_branch","administer_settings"],"framing":if name=="hook" {"host_event_protocol"} else if name=="guard" {"git_hook_protocol"} else {"single_json_document"}})
        });
        contract["cli_version"] = env!("CARGO_PKG_VERSION").into();
        emit(Report::success("schema", "ok", contract), true);
        return;
    }
    let input_path = match explicit_input_path(&raw, &positions) {
        Ok(path) => path,
        Err(()) => {
            let report = Report::failure(
                "input",
                Diagnostic::input("Inline --input-file path must be UTF-8."),
            );
            let exit = report.exit;
            emit(report, json);
            std::process::exit(i32::from(exit));
        }
    };
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
                let (positions, _, _, _) = argument_positions(&raw);
                json = !positions.iter().any(|&i| raw[i] == "--human");
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
                emit(report, json);
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
    // Capability discovery must also work outside a checkout, without Git or a host.
    if matches!(
        cli.command,
        arguments::Commands::Setup { catalog: true, .. }
    ) {
        emit(specgit::setup::catalog::report(), json);
        return;
    }
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
        let diagnostic = Diagnostic::new(
            Code::Cancelled,
            "runtime",
            "The operation was interrupted.",
            "Resume explicitly when ready.",
        );
        // Update may already have replaced the executable and recorded effects.
        // Keep that evidence and report cancellation instead of replacing it.
        if report.operation == "update" {
            report.exit = 130;
            report.status = "unknown".into();
            if !report
                .diagnostics
                .iter()
                .any(|existing| existing.code == Code::Cancelled)
            {
                report.diagnostics.push(diagnostic);
            }
        } else {
            report = Report::failure("runtime", diagnostic);
        }
    }
    let exit = report.exit;
    emit(report, json);
    std::process::exit(i32::from(exit));
}
fn explicit_input_path(
    raw: &[std::ffi::OsString],
    positions: &[usize],
) -> Result<Option<std::ffi::OsString>, ()> {
    for &i in positions {
        let arg = &raw[i];
        if arg == "--input-file" {
            return Ok(raw.get(i + 1).filter(|value| *value != "--").cloned());
        }
        if let Some(value) = arg.to_str().and_then(|s| s.strip_prefix("--input-file=")) {
            return Ok(Some(value.into()));
        }
        if arg.to_string_lossy().starts_with("--input-file=") {
            return Err(());
        }
    }
    Ok(None)
}

fn argument_positions(
    raw: &[std::ffi::OsString],
) -> (Vec<usize>, Option<String>, bool, Option<usize>) {
    let mut definition = Cli::command();
    definition.build();
    let mut positions = Vec::new();
    let mut subcommand = None;
    let mut subcommand_index = None;
    let mut version = false;
    let mut command_position = true;
    let mut i = 1;
    while i < raw.len() && raw[i] != "--" {
        let arg = raw[i].to_string_lossy();
        if arg.starts_with('-') {
            positions.push(i);
            if command_position && matches!(arg.as_ref(), "--version" | "-V") {
                version = true;
            }
            let name = arg
                .strip_prefix("--")
                .and_then(|s| (!s.contains('=')).then_some(s));
            if name.is_some_and(|name| {
                definition
                    .get_arguments()
                    .any(|a| a.get_long() == Some(name) && a.get_action().takes_values())
            }) {
                i += 1;
            }
        } else if command_position {
            command_position = false;
            if let Some(command) = definition.find_subcommand(arg.as_ref()) {
                subcommand = Some(arg.into_owned());
                subcommand_index = Some(i);
                definition = command.clone();
                definition.build();
            }
        }
        i += 1;
    }
    (positions, subcommand, version, subcommand_index)
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
