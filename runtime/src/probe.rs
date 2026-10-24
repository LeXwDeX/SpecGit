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

/// Optional descriptive evidence, never an authorization or capability decision.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EnvironmentFact {
    Known {
        value: String,
        source: &'static str,
    },
    Unknown {
        reason: &'static str,
        source: &'static str,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct GitlabEnvironment {
    pub host: String,
    pub metadata_status: &'static str,
    pub diagnostic: Option<Diagnostic>,
    pub deployment: EnvironmentFact,
    pub server_version: EnvironmentFact,
    pub edition: EnvironmentFact,
    pub subscription: EnvironmentFact,
}

/// Read metadata only after required reads. Non-GitLab providers make no request.
pub async fn environment(reader: &ForgeRead) -> Option<GitlabEnvironment> {
    if reader.provider != Provider::Gitlab {
        return None;
    }
    let unknown = |reason| EnvironmentFact::Unknown {
        reason,
        source: "GET metadata",
    };
    let known = |value: &str| EnvironmentFact::Known {
        value: value.into(),
        source: "GET metadata",
    };
    let mut result = GitlabEnvironment {
        host: reader.host.clone(),
        metadata_status: "unknown",
        diagnostic: None,
        deployment: if reader.host == "gitlab.com" {
            EnvironmentFact::Known {
                value: "official_hosted".into(),
                source: "host",
            }
        } else {
            EnvironmentFact::Unknown {
                reason: "Host does not distinguish self-managed from Dedicated or other deployments.",
                source: "host",
            }
        },
        server_version: unknown("Metadata could not be read."),
        edition: unknown("Metadata could not be read."),
        subscription: unknown(
            "Metadata does not provide subscription tier; edition and version do not establish a tier.",
        ),
    };
    match reader.get("metadata").await {
        Ok(value) if value.is_object() => {
            let version = value
                .get("version")
                .and_then(Value::as_str)
                .filter(|version| {
                    !version.is_empty()
                        && version.len() <= 128
                        && version.as_bytes()[0].is_ascii_digit()
                        && version
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b".+-_".contains(&byte))
                });
            let enterprise = value.get("enterprise").and_then(Value::as_bool);
            result.server_version =
                version.map_or_else(|| unknown("Metadata version is missing or invalid."), known);
            result.edition = enterprise.map_or_else(
                || unknown("Metadata enterprise boolean is missing or invalid."),
                |ee| known(if ee { "ee" } else { "ce" }),
            );
            if version.is_some() && enterprise.is_some() {
                result.metadata_status = "known";
            } else {
                reader.mark_inspection_incomplete();
                result.diagnostic = Some(malformed());
            }
        }
        Ok(_) => {
            reader.mark_inspection_incomplete();
            result.diagnostic = Some(malformed());
        }
        Err(diagnostic) => result.diagnostic = Some(diagnostic),
    }
    Some(result)
}

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

fn forge_commands(provider: Provider) -> Vec<Vec<&'static str>> {
    if provider == Provider::Github {
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
    }
}

pub async fn commands(process: &Process, cwd: &Path, provider: Provider) -> Vec<Probe> {
    let mut results = probe_executable(process, cwd, "git", provider).await;
    results.extend(probe_executable(process, cwd, provider.executable(), provider).await);
    results
}

/// Offline retirement probes Git only and reports the selected forge CLI
/// operations as intentionally not checked. Returns their exact names so the
/// caller can distinguish these known gaps from a failed probe.
pub(crate) async fn local_commands(
    process: &Process,
    cwd: &Path,
    provider: Provider,
) -> (Vec<Probe>, Vec<String>) {
    let mut results = probe_executable(process, cwd, "git", provider).await;
    let name = provider.executable();
    let mut unchecked = vec![format!("{name}_version")];
    unchecked.extend(
        forge_commands(provider)
            .iter()
            .map(|args| format!("{name} {}", args.join(" "))),
    );
    results.extend(
        unchecked
            .iter()
            .map(|operation| Probe::not_checked(operation)),
    );
    (results, unchecked)
}

async fn probe_executable(
    process: &Process,
    cwd: &Path,
    name: &str,
    provider: Provider,
) -> Vec<Probe> {
    let probe_started = Instant::now();
    let path = match resolve_executable(name) {
        Ok(path) => path,
        Err(d) => return vec![Probe::failed(name, d).measured(probe_started)],
    };
    let operation = format!("{name}_version");
    let out = process
        .run(Request::new(&path, cwd, &operation).args(["--version"]))
        .await;
    let mut results = vec![];
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
            return results;
        }
        Err(d) => {
            results.push(Probe::failed(&operation, d).measured(probe_started));
            return results;
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
    } else {
        forge_commands(provider)
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
    match reader.project_with_roles(&context.repository).await {
        Ok((facts, roles)) => {
            let mut evidence = serde_json::to_value(&facts).expect("facts serialize");
            evidence["role_permissions"] = serde_json::to_value(&roles).expect("roles serialize");
            evidence["write_permissions"] = serde_json::to_value(
                crate::delivery_model::write_permissions(&facts.repository, Some(&roles)),
            )
            .expect("permissions serialize");
            Probe::available("project_api", evidence).measured(started)
        }
        Err(d) => {
            if d.code == Code::MalformedResponse || d.code == Code::OutputLimit {
                reader.mark_inspection_incomplete();
            }
            Probe::failed("project_api", d).measured(started)
        }
    }
}

/// Attach facts collected in this invocation without an extra account/project read.
pub fn record_project_permissions(
    probes: &mut [Probe],
    facts: &ProjectFacts,
    roles: Option<&crate::delivery_model::ProjectRolePermissions>,
) {
    let permissions = crate::delivery_model::write_permissions(&facts.repository, roles);
    for probe in probes {
        if probe.operation == "account_api" {
            if !probe.evidence.is_object() {
                probe.evidence = serde_json::json!({});
            }
            probe.evidence["write_permissions"] =
                serde_json::to_value(&permissions).expect("permissions serialize");
        }
    }
}
