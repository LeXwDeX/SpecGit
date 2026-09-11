//! Select a separately installed release artifact for public CLI qualification.
use std::{path::PathBuf, process::Command};
pub fn binary() -> PathBuf {
    std::env::var_os("SPECGIT_TEST_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_specgit")))
}
#[allow(dead_code)]
pub fn command() -> Command {
    if let Some(launcher) = std::env::var_os("SPECGIT_TEST_LAUNCHER") {
        let mut command = Command::new(
            std::env::var_os("SPECGIT_TEST_NODE")
                .expect("Installed launcher checks require the absolute Node executable."),
        );
        command.arg(launcher);
        command
    } else {
        Command::new(binary())
    }
}
