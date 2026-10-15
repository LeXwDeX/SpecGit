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
            eprintln!("{}", terminal_safe(&diagnostic.to_string()));
        }
        if report.operation == "setup" && report.status == "catalog" {
            print!("{}", specgit::setup::catalog::human());
        } else if report.operation == "doctor" {
            doctor_summary(&report);
        } else {
            println!(
                "{}",
                serde_json::to_string_pretty(&report.evidence).unwrap_or_default()
            );
        }
        for action in &report.next_actions {
            if let Some(remedy) = action.get("remedy").and_then(serde_json::Value::as_str) {
                println!("{}", terminal_safe(remedy));
            }
        }
    }
}

fn terminal_safe(text: &str) -> String {
    let mut safe = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_control() || matches!(character, '\u{2028}' | '\u{2029}') {
            safe.extend(character.escape_default());
        } else {
            safe.push(character);
        }
    }
    safe
}

fn doctor_summary(report: &Report) {
    let evidence = &report.evidence;
    if evidence
        .pointer("/runtime_update/status")
        .and_then(serde_json::Value::as_str)
        == Some("unknown")
    {
        let reason = evidence
            .pointer("/runtime_update/diagnostic/message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Release metadata could not be checked.");
        println!(
            "Runtime update: unknown. {} If useful, run `specgit update --check` explicitly to check again.",
            terminal_safe(reason)
        );
    }
    if evidence
        .pointer("/health/scope")
        .and_then(serde_json::Value::as_str)
        == Some("account_only")
    {
        println!(
            "{}",
            serde_json::to_string_pretty(evidence).unwrap_or_default()
        );
        return;
    }
    if let Some(root) = evidence
        .pointer("/local/context/root")
        .and_then(serde_json::Value::as_str)
    {
        println!(
            "Project: {}",
            terminal_safe(&serde_json::to_string(root).expect("JSON strings serialize"))
        );
    }
    if let Some(checks) = evidence
        .pointer("/health/checks")
        .and_then(serde_json::Value::as_array)
    {
        for check in checks {
            let id = check["id"].as_str().unwrap_or("check");
            let status = check["status"].as_str().unwrap_or("unknown");
            println!("  {id}: {status}");
        }
    }
    if let Some(results) = evidence
        .pointer("/repair/results")
        .and_then(serde_json::Value::as_array)
    {
        for result in results {
            println!(
                "Repair {}: {}",
                result["id"].as_str().unwrap_or("unknown"),
                result["status"].as_str().unwrap_or("unknown")
            );
        }
    }
    if let Some(plans) = evidence
        .pointer("/repair/plans")
        .and_then(serde_json::Value::as_array)
    {
        let changes: usize = plans
            .iter()
            .filter_map(|p| p["assets"].as_array())
            .map(Vec::len)
            .sum();
        if changes > 0 {
            println!(
                "Repair preview: {changes} asset changes. Use --json for paths and preconditions."
            );
        }
    }
    println!("Static checks only; real host loading and hook delivery are not verified.");
}

#[cfg(test)]
mod tests {
    use super::terminal_safe;

    #[test]
    fn action_remedy_keeps_plain_text_and_quotes_terminal_controls() {
        assert_eq!(
            terminal_safe("Review the repair plan."),
            "Review the repair plan."
        );
        assert_eq!(
            terminal_safe("Inspect path\nRepair forged: applied\u{1b}[31m"),
            "Inspect path\\nRepair forged: applied\\u{1b}[31m"
        );
        assert_eq!(terminal_safe("line\u{2028}break"), "line\\u{2028}break");
    }
}
