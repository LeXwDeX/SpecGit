use crate::{
    diagnostic::{Code, Diagnostic, classify_failure},
    process::{Process, Request, resolve_executable},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    str::FromStr,
};
use url::Url;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitlab,
}
impl Provider {
    pub fn executable(self) -> &'static str {
        match self {
            Self::Github => "gh",
            Self::Gitlab => "glab",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Repository {
    pub provider: Provider,
    pub host: String,
    pub path: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct Context {
    pub root: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    pub head: String,
    pub branch: Option<String>,
    pub dirty: bool,
    pub remote: String,
    pub repository: Repository,
}
fn trim_line(bytes: Vec<u8>) -> Result<String, Diagnostic> {
    let mut s = String::from_utf8(bytes).map_err(|_| {
        Diagnostic::new(
            Code::MalformedResponse,
            "git",
            "Git returned invalid UTF-8 for an identity field.",
            "Use a supported repository path and inspect Git output locally.",
        )
    })?;
    if s.ends_with('\n') {
        s.pop();
        if s.ends_with('\r') {
            s.pop();
        }
    }
    Ok(s)
}
pub async fn git(process: &Process, cwd: &Path, args: &[&str]) -> Result<Vec<u8>, Diagnostic> {
    let output = process
        .run(Request::new(resolve_executable("git")?, cwd, "git").args(args.iter().copied()))
        .await?;
    if output.code != 0 {
        return Err(classify_failure("git", &output.stderr));
    }
    Ok(output.stdout)
}
pub fn validate_host(host: &str) -> Result<String, Diagnostic> {
    if host.len() > 253
        || host.is_empty()
        || host.chars().any(|c| c.is_control() || c.is_whitespace())
        || host.contains(['/', '@', '?', '#', '\\'])
    {
        return Err(Diagnostic::input(
            "The API host must be a hostname with an optional port, without credentials or a URL path.",
        ));
    }
    let u = Url::parse(&format!("https://{host}"))
        .map_err(|_| Diagnostic::input("Invalid API host."))?;
    if u.host_str().is_none() || u.path() != "/" {
        return Err(Diagnostic::input("Invalid API host."));
    }
    Ok(host.to_ascii_lowercase())
}
pub fn parse_remote(
    raw: &str,
    selected: Option<Provider>,
    api_host: Option<&str>,
) -> Result<Repository, Diagnostic> {
    let invalid = || {
        Diagnostic::new(
            Code::UnsupportedProvider,
            "remote",
            "The selected remote is unsupported or ambiguous.",
            "Select an HTTPS or SSH forge remote and explicitly declare custom-host provider/API routing.",
        )
    };
    if raw.len() > 4096
        || raw.chars().any(|c| c.is_control() || c.is_whitespace())
        || raw.contains(['\\', '%'])
        || raw.split('/').any(|part| part == "." || part == "..")
    {
        return Err(invalid());
    }
    let value = if raw.contains("://") {
        raw.to_owned()
    } else {
        let (host, path) = raw.split_once(':').ok_or_else(invalid)?;
        if !host.contains('@') || path.starts_with('/') {
            return Err(invalid());
        }
        format!("ssh://{host}/{path}")
    };
    let u = Url::from_str(&value).map_err(|_| invalid())?;
    if !["https", "ssh"].contains(&u.scheme())
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || (u.scheme() == "https" && !u.username().is_empty())
    {
        return Err(invalid());
    }
    let host = u.host_str().ok_or_else(invalid)?.to_ascii_lowercase();
    let provider = selected
        .or(match host.as_str() {
            "github.com" => Some(Provider::Github),
            "gitlab.com" => Some(Provider::Gitlab),
            _ => None,
        })
        .ok_or_else(invalid)?;
    let path = u
        .path()
        .strip_prefix('/')
        .ok_or_else(invalid)?
        .trim_end_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| u.path().trim_matches('/'))
        .to_owned();
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() < 2
        || (provider == Provider::Github && parts.len() != 2)
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
    {
        return Err(invalid());
    }
    let host = if let Some(api_host) = api_host {
        validate_host(api_host)?
    } else if u.scheme() == "https" {
        u.port().map(|p| format!("{host}:{p}")).unwrap_or(host)
    } else {
        host
    };
    Ok(Repository {
        provider,
        host,
        path,
    })
}
pub async fn resolve(
    process: &Process,
    cwd: &Path,
    remote: Option<&str>,
    provider: Option<Provider>,
    api_host: Option<&str>,
) -> Result<Context, Diagnostic> {
    let root = PathBuf::from(trim_line(
        git(process, cwd, &["rev-parse", "--show-toplevel"]).await?,
    )?);
    let remotes = trim_line(git(process, &root, &["remote"]).await?)?;
    let names: Vec<_> = remotes.lines().filter(|s| !s.is_empty()).collect();
    let remote = match remote {
        Some(r) if names.contains(&r) => r.to_owned(),
        Some(_) => return Err(Diagnostic::input("The selected remote does not exist.")),
        None if names.len() == 1 => names[0].to_owned(),
        _ => {
            return Err(Diagnostic::new(
                Code::AmbiguousRemote,
                "project",
                "Select one existing Git remote explicitly.",
                "Use --remote with the intended forge remote; no remote is changed.",
            ));
        }
    };
    let raw = trim_line(git(process, &root, &["remote", "get-url", &remote]).await?)?;
    let repository = parse_remote(&raw, provider, api_host)?;
    let head = trim_line(git(process, &root, &["rev-parse", "--verify", "HEAD"]).await?)?;
    if !valid_oid(&head) {
        return Err(Diagnostic::new(
            Code::MalformedResponse,
            "git",
            "Git returned an invalid object ID.",
            "Inspect the repository object database.",
        ));
    }
    let branch = trim_line(git(process, &root, &["rev-parse", "--abbrev-ref", "HEAD"]).await?)?;
    let git_dir = PathBuf::from(trim_line(
        git(process, &root, &["rev-parse", "--absolute-git-dir"]).await?,
    )?);
    let common_dir = PathBuf::from(trim_line(
        git(
            process,
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?,
    )?);
    let dirty = !git(process, &root, &["status", "--porcelain=v1", "-z"])
        .await?
        .is_empty();
    Ok(Context {
        root,
        git_dir,
        common_dir,
        head,
        branch: (branch != "HEAD").then_some(branch),
        dirty,
        remote,
        repository,
    })
}
pub fn valid_oid(s: &str) -> bool {
    [40, 64].contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}
