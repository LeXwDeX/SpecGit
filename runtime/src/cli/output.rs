//! Human presentation and the single-document report protocol.
use specgit::report::Report;
use std::io::{self, Write};

pub(super) fn emit(report: Report, json: bool) {
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
