use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    InvalidInput,
    EvidenceRejected,
    MissingExecutable,
    UnsupportedOperation,
    AuthenticationFailed,
    PermissionDenied,
    AmbiguousNotFound,
    RateLimited,
    NetworkFailed,
    MalformedResponse,
    OutputLimit,
    InputLimit,
    Timeout,
    Cancelled,
    ProcessFailed,
    IdentityMismatch,
    MissingProject,
    AmbiguousRemote,
    AmbiguousRequest,
    UnsupportedProvider,
    MigrationRequired,
    IoFailed,
    OwnershipConflict,
    ConcurrentEdit,
    UnsafePath,
    LockBusy,
    RollbackConflict,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: Code,
    pub operation: String,
    pub message: String,
    pub remedy: String,
}
impl Diagnostic {
    pub fn new(code: Code, operation: &str, message: &str, remedy: &str) -> Self {
        Self {
            code,
            operation: operation.into(),
            message: message.into(),
            remedy: remedy.into(),
        }
    }
    pub fn input(message: &str) -> Self {
        Self::new(
            Code::InvalidInput,
            "input",
            message,
            "Check command help and supply valid explicit input.",
        )
    }
    pub fn exit(&self) -> u8 {
        match self.code {
            Code::InvalidInput | Code::InputLimit => 2,
            Code::Cancelled => 130,
            Code::EvidenceRejected => 1,
            _ => 3,
        }
    }
}
impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {} {}", self.operation, self.message, self.remedy)
    }
}
impl std::error::Error for Diagnostic {}

/// Raw provider stderr may contain private URLs, commands or credentials.
/// Only classification crosses the adapter boundary; raw bytes are never logged.
pub fn classify_failure(operation: &str, stderr: &[u8]) -> Diagnostic {
    let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let (code, message, remedy) = if operation == "git"
        && (text.contains("not a git repository") || text.contains("must be run in a work tree"))
    {
        (
            Code::MissingProject,
            "This directory is not a Git working tree.",
            "Run project operations from an existing Git working tree; account-only probes need no repository.",
        )
    } else if text.contains("rate limit") || text.contains("http 429") {
        (
            Code::RateLimited,
            "The API rate limit prevents this read.",
            "Wait for the native rate limit to reset, then retry.",
        )
    } else if text.contains("http 401")
        || text.contains("not logged")
        || text.contains("auth login")
        || text.contains("authentication failed")
    {
        (
            Code::AuthenticationFailed,
            "The selected CLI session is not authenticated.",
            "Authenticate the selected host with gh auth login or glab auth login, then retry.",
        )
    } else if text.contains("http 403")
        || text.contains("forbidden")
        || text.contains("not accessible by integration")
    {
        (
            Code::PermissionDenied,
            "The authenticated session cannot read this resource.",
            "Check the native repository read permissions for this operation.",
        )
    } else if text.contains("http 404") || text.contains("not found") {
        (
            Code::AmbiguousNotFound,
            "The resource is missing or inaccessible to this session.",
            "Verify repository identity and access before treating it as absent.",
        )
    } else if [
        "could not resolve",
        "no such host",
        "connection",
        "connecting",
        "network",
        "tls",
        "certificate",
        "timed out",
        "http 5",
    ]
    .iter()
    .any(|s| text.contains(s))
    {
        (
            Code::NetworkFailed,
            "The selected host could not be reached reliably.",
            "Check network and the forge CLI TLS configuration, then retry.",
        )
    } else if text.contains("unknown command")
        || text.contains("unknown flag")
        || text.contains("unrecognized")
    {
        (
            Code::UnsupportedOperation,
            "The installed executable does not support this operation.",
            "Install a compatible native CLI and rerun doctor.",
        )
    } else {
        (
            Code::ProcessFailed,
            "The native command failed.",
            "Run the named operation through the authenticated native CLI to diagnose locally.",
        )
    };
    Diagnostic::new(code, operation, message, remedy)
}
