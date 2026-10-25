use crate::diagnostic::Diagnostic;
use serde::{Serialize, Serializer, ser::SerializeStruct};
use serde_json::Value;

#[derive(Debug)]
pub struct Report {
    pub schema_version: u32,
    pub version: &'static str,
    pub operation: String,
    pub status: String,
    pub exit: u8,
    pub evidence: Value,
    pub diagnostics: Vec<Diagnostic>,
    pub effects: Option<Effects>,
    pub next_actions: Vec<Value>,
}
impl Report {
    pub fn observation(operation: &str, a: crate::observation_model::Observation) -> Self {
        let exit = a.exit();
        let mut next_actions = vec![];
        if a.checks_outcome() == crate::observation_model::CheckOutcome::Failed {
            next_actions.push(serde_json::json!({"kind":"inspect_native_failure","remedy":"Inspect the native failure and repair within existing authorization; observe again after push."}));
        }
        if a.status == crate::observation_model::Status::MergedIssuesOpen {
            next_actions.push(serde_json::json!({"kind":"inspect_open_issues","agent_close_preference":a.evidence.close_issues_after_merge,"remedy":"Check native closing eligibility and issue identity. Agent closure requires explicit session authorization, confirmed merge and native readback; this command never closes issues."}));
        }

        Self {
            next_actions,
            effects: None,
            schema_version: 2,
            version: env!("CARGO_PKG_VERSION"),
            operation: operation.into(),
            status: a.status.as_str().into(),
            exit,
            evidence: if a.evidence.request.is_some() {
                serde_json::to_value(a.evidence).expect("typed evidence serializes")
            } else {
                Value::Null
            },
            diagnostics: a.diagnostics,
        }
    }

    pub fn success(operation: &str, status: &str, evidence: impl Serialize) -> Self {
        Self {
            next_actions: vec![],
            effects: None,
            schema_version: 2,
            version: env!("CARGO_PKG_VERSION"),
            operation: operation.into(),
            status: status.into(),
            exit: 0,
            evidence: serde_json::to_value(evidence).expect("typed report serializes"),
            diagnostics: vec![],
        }
    }
    pub fn failure(operation: &str, diagnostic: Diagnostic) -> Self {
        let exit = diagnostic.exit();
        Self {
            next_actions: vec![],
            effects: None,
            schema_version: 2,
            version: env!("CARGO_PKG_VERSION"),
            operation: operation.into(),
            status: match exit {
                1 => "rejected",
                2 => "invalid_input",
                _ => "unknown",
            }
            .into(),
            exit,
            evidence: Value::Null,
            diagnostics: vec![diagnostic],
        }
    }
}

/// Merge a local persistence failure into an otherwise complete observation.
///
/// Native evidence and the observation status stay intact. Only a call that
/// actually attempted the record modifies effects, and existing applied
/// operations are retained. A failure proven to happen before the write reports
/// `not_applied`; every other attempted failure keeps an unknown write outcome
/// until readback proves what applied. A failure before the record attempt adds
/// only its diagnostic and exit.
pub(crate) fn local_failure(
    report: &mut Report,
    action: &'static str,
    recovery: Value,
    diagnostic: Diagnostic,
    record_attempted: bool,
) {
    if record_attempted {
        let definitely_not_applied = matches!(
            diagnostic.code,
            crate::diagnostic::Code::InvalidInput
                | crate::diagnostic::Code::InputLimit
                | crate::diagnostic::Code::UnsafePath
                | crate::diagnostic::Code::OwnershipConflict
                | crate::diagnostic::Code::ConcurrentEdit
                | crate::diagnostic::Code::LockBusy
        );
        let mut effects = report.effects.take().unwrap_or_default();
        if !definitely_not_applied {
            effects.begin("local", action, recovery);
        }
        report.effects = Some(effects);
    }
    let exit = diagnostic.exit();
    if crate::diagnostic::exit_priority(exit) > crate::diagnostic::exit_priority(report.exit) {
        report.exit = exit;
    }
    report.diagnostics.push(diagnostic);
}

