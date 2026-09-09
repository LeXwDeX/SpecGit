//! Shell-free transport with an exchange deadline and a bounded cleanup grace.
mod tree;
use crate::diagnostic::{Code, Diagnostic};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub struct Limits {
    pub timeout: Duration,
    pub input_bytes: usize,
    pub output_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(20),
            input_bytes: 1_048_576,
            output_bytes: 4_194_304,
        }
    }
}
#[derive(Clone, Debug)]
pub struct Request {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub input: Vec<u8>,
    pub env: BTreeMap<OsString, OsString>,
    pub operation: String,
}
impl Request {
    pub fn new(program: impl Into<PathBuf>, cwd: &Path, operation: &str) -> Self {
        Self {
            program: program.into(),
            cwd: cwd.into(),
            operation: operation.into(),
            args: vec![],
            input: vec![],
            env: BTreeMap::new(),
        }
    }
    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }
}
#[derive(Debug)]
pub struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
#[derive(Clone)]
pub struct Process {
    pub environment: BTreeMap<OsString, OsString>,
    pub limits: Limits,
    pub cancellation: CancellationToken,
}
impl Default for Process {
    fn default() -> Self {
        Self {
            environment: BTreeMap::new(),
            limits: Limits::default(),
            cancellation: CancellationToken::new(),
        }
    }
}
fn io_error(operation: &str) -> Diagnostic {
    Diagnostic::new(
        Code::IoFailed,
        operation,
        "Process I/O could not be completed.",
        "Check the executable and working directory, then retry.",
    )
}
async fn bounded_read(
    mut stream: impl AsyncRead + Unpin,
    limit: usize,
    operation: &str,
) -> Result<Vec<u8>, Diagnostic> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|_| io_error(operation))?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len().saturating_add(count) > limit {
            return Err(Diagnostic::new(
                Code::OutputLimit,
                operation,
                "The command exceeded its bounded output allowance.",
                "Narrow the native query; truncated evidence cannot be accepted.",
            ));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}
impl Process {
    pub async fn run(&self, request: Request) -> Result<Output, Diagnostic> {
        if request.input.len() > self.limits.input_bytes {
            return Err(Diagnostic::new(
                Code::InputLimit,
                &request.operation,
                "Input exceeds the operation's size limit.",
                "Reduce input before retrying.",
            ));
        }
        if self.cancellation.is_cancelled() {
            return Err(cancelled(&request.operation));
        }
        if !request.cwd.is_absolute()
            || !request.program.is_absolute()
            || self.limits.timeout.is_zero()
        {
            return Err(Diagnostic::input(
                "Process executable and cwd must be absolute; deadline must be positive.",
            ));
        }
        let mut command = Command::new(&request.program);
        command
            .args(&request.args)
            .current_dir(&request.cwd)
            .envs(&self.environment)
            .envs(&request.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        tree::prepare(&mut command);
        let mut child = command.spawn().map_err(|e| {
            Diagnostic::new(
                if e.kind() == std::io::ErrorKind::NotFound {
                    Code::MissingExecutable
                } else {
                    Code::ProcessFailed
                },
                &request.operation,
                "Could not start the selected executable.",
                "Install the executable or correct its configured path and working directory.",
            )
        })?;
        let tree = match tree::Tree::attach(&child) {
            Ok(tree) => tree,
            Err(_) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                return Err(io_error(&request.operation));
            }
        };
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io_error(&request.operation))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io_error(&request.operation))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io_error(&request.operation))?;
        let operation = request.operation.as_str();
        let exchange = async {
            let write = async {
                if !request.input.is_empty() {
                    stdin
                        .write_all(&request.input)
                        .await
                        .map_err(|_| io_error(operation))?;
                }
                drop(stdin);
                Ok::<(), Diagnostic>(())
            };
            let wait = async { child.wait().await.map_err(|_| io_error(operation)) };
            let ((), stdout, stderr, status) = tokio::try_join!(
                write,
                bounded_read(stdout, self.limits.output_bytes, operation),
                bounded_read(stderr, self.limits.output_bytes, operation),
                wait
            )?;
            Ok(Output {
                code: status.code().unwrap_or(130),
                stdout,
                stderr,
            })
        };
        let result = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(cancelled(operation)),
            result = tokio::time::timeout(self.limits.timeout, exchange) => result.unwrap_or_else(|_| Err(Diagnostic::new(Code::Timeout, operation, "The command exceeded its deadline.", "Check native command connectivity; retry within a bounded budget."))),
        };
        // Terminate the owned process tree even when its immediate parent exited
        // but descendants retained pipes. Then explicitly reap the direct child.
        drop(tree);
        if result.is_err() {
            let _ = child.start_kill();
        }
        // An OS-level uninterruptible child must not turn a timeout into an
        // unbounded wait. kill_on_drop retains Tokio's background reaping path.
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        result
    }
}
fn cancelled(operation: &str) -> Diagnostic {
    Diagnostic::new(
        Code::Cancelled,
        operation,
        "The operation was interrupted.",
        "Resume explicitly when ready; no completion is inferred.",
    )
}

pub fn resolve_executable(name: &str) -> Result<PathBuf, Diagnostic> {
    let path = Path::new(name);
    let candidates = if path.components().count() > 1 || path.is_absolute() {
        vec![path.to_path_buf()]
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .flat_map(|dir| {
                #[cfg(windows)]
                {
                    vec![dir.join(format!("{name}.exe")), dir.join(name)]
                }
                #[cfg(not(windows))]
                {
                    vec![dir.join(name)]
                }
            })
            .collect()
    };
    for candidate in candidates {
        if candidate.is_file() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate
                    .metadata()
                    .map(|m| m.permissions().mode() & 0o111 == 0)
                    .unwrap_or(true)
                {
                    continue;
                }
            }
            if let Ok(path) = candidate.canonicalize() {
                return Ok(path);
            }
        }
    }
    Err(Diagnostic::new(
        Code::MissingExecutable,
        "executable",
        "The selected native executable is unavailable.",
        "Install git and the selected gh or glab CLI, then rerun doctor.",
    ))
}
