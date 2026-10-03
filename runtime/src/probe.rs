//! Shared read-only command, account and project probes. No write transport exists here.
pub use crate::delivery_model::{Pagination, ProjectFacts};
pub use crate::forge_read::{ForgeRead, PaginatedRows, encode};
use crate::{
    diagnostic::{Code, Diagnostic, classify_failure},
    forge_read::malformed,
    identity::Provider,
    process::{Process, Request, resolve_executable},
    project::Context,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Available,
    Unavailable,
    Forbidden,
    Unknown,
    NotChecked,
}
#[derive(Debug, Clone, Serialize)]
pub struct Probe {
    pub operation: String,
    pub status: Capability,
    pub observed_at: u64,
    pub elapsed_ms: Option<u64>,
    pub diagnostic: Option<Diagnostic>,
    pub evidence: Value,
}
impl Probe {
    fn available(operation: &str, evidence: Value) -> Self {
        Self {
            operation: operation.into(),
            status: Capability::Available,
            observed_at: now(),
            elapsed_ms: None,
            diagnostic: None,
            evidence,
        }
    }
    pub(crate) fn failed(operation: &str, diagnostic: Diagnostic) -> Self {
        let status = match diagnostic.code {
            Code::PermissionDenied => Capability::Forbidden,
            Code::MissingExecutable | Code::UnsupportedOperation => Capability::Unavailable,
            _ => Capability::Unknown,
        };
        Self {
            operation: operation.into(),
            status,
            observed_at: now(),
            elapsed_ms: None,
            diagnostic: Some(diagnostic),
            evidence: Value::Null,
        }
    }
    pub fn not_checked(operation: &str) -> Self {
        Self {
            operation: operation.into(),
            status: Capability::NotChecked,
            observed_at: now(),
            elapsed_ms: None,
            diagnostic: None,
            evidence: Value::Null,
        }
    }

    fn measured(mut self, started: Instant) -> Self {
        self.elapsed_ms = Some(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        self
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub async fn commands(process: &Process, cwd: &Path, provider: Provider) -> Vec<Probe> {
    let mut results = vec![];
    for name in ["git", provider.executable()] {
        let probe_started = Instant::now();
        let path = match resolve_executable(name) {
            Ok(path) => path,
            Err(d) => {
                results.push(Probe::failed(name, d).measured(probe_started));
                continue;
            }
        };
        let operation = format!("{name}_version");
        let out = process
            .run(Request::new(&path, cwd, &operation).args(["--version"]))
            .await;
        match out {
            Ok(out) if out.code == 0 && !out.stdout.is_empty() => {
                // Record executable metadata rather than trusting a cached --help.
                // Command support is currently refreshed every invocation.
                let meta = std::fs::metadata(&path).ok();
                let identity = format!(
                    "{}:{}:{:?}",
                    path.display(),
                    meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    meta.and_then(|m| m.modified().ok())
                );
                let version: String = String::from_utf8_lossy(&out.stdout)
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(200)
                    .collect();
                results.push(Probe::available(&operation, serde_json::json!({"version":version,"executable":path,"identity":crate::assets::hash(identity.as_bytes())})).measured(probe_started));
            }
            Ok(out) => {
                results.push(
                    Probe::failed(&operation, classify_failure(&operation, &out.stderr))
                        .measured(probe_started),
                );
                continue;
            }
            Err(d) => {
                results.push(Probe::failed(&operation, d).measured(probe_started));
                continue;
            }
        }
        let commands: Vec<Vec<&str>> = if name == "git" {
            vec![
                vec!["--help"],
                vec!["rev-parse", "-h"],
                vec!["worktree", "-h"],
                vec!["status", "-h"],
                vec!["remote", "-h"],
            ]
        } else if provider == Provider::Github {
            vec![
                vec!["--help"],
                vec!["api", "--help"],
                vec!["issue", "view", "--help"],
                vec!["pr", "view", "--help"],
            ]
        } else {
            vec![
                vec!["--help"],
                vec!["api", "--help"],
                vec!["issue", "view", "--help"],
                vec!["mr", "view", "--help"],
            ]
        };
        for args in commands {
            let probe_started = Instant::now();
            let operation = format!("{name} {}", args.join(" "));
            match process
                .run(Request::new(&path, cwd, &operation).args(args))
                .await
            {
                Ok(out)
                    if (out.code == 0 || (name == "git" && out.code == 129))
                        && (!out.stdout.is_empty() || !out.stderr.is_empty()) =>
                {
                    results.push(Probe::available(&operation, Value::Null).measured(probe_started))
                }
                Ok(out) => results.push(
                    Probe::failed(&operation, classify_failure(&operation, &out.stderr))
                        .measured(probe_started),
                ),
                Err(d) => results.push(Probe::failed(&operation, d).measured(probe_started)),
            }
        }
    }
    results
}
pub async fn account(reader: &ForgeRead) -> Probe {
    let started = Instant::now();
    match reader.get("user").await {
        Ok(value)
            if value
                .get("id")
                .and_then(Value::as_u64)
                .is_some_and(|id| id > 0)
                && value
                    .get(if reader.provider == Provider::Github {
                        "login"
                    } else {
                        "username"
                    })
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty()) =>
        {
            Probe::available(
                "account_api",
                serde_json::json!({"host":reader.host,"authenticated":true,"write_permissions":"not_checked"}),
            ).measured(started)
        }
        Ok(_) => {
            reader.mark_inspection_incomplete();
            Probe::failed("account_api", malformed()).measured(started)
        }
        Err(d) => Probe::failed("account_api", d).measured(started),
    }
}
pub async fn inspect(reader: &ForgeRead, context: &Context) -> Probe {
    let started = Instant::now();
    match reader.project(&context.repository).await {
        Ok(facts) => Probe::available(
            "project_api",
            serde_json::to_value(facts).expect("facts serialize"),
        )
        .measured(started),
        Err(d) => {
            if d.code == Code::MalformedResponse || d.code == Code::OutputLimit {
                reader.mark_inspection_incomplete();
            }
            Probe::failed("project_api", d).measured(started)
        }
    }
}
