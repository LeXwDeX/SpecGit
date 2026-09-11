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
    pub fn observation(operation: &str, a: crate::observation::Observation) -> Self {
        let exit = a.exit();
        let mut next_actions = vec![];
        if a.checks_outcome() == crate::observation::CheckOutcome::Failed {
            next_actions.push(serde_json::json!({"kind":"inspect_native_failure","remedy":"Inspect the native failure and repair within existing authorization; observe again after push."}));
        }
        if a.status == crate::observation::Status::MergedIssuesOpen {
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
