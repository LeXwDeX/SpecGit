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
/// Project asset writes require the repository rooted at the selected checkout.
/// Preserve Git's environment semantics for read-only probes and native guards.
pub fn require_local_repository_environment() -> Result<(), Diagnostic> {
    if ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]
        .iter()
        .any(|name| std::env::var_os(name).is_some())
    {
        return Err(Diagnostic::new(
            Code::InvalidInput,
            "project_environment",
            "Project asset operations do not support GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR overrides.",
            "Run the operation from its checkout without repository-location overrides; keep Git hook environment intact for guard.",
        ));
    }
    Ok(())
}

pub async fn git(process: &Process, cwd: &Path, args: &[&str]) -> Result<Vec<u8>, Diagnostic> {
    let mut request =
        Request::new(resolve_executable("git")?, cwd, "git").args(args.iter().copied());
    // Read-only status probes must not refresh the index as an optional side effect.
    // Required locks for explicit Git mutations are unaffected by this setting.
    request.env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
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
// One probe supplies all rev-parse fields. Hooks can reuse it after reading the
// declaration at its toplevel, without resolving the same worktree again.
pub(crate) struct GitState {
    pub(crate) root: PathBuf,
    fields: Result<GitFields, Diagnostic>,
}
struct GitFields {
    git_dir: PathBuf,
    common_dir: PathBuf,
    head: String,
    branch: String,
}
pub(crate) async fn git_state(process: &Process, cwd: &Path) -> Result<GitState, Diagnostic> {
    let output = git(
        process,
        cwd,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
            "HEAD",
            "--abbrev-ref",
            "HEAD",
        ],
    )
    .await;
    let bytes = match output {
        Ok(bytes) => bytes,
        Err(error) if error.code == Code::ProcessFailed => {
            // Unborn HEAD fails the combined probe. Preserve the old remote
            // diagnostics' precedence before reporting that identity failure.
            let root = PathBuf::from(trim_line(
                git(process, cwd, &["rev-parse", "--show-toplevel"]).await?,
            )?);
            return Ok(GitState {
                root,
                fields: Err(error),
            });
        }
        Err(error) => return Err(error),
    };
    match parse_git_state(bytes) {
        Ok(state) => Ok(state),
        Err(_) => {
            // Git's path fields are newline-delimited, not NUL-delimited. A
            // repository path can itself contain a newline. Fall back only for
            // ambiguous framing, preserving the separate-query path contract.
            let root = PathBuf::from(trim_line(
                git(process, cwd, &["rev-parse", "--show-toplevel"]).await?,
            )?);
            let fields = async {
                let head =
                    trim_line(git(process, &root, &["rev-parse", "--verify", "HEAD"]).await?)?;
                let branch =
                    trim_line(git(process, &root, &["rev-parse", "--abbrev-ref", "HEAD"]).await?)?;
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
                Ok(GitFields {
                    git_dir,
                    common_dir,
                    head,
                    branch,
                })
            }
            .await;
            Ok(GitState { root, fields })
        }
    }
}
fn parse_git_state(bytes: Vec<u8>) -> Result<GitState, Diagnostic> {
    let text = trim_line(bytes)?;
    let fields: Vec<_> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let [root, git_dir, common_dir, head, branch] = fields.as_slice() else {
        return Err(Diagnostic::new(
            Code::MalformedResponse,
            "git",
            "Git returned malformed identity fields.",
            "Inspect Git output locally.",
        ));
    };
    Ok(GitState {
        root: PathBuf::from(root),
        fields: Ok(GitFields {
            git_dir: PathBuf::from(git_dir),
            common_dir: PathBuf::from(common_dir),
            head: (*head).to_owned(),
            branch: (*branch).to_owned(),
        }),
    })
}

pub async fn resolve(
    process: &Process,
    cwd: &Path,
    remote: Option<&str>,
    provider: Option<Provider>,
    api_host: Option<&str>,
) -> Result<Context, Diagnostic> {
    let state = git_state(process, cwd).await?;
    resolve_git_state(process, state, remote, provider, api_host).await
}
pub(crate) async fn resolve_git_state(
    process: &Process,
    state: GitState,
    remote: Option<&str>,
    provider: Option<Provider>,
    api_host: Option<&str>,
) -> Result<Context, Diagnostic> {
    let GitState { root, fields } = state;
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
    let GitFields {
        git_dir,
        common_dir,
        head,
        branch,
    } = fields?;
    if !valid_oid(&head) {
        return Err(Diagnostic::new(
            Code::MalformedResponse,
            "git",
            "Git returned an invalid object ID.",
            "Inspect the repository object database.",
        ));
    }
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

#[cfg(test)]
mod batching_tests {
    use super::*;

    #[test]
    fn windows_paths_and_crlf_remain_separate_identity_fields() {
        let state = parse_git_state(
            format!(
                "C:/work tree/仓库\r\nC:/work tree/仓库/.git\r\nC:/main/.git\r\n{}\r\nwork/685\r\n",
                "a".repeat(40)
            )
            .into_bytes(),
        )
        .unwrap();
        let fields = state.fields.unwrap();
        assert_eq!(state.root, PathBuf::from("C:/work tree/仓库"));
        assert_eq!(fields.git_dir, PathBuf::from("C:/work tree/仓库/.git"));
        assert_eq!(fields.common_dir, PathBuf::from("C:/main/.git"));
        assert_eq!(fields.head, "a".repeat(40));
        assert_eq!(fields.branch, "work/685");
    }
}
