//! Shared read-only command, account and project probes. No write transport exists here.
use crate::{
    diagnostic::{Code, Diagnostic, classify_failure},
    process::{Process, Request, resolve_executable},
    project::{Context, Provider, Repository},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
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
    pub diagnostic: Option<Diagnostic>,
    pub evidence: Value,
}
impl Probe {
    fn available(operation: &str, evidence: Value) -> Self {
        Self {
            operation: operation.into(),
            status: Capability::Available,
            observed_at: now(),
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
            diagnostic: Some(diagnostic),
            evidence: Value::Null,
        }
    }
    pub fn not_checked(operation: &str) -> Self {
        Self {
            operation: operation.into(),
            status: Capability::NotChecked,
            observed_at: now(),
            diagnostic: None,
            evidence: Value::Null,
        }
    }
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone)]
pub struct ForgeRead {
    process: Process,
    executable: PathBuf,
    cwd: PathBuf,
    pub provider: Provider,
    pub host: String,
}
impl ForgeRead {
    pub fn new(
        process: Process,
        cwd: &Path,
        provider: Provider,
        host: &str,
    ) -> Result<Self, Diagnostic> {
        Self::with_executable(
            process,
            cwd,
            provider,
            host,
            resolve_executable(provider.executable())?,
        )
    }
    /// Explicit executable selection supports isolated native transports without
    /// changing global PATH or the user's authenticated configuration.
    pub fn with_executable(
        process: Process,
        cwd: &Path,
        provider: Provider,
        host: &str,
        executable: PathBuf,
    ) -> Result<Self, Diagnostic> {
        Ok(Self {
            process,
            executable: executable
                .canonicalize()
                .map_err(|_| Diagnostic::input("Selected executable is unavailable."))?,
            cwd: cwd.into(),
            provider,
            host: crate::project::validate_host(host)?,
        })
    }
    /// Only GET is representable, and callers pass a relative native API route.
    pub async fn get(&self, endpoint: &str) -> Result<Value, Diagnostic> {
        if endpoint.is_empty()
            || endpoint.starts_with(['/', '-'])
            || endpoint.contains("://")
            || endpoint.contains(['#', '\n', '\r'])
            || endpoint.len() > 8192
        {
            return Err(Diagnostic::input(
                "A bounded relative native API endpoint is required.",
            ));
        }
        let operation = match self.provider {
            Provider::Github => "github_api_read",
            Provider::Gitlab => "gitlab_api_read",
        };
        let output = self
            .process
            .run(Request::new(&self.executable, &self.cwd, operation).args([
                "api",
                "--hostname",
                &self.host,
                "--method",
                "GET",
                endpoint,
            ]))
            .await?;
        if output.code != 0 {
            return Err(classify_failure(operation, &output.stderr));
        }
        serde_json::from_slice(&output.stdout).map_err(|_| Diagnostic::new(Code::MalformedResponse, operation, "The native API returned malformed JSON.", "Inspect the selected CLI/API version; partial or malformed evidence cannot be accepted."))
    }
    pub async fn list(
        &self,
        endpoint: &str,
        key: Option<&str>,
        max_pages: usize,
    ) -> Result<Vec<Value>, Diagnostic> {
        if !(1..=100).contains(&max_pages) {
            return Err(Diagnostic::input(
                "Pagination budget must be between 1 and 100 pages.",
            ));
        }
        let mut rows = vec![];
        for page in 1..=max_pages {
            let separator = if endpoint.contains('?') { '&' } else { '?' };
            let body = self
                .get(&format!("{endpoint}{separator}per_page=100&page={page}"))
                .await?;
            let values = key
                .map(|key| body.get(key).unwrap_or(&Value::Null))
                .unwrap_or(&body)
                .as_array()
                .ok_or_else(malformed)?;
            if values.len() > 100 {
                return Err(malformed());
            }
            rows.extend(values.iter().cloned());
            if values.len() < 100 {
                return Ok(rows);
            }
        }
        Err(Diagnostic::new(
            Code::OutputLimit,
            "pagination",
            "The complete list exceeds the declared read budget.",
            "Narrow the native query; uninspected pages cannot establish absence or acceptance.",
        ))
    }
    pub async fn project(&self, repo: &Repository) -> Result<ProjectFacts, Diagnostic> {
        if self.provider != repo.provider || self.host != repo.host {
            return Err(identity_error());
        }
        let endpoint = match self.provider {
            Provider::Github => format!("repos/{}", repo.path),
            Provider::Gitlab => format!("projects/{}", encode(&repo.path)),
        };
        let value = self.get(&endpoint).await?;
        let id = value
            .get("id")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
            .ok_or_else(malformed)?;
        let path = value
            .get(if self.provider == Provider::Github {
                "full_name"
            } else {
                "path_with_namespace"
            })
            .and_then(Value::as_str)
            .ok_or_else(malformed)?;
        if !path.eq_ignore_ascii_case(&repo.path) {
            return Err(identity_error());
        }
        let default = value
            .get("default_branch")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(malformed)?;
        let cleanup = value
            .get(if self.provider == Provider::Github {
                "delete_branch_on_merge"
            } else {
                "remove_source_branch_after_merge"
            })
            .and_then(Value::as_bool);
        let closing = if self.provider == Provider::Gitlab {
            value
                .get("autoclose_referenced_issues")
                .and_then(Value::as_bool)
        } else {
            None
        };
        Ok(ProjectFacts {
            id,
            repository: repo.clone(),
            default_branch: default.into(),
            native_source_cleanup: cleanup,
            native_issue_closing: closing,
        })
    }
}
pub fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
fn malformed() -> Diagnostic {
    Diagnostic::new(
        Code::MalformedResponse,
        "api_identity",
        "The native response lacks required typed identity fields.",
        "Verify the selected host/API and retry; unknown fields do not prove success.",
    )
}
fn identity_error() -> Diagnostic {
    Diagnostic::new(
        Code::IdentityMismatch,
        "api_identity",
        "The response does not match the selected repository identity.",
        "Check for transfer/rename or wrong host routing before adopting the returned project.",
    )
}
pub use crate::delivery_model::ProjectFacts;

