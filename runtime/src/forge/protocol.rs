//! Private bounded transport and primitive decoding shared by concrete protocols.
use crate::{
    diagnostic::{Code, Diagnostic, classify_failure},
    process::{Process, Request, resolve_executable},
    project::Repository,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
pub(super) fn malformed() -> Diagnostic {
    Diagnostic::new(
        Code::MalformedResponse,
        "delivery",
        "Native delivery evidence is missing or malformed.",
        "Inspect the exact issue/request through the selected authenticated CLI; missing fields are not defaults.",
    )
}
pub(super) fn text(v: &Value, key: &str) -> Result<String, Diagnostic> {
    v.get(key)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(malformed)
}
pub(super) fn id(v: &Value, key: &str) -> Result<u64, Diagnostic> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(malformed)
}

pub(crate) struct WriteTransport {
    process: Process,
    executable: PathBuf,
    cwd: PathBuf,
    pub(super) repo: Repository,
}
impl WriteTransport {
    pub(crate) fn new(process: Process, cwd: &Path, repo: &Repository) -> Result<Self, Diagnostic> {
        Ok(Self {
            process,
            executable: resolve_executable(repo.provider.executable())?,
            cwd: cwd.into(),
            repo: repo.clone(),
        })
    }
    pub(super) async fn write(
        &self,
        method: &str,
        endpoint: &str,
        body: Value,
    ) -> Result<Value, Diagnostic> {
        let mut request = Request::new(&self.executable, &self.cwd, "delivery_write").args([
            "api",
            "--hostname",
            &self.repo.host,
            "--method",
            method,
            "--input",
            "-",
            endpoint,
        ]);
        request.input = serde_json::to_vec(&body).map_err(|_| malformed())?;
        let output = self.process.run(request).await?;
        if output.code != 0 {
            return Err(classify_failure("delivery_write", &output.stderr));
        }
        crate::input::json(&output.stdout, self.process.limits.output_bytes, 32)
    }
    pub(super) async fn ready(&self, args: Vec<String>) -> Result<(), Diagnostic> {
        let out = self
            .process
            .run(Request::new(&self.executable, &self.cwd, "request_ready").args(args))
            .await?;
        if out.code != 0 {
            return Err(classify_failure("request_ready", &out.stderr));
        }
        Ok(())
    }
}
