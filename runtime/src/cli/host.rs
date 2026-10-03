//! Host events and Git hooks own their framing and exit protocol.
use super::arguments::Commands;
use specgit::process::Process;
use std::{
    io::{self, Read},
    path::Path,
};

pub(super) async fn run(command: &Commands, cwd: &Path) {
    if let Commands::Hook { event, observe } = command {
        let output = specgit::hook::stdin(event, *observe).await;
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
    if let Commands::Guard {
        stage,
        install,
        uninstall,
    } = command
    {
        if *install || *uninstall {
            match specgit::guard::install(&Process::default(), cwd, *uninstall).await {
                Ok(value) => {
                    println!("{value}");
                    std::process::exit(0);
                }
                Err(diagnostic) => {
                    eprintln!("{diagnostic}");
                    std::process::exit(diagnostic.exit().into());
                }
            }
        }
        let Some(stage) = stage else {
            eprintln!("git_guard: select exactly one of --stage, --install, or --uninstall.");
            std::process::exit(2);
        };
        let mut bytes = vec![];
        if matches!(stage, specgit::guard::Stage::PrePush) {
            let _ = io::stdin()
                .take((specgit::cli_contract::MAX_INPUT_BYTES + 1) as u64)
                .read_to_end(&mut bytes);
        }
        match specgit::guard::check(*stage, &bytes, &Process::default(), cwd).await {
            Ok(()) => std::process::exit(0),
            Err(diagnostic) => {
                eprintln!("{diagnostic}");
                std::process::exit(diagnostic.exit().into());
            }
        }
    }
}