pub async fn commands(process: &Process, cwd: &Path, provider: Provider) -> Vec<Probe> {
    let mut results = vec![];
    for name in ["git", provider.executable()] {
        let path = match resolve_executable(name) {
            Ok(path) => path,
            Err(d) => {
                results.push(Probe::failed(name, d));
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
                results.push(Probe::available(&operation, serde_json::json!({"version":version,"executable":path,"identity":format!("{:x}",Sha256::digest(identity.as_bytes()))})));
            }
            Ok(out) => {
                results.push(Probe::failed(
                    &operation,
                    classify_failure(&operation, &out.stderr),
                ));
                continue;
            }
            Err(d) => {
                results.push(Probe::failed(&operation, d));
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
            let operation = format!("{name} {}", args.join(" "));
            match process
                .run(Request::new(&path, cwd, &operation).args(args))
                .await
            {
                Ok(out)
                    if (out.code == 0 || (name == "git" && out.code == 129))
                        && (!out.stdout.is_empty() || !out.stderr.is_empty()) =>
                {
                    results.push(Probe::available(&operation, Value::Null))
                }
                Ok(out) => results.push(Probe::failed(
                    &operation,
                    classify_failure(&operation, &out.stderr),
                )),
                Err(d) => results.push(Probe::failed(&operation, d)),
            }
        }
    }
    results
}
pub async fn account(reader: &ForgeRead) -> Probe {
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
            )
        }
        Ok(_) => Probe::failed("account_api", malformed()),
        Err(d) => Probe::failed("account_api", d),
    }
}
pub async fn inspect(reader: &ForgeRead, context: &Context) -> Probe {
    match reader.project(&context.repository).await {
        Ok(facts) => Probe::available(
            "project_api",
            serde_json::to_value(facts).expect("facts serialize"),
        ),
        Err(d) => Probe::failed("project_api", d),
    }
}
