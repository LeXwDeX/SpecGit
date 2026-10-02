//! Shell-free transport with an exchange deadline and a bounded cleanup grace.
mod tree;
use crate::diagnostic::{Code, Diagnostic};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
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

#[derive(Debug, Clone, Serialize)]
pub struct ProcessActivity {
    pub operation: String,
    pub elapsed_ms: u64,
    pub outcome: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PaginationSummary {
    pub status: &'static str,
    pub pages_fetched: u64,
    pub items_seen: u64,
    pub page_limit: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct InspectionSummary {
    pub status: &'static str,
    pub budget_ms: u64,
    pub elapsed_ms: u64,
    pub requests_executed: u64,
    pub complete: bool,
    pub budget_exhausted: bool,
    pub pagination: PaginationSummary,
    pub activities: Vec<ProcessActivity>,
}

#[derive(Clone)]
pub struct InspectionBudget {
    started: Instant,
    deadline: Instant,
    budget: Duration,
    state: Arc<Mutex<InspectionState>>,
}

#[derive(Default)]
struct InspectionState {
    requests_executed: u64,
    pages_fetched: u64,
    items_seen: u64,
    page_limit: u64,
    pagination_applicable: bool,
    complete: bool,
    budget_exhausted: bool,
    finished_at: Option<Instant>,
    activities: Vec<ProcessActivity>,
}

impl InspectionBudget {
    fn new(budget: Duration) -> Self {
        let started = Instant::now();
        Self {
            started,
            deadline: started + budget,
            budget,
            state: Arc::new(Mutex::new(InspectionState {
                complete: true,
                ..InspectionState::default()
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, InspectionState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn remaining(&self) -> Duration {
        if self.lock().finished_at.is_some() {
            Duration::MAX
        } else {
            self.deadline.saturating_duration_since(Instant::now())
        }
    }

    fn request_started(&self) {
        let mut state = self.lock();
        if state.finished_at.is_some() {
            return;
        }
        state.requests_executed = state.requests_executed.saturating_add(1);
    }

    fn requests_executed(&self) -> u64 {
        self.lock().requests_executed
    }

    fn activity_finished(
        &self,
        operation: String,
        elapsed: Duration,
        result: &Result<Output, Diagnostic>,
    ) {
        let mut state = self.lock();
        if state.finished_at.is_some() {
            return;
        }
        let outcome = match result {
            Ok(_) => "finished",
            Err(d) if d.code == Code::Timeout => "timed_out",
            Err(_) => "failed",
        };
        if let Err(d) = result
            && matches!(
                d.code,
                Code::Timeout
                    | Code::NetworkFailed
                    | Code::MalformedResponse
                    | Code::OutputLimit
                    | Code::Cancelled
            )
        {
            state.complete = false;
        }
        state.activities.push(ProcessActivity {
            operation,
            elapsed_ms: duration_ms(elapsed),
            outcome,
        });
    }

    pub(crate) fn mark_incomplete(&self) {
        let mut state = self.lock();
        if state.finished_at.is_none() {
            state.complete = false;
        }
    }

    pub(crate) fn mark_exhausted(&self) {
        let mut state = self.lock();
        if state.finished_at.is_some() {
            return;
        }
        state.complete = false;
        state.budget_exhausted = true;
    }

    fn finish(&self) {
        let mut state = self.lock();
        state.finished_at.get_or_insert_with(Instant::now);
    }

    pub(crate) fn add_page_limit(&self, page_limit: usize) {
        let mut state = self.lock();
        if state.finished_at.is_some() {
            return;
        }
        state.pagination_applicable = true;
        state.page_limit = state.page_limit.saturating_add(page_limit as u64);
    }

    pub(crate) fn page_fetched(&self) {
        let mut state = self.lock();
        if state.finished_at.is_some() {
            return;
        }
        state.pages_fetched = state.pages_fetched.saturating_add(1);
    }

    pub(crate) fn items_seen(&self, items: usize) {
        let mut state = self.lock();
        if state.finished_at.is_some() {
            return;
        }
        state.items_seen = state.items_seen.saturating_add(items as u64);
    }

    pub(crate) fn summary(&self) -> InspectionSummary {
        let state = self.lock();
        let complete = state.complete && !state.activities.is_empty();
        let status = if state.budget_exhausted {
            "budget_exhausted"
        } else if state.activities.is_empty() {
            "not_run"
        } else if complete {
            "complete"
        } else {
            "incomplete"
        };
        let pagination_status = if state.budget_exhausted {
            "budget_exhausted"
        } else if !state.pagination_applicable {
            "not_applicable"
        } else if complete {
            "complete"
        } else {
            "incomplete"
        };
        InspectionSummary {
            status,
            budget_ms: duration_ms(self.budget),
            elapsed_ms: duration_ms(
                state
                    .finished_at
                    .map(|finished| finished.saturating_duration_since(self.started))
                    .unwrap_or_else(|| self.started.elapsed()),
            ),
            requests_executed: state.requests_executed,
            complete,
            budget_exhausted: state.budget_exhausted,
            pagination: PaginationSummary {
                status: pagination_status,
                pages_fetched: state.pages_fetched,
                items_seen: state.items_seen,
                page_limit: state.page_limit,
            },
            activities: state.activities.clone(),
        }
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

pub const DEFAULT_INSPECTION_BUDGET: Duration = Duration::from_secs(120);

/// Test fixtures may shorten the production budget without adding a production
/// environment override or waiting for the normal two-minute deadline.
pub fn configured_inspection_budget() -> Duration {
    #[cfg(feature = "test-fixtures")]
    if let Some(milliseconds) = std::env::var("SPECGIT_TEST_INSPECTION_BUDGET_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=120_000).contains(value))
    {
        return Duration::from_millis(milliseconds);
    }
    DEFAULT_INSPECTION_BUDGET
}

#[derive(Clone)]
pub struct Process {
    pub environment: BTreeMap<OsString, OsString>,
    pub limits: Limits,
    pub cancellation: CancellationToken,
    pub inspection_budget: Option<InspectionBudget>,
}
impl Default for Process {
    fn default() -> Self {
        Self {
            environment: BTreeMap::new(),
            limits: Limits::default(),
            cancellation: CancellationToken::new(),
            inspection_budget: None,
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
    pub fn with_inspection_budget(&self, budget: Duration) -> Self {
        let mut process = self.clone();
        process.inspection_budget = Some(InspectionBudget::new(budget));
        process
    }

    pub fn inspection_summary(&self) -> Option<InspectionSummary> {
        self.inspection_budget
            .as_ref()
            .map(InspectionBudget::summary)
    }

    pub fn inspection_requests_executed(&self) -> u64 {
        self.inspection_budget
            .as_ref()
            .map(InspectionBudget::requests_executed)
            .unwrap_or_default()
    }

    pub fn mark_inspection_incomplete(&self) {
        if let Some(budget) = &self.inspection_budget {
            budget.mark_incomplete();
        }
    }

    pub(crate) fn ensure_inspection_budget(&self, operation: &str) -> Result<(), Diagnostic> {
        if let Some(budget) = &self.inspection_budget
            && budget.remaining().is_zero()
        {
            budget.mark_exhausted();
            return Err(inspection_timeout(operation));
        }
        Ok(())
    }

    pub(crate) fn finish_inspection(&self) {
        if let Some(budget) = &self.inspection_budget {
            budget.finish();
        }
    }

    pub(crate) fn record_page_limit(&self, page_limit: usize) {
        if let Some(budget) = &self.inspection_budget {
            budget.add_page_limit(page_limit);
        }
    }

    pub(crate) fn record_page_fetched(&self) {
        if let Some(budget) = &self.inspection_budget {
            budget.page_fetched();
        }
    }

    pub(crate) fn record_page_items(&self, items: usize) {
        if let Some(budget) = &self.inspection_budget {
            budget.items_seen(items);
        }
    }

    /// Keep bounded pipe buffers and process cleanup state off callers' stacks.
    /// Deep command preflight must not multiply the size of the exchange future.
    pub fn run(
        &self,
        request: Request,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Output, Diagnostic>> + Send + '_>>
    {
        Box::pin(async move {
            let started = Instant::now();
            let operation = request.operation.clone();
            let result = self.run_inner(request).await;
            if let Some(budget) = &self.inspection_budget {
                budget.activity_finished(operation, started.elapsed(), &result);
            }
            result
        })
    }
    async fn run_inner(&self, request: Request) -> Result<Output, Diagnostic> {
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
        let (timeout, limited_by_invocation) = if let Some(budget) = &self.inspection_budget {
            let remaining = budget.remaining();
            if remaining.is_zero() {
                budget.mark_exhausted();
                return Err(inspection_timeout(&request.operation));
            }
            (
                remaining.min(self.limits.timeout),
                remaining <= self.limits.timeout,
            )
        } else {
            (self.limits.timeout, false)
        };
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
        if let Some(budget) = &self.inspection_budget
            && is_native_read(&request.operation)
        {
            budget.request_started();
        }
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
            result = tokio::time::timeout(timeout, exchange) => match result {
                Ok(result) => result,
                Err(_) if limited_by_invocation => {
                    if let Some(budget) = &self.inspection_budget {
                        budget.mark_exhausted();
                    }
                    Err(inspection_timeout(operation))
                }
                Err(_) => Err(Diagnostic::new(Code::Timeout, operation, "The command exceeded its deadline.", "Check native command connectivity; retry within a bounded budget.")),
            },
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
fn is_native_read(operation: &str) -> bool {
    matches!(
        operation,
        "github_api_read" | "gitlab_api_read" | "github_closing_issues_read"
    )
}

fn inspection_timeout(operation: &str) -> Diagnostic {
    Diagnostic::new(
        Code::Timeout,
        operation,
        "The inspection exceeded its invocation-wide time budget.",
        "Narrow the read-only inspection and retry; incomplete evidence cannot authorize writes.",
    )
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

#[cfg(test)]
mod inspection_tests {
    use super::*;

    const SLEEP_ENV: &str = "SPECGIT_PROCESS_TEST_SLEEP_MS";

    #[tokio::test]
    async fn finished_inspection_budget_does_not_limit_postflight_readback() {
        let runner = Process {
            limits: Limits {
                timeout: Duration::from_secs(2),
                ..Limits::default()
            },
            ..Process::default()
        }
        .with_inspection_budget(Duration::from_millis(50));
        runner.finish_inspection();

        let summary_before = serde_json::to_value(runner.inspection_summary().unwrap()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        let mut request = Request::new(
            std::env::current_exe().unwrap(),
            &std::env::current_dir().unwrap(),
            "postflight_readback",
        );
        request.args = vec![
            "--exact".into(),
            "process::inspection_tests::sleeping_child".into(),
            "--nocapture".into(),
        ];
        request.env.insert(SLEEP_ENV.into(), "150".into());

        let result = runner.run(request).await.unwrap();
        assert_eq!(result.code, 0);
        assert_eq!(
            serde_json::to_value(runner.inspection_summary().unwrap()).unwrap(),
            summary_before,
            "postflight reads must not alter the completed inspection evidence"
        );
    }

    #[test]
    fn sleeping_child() {
        if let Ok(milliseconds) = std::env::var(SLEEP_ENV) {
            std::thread::sleep(Duration::from_millis(milliseconds.parse().unwrap()));
        }
    }
}
