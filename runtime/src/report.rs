use crate::diagnostic::Diagnostic;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct Report {
    pub schema_version: u32,
    pub version: &'static str,
    pub operation: String,
    pub status: String,
    pub exit: u8,
    pub evidence: Value,
    pub diagnostics: Vec<Diagnostic>,
}
impl Report {
    pub fn assessment(operation: &str, a: crate::assessment::Assessment) -> Self {
        let exit = a.exit();
        Self {
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