impl Serialize for Report {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("Report", 11)?;
        out.serialize_field("schema_version", &self.schema_version)?;
        out.serialize_field("version", &self.version)?;
        out.serialize_field("operation", &self.operation)?;
        out.serialize_field("ok", &(self.exit == 0))?;
        out.serialize_field("status", &self.status)?;
        out.serialize_field("exit", &self.exit)?;
        out.serialize_field("evidence", &self.evidence)?;
        out.serialize_field("diagnostics", &self.diagnostics)?;
        if let Some(effects) = &self.effects {
            out.serialize_field("effects", effects)?;
        }
        let mut actions = self.next_actions.clone();
        actions.extend(self.diagnostics.iter().map(
            |d| serde_json::json!({"kind":"inspect_diagnostic","code":d.code,"remedy":d.remedy}),
        ));
        out.serialize_field("next_actions", &actions)?;
        out.end()
    }
}

/// Per-invocation write journal. A failed transport never proves a write did not apply.
#[derive(Debug, Serialize)]
pub struct Effects {
    pub outcome: &'static str,
    pub operations: Vec<Effect>,
}
#[derive(Debug, Serialize)]
pub struct Effect {
    pub scope: &'static str,
    pub action: &'static str,
    pub outcome: &'static str,
    pub recovery: Value,
}
impl Default for Effects {
    fn default() -> Self {
        Self {
            outcome: "not_applied",
            operations: vec![],
        }
    }
}
impl Effects {
    pub fn begin(&mut self, scope: &'static str, action: &'static str, recovery: Value) -> usize {
        self.outcome = "unknown";
        let index = self.operations.len();
        self.operations.push(Effect {
            scope,
            action,
            outcome: "unknown",
            recovery,
        });
        index
    }
    pub fn applied(&mut self, index: usize) {
        self.operations[index].outcome = "applied";
        self.outcome = if self.operations.iter().any(|op| op.outcome == "unknown") {
            "unknown"
        } else {
            "applied"
        };
    }
    pub fn locator(&mut self, index: usize, name: &str, id: u64) {
        self.operations[index].recovery[name] = id.into();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostic::Code;

    fn report() -> Report {
        Report::success("test", "ok", serde_json::json!({}))
    }

    #[test]
    fn attempted_unknown_keeps_previous_operations() {
        let mut report = report();
        let mut effects = Effects::default();
        let first = effects.begin("local", "first", serde_json::json!({}));
        effects.applied(first);
        report.effects = Some(effects);

        local_failure(
            &mut report,
            "second",
            serde_json::json!({}),
            Diagnostic::new(Code::IoFailed, "test", "failed", "retry"),
            true,
        );

        let effects = report.effects.as_ref().unwrap();
        assert_eq!(effects.outcome, "unknown");
        assert_eq!(effects.operations.len(), 2);
        assert_eq!(effects.operations[0].outcome, "applied");
        assert_eq!(effects.operations[1].outcome, "unknown");
        assert_eq!(report.exit, 3);
    }

    #[test]
    fn prepare_failure_does_not_claim_a_write() {
        let mut report = report();
        local_failure(
            &mut report,
            "record",
            serde_json::json!({}),
            Diagnostic::new(Code::IoFailed, "prepare", "failed", "retry"),
            false,
        );

        assert!(report.effects.is_none());
        assert_eq!(report.exit, 3);
        assert_eq!(report.diagnostics.len(), 1);
    }

    #[test]
    fn attempted_prewrite_failure_keeps_previous_success() {
        let mut report = report();
        let mut effects = Effects::default();
        let first = effects.begin("local", "first", serde_json::json!({}));
        effects.applied(first);
        report.effects = Some(effects);

        local_failure(
            &mut report,
            "second",
            serde_json::json!({}),
            Diagnostic::new(Code::LockBusy, "test", "busy", "retry"),
            true,
        );

        let effects = report.effects.as_ref().unwrap();
        assert_eq!(effects.outcome, "applied");
        assert_eq!(effects.operations.len(), 1);
        assert_eq!(effects.operations[0].outcome, "applied");
        assert_eq!(report.exit, 3);
    }
}
