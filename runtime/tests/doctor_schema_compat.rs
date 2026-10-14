use serde_json::{Value, json};
use specgit::{
    diagnostic::{Code, Diagnostic},
    report::Report,
};

fn report_schema() -> Value {
    serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap()
}
#[test]
fn historical_local_inspection_failures_remain_valid_reports() {
    let schema = report_schema();
    for diagnostic in [
        Diagnostic::input("The project declaration is malformed."),
        Diagnostic::new(
            Code::EvidenceRejected,
            "doctor",
            "The local selection cannot be used.",
            "Inspect the local project state and retry.",
        ),
    ] {
        // Before local failures moved into doctor health evidence, the CLI used
        // Report::failure and then attached this object in its LocalInspection
        // error branch. Keep accepting those already emitted v2 reports.
        let mut report = Report::failure("doctor", diagnostic);
        report.evidence = json!({
            "probes": [],
            "write_permissions": "not_checked"
        });
        let report = serde_json::to_value(report).unwrap();
        assert!(report["status"] == "invalid_input" || report["status"] == "rejected");
        jsonschema::draft202012::validate(&schema, &report)
            .unwrap_or_else(|error| panic!("historical doctor report rejected: {error}; {report}"));
    }
}
