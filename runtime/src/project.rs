//! Git process adapter for the current project context.
pub use crate::identity::{Provider, Repository, parse_remote, valid_oid, validate_host};
use crate::{
    diagnostic::{Code, Diagnostic, classify_failure},
    process::{Process, Request, resolve_executable},
};
use serde::Serialize;
use std::path::{Path, PathBuf};

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
    let mut request =
        Request::new(resolve_executable("git")?, cwd, "git").args(args.iter().copied());
    // Native error classification is a machine protocol, independent of the caller's UI locale.
    request.env.insert("LC_ALL".into(), "C".into());
    // Native SHA evidence must describe the actual objects, not local replacement views.
    request
        .env
        .insert("GIT_NO_REPLACE_OBJECTS".into(), "1".into());
    request.env.insert("GIT_GRAFT_FILE".into(), "".into());
    let output = process.run(request).await?;
    if output.code != 0 {
        return Err(classify_failure("git", &output.stderr));
    }
    Ok(output.stdout)
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
    let dirty = !git(
        process,
        &root,
        &["--no-optional-locks", "status", "--porcelain=v1", "-z"],
    )
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
