//! Route ordinary commands to their library use cases.
use super::{arguments::Commands, inspection};
use specgit::{process::Process, report::Report};
use std::path::PathBuf;

pub(super) async fn run(command: Commands, process: Process, cwd: PathBuf) -> Report {
    match command {
        Commands::Migrate(options) => Box::pin(specgit::migrate::run(options, process, &cwd)).await,
        Commands::Remove(options) => specgit::remove::run(options, process, &cwd).await,
        Commands::Issue(options) => specgit::issue::run(options, process, &cwd).await,
        Commands::Pr(options) => Box::pin(specgit::pr::run(options, process, &cwd)).await,
        Commands::Watch(options) => Box::pin(specgit::watch::run(options, process, &cwd)).await,
        Commands::Inbox(options) => Box::pin(specgit::watch::inbox(options, process, &cwd)).await,
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

        Commands::Hook { .. } | Commands::Guard { .. } => {
            unreachable!("hook and guard have their own framing")
        }
        Commands::Setup {
            scope: _,
            agent,
            opencode_claude_hooks,
            uninstall,
            dry_run,
            rollback,
        } => {
            specgit::setup::project::run(
                specgit::setup::project::Options {
                    agents: agent,
                    opencode_claude_hooks,
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
        } => inspection::doctor(process, &cwd, provider, remote, api_host, account_only).await,
        Commands::Status { remote, provider } => {
            inspection::status(process, &cwd, remote, provider).await
        }
    }
}
