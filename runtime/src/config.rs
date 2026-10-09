//! Local declaration file access and project-specific API routing.
//! Pure declaration parsing and validation live in `declaration`.
pub use crate::declaration::{
    Agent, Declaration, INIT_CHECK_IDS, InitPolicy, Labels, Language, MAX_BYTES, Notification,
    Observation, Source, Tag, Template, Templates, Validation, relative_path, valid_branch,
};
use crate::{
    assets::safe_path,
    declaration::invalid,
    diagnostic::{Code, Diagnostic},
    identity::{Provider, Repository, validate_host},
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
pub mod worktree;

pub fn snapshot(root: &Path) -> Result<crate::assets::Snapshot, Diagnostic> {
    bounded_snapshot(&root.join(".specgit.yaml"), MAX_BYTES)
}
fn bounded_snapshot(path: &Path, limit: usize) -> Result<crate::assets::Snapshot, Diagnostic> {
    use std::io::Read;
    safe_path(path)?;
    let file = match crate::assets::open_regular(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(crate::assets::Snapshot {
                bytes: None,
                permissions: None,
            });
        }
        Err(_) => {
            return Err(Diagnostic::new(
                Code::IoFailed,
                "configuration",
                "Cannot read the declaration.",
                "Restore local file access.",
            ));
        }
        Ok(f) => f,
    };
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(invalid());
    }
    let mut bytes = vec![];
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() > limit {
        return Err(invalid());
    }
    Ok(crate::assets::Snapshot {
        bytes: Some(bytes),
        permissions: Some(metadata.permissions()),
    })
}
pub fn read(root: &Path) -> Result<Option<Declaration>, Diagnostic> {
    snapshot(root)?
        .bytes
        .as_ref()
        .map(|bytes| Declaration::parse(bytes))
        .transpose()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LocalRouting {
    pub version: u8,
    pub repository: Repository,
    pub api_host: String,
}
pub fn routing_path(context: &crate::project::Context) -> PathBuf {
    context.git_dir.join("specgit-v2/local-routing.json")
}
fn parse_routing(bytes: &[u8]) -> Result<LocalRouting, Diagnostic> {
    let value = crate::input::json(bytes, 4096, 8)?;
    let r: LocalRouting = serde_json::from_value(value).map_err(|_| invalid())?;
    if r.version != 2 {
        return Err(invalid());
    }
    validate_host(&r.api_host)?;
    Ok(r)
}
pub fn read_routing(context: &crate::project::Context) -> Result<Option<LocalRouting>, Diagnostic> {
    let snapshot = bounded_snapshot(&routing_path(context), 4096)?;
    let Some(bytes) = snapshot.bytes else {
        return Ok(None);
    };
    let r = parse_routing(&bytes)?;
    if r.repository != context.repository {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "local_routing",
            "Local API routing belongs to a different remote identity.",
            "Inspect routing and explicitly select the intended API host before proceeding.",
        ));
    }
    Ok(Some(r))
}
pub fn routing_change(
    base: &crate::project::Context,
    host: &str,
) -> Result<crate::assets::Change, Diagnostic> {
    let path = routing_path(base);
    let before = bounded_snapshot(&path, 4096)?;
    if let Some(bytes) = &before.bytes {
        parse_routing(bytes)?;
    }
    let routing = LocalRouting {
        version: 2,
        repository: base.repository.clone(),
        api_host: validate_host(host)?,
    };
    let after = Some(serde_json::to_vec_pretty(&routing).map_err(|_| invalid())?);
    Ok(crate::assets::Change {
        path,
        permissions: before.permissions.clone(),
        before,
        after,
    })
}
pub async fn resolve(
    process: &crate::process::Process,
    cwd: &Path,
    remote: Option<&str>,
    provider: Option<Provider>,
    api_host: Option<&str>,
) -> Result<crate::project::Context, Diagnostic> {
    let mut context = crate::project::resolve(process, cwd, remote, provider, None).await?;
    let selected = if let Some(host) = api_host {
        Some(validate_host(host)?)
    } else {
        read_routing(&context)?.map(|r| r.api_host)
    };
    if let Some(host) = selected {
        context.repository.host = host;
    }
    Ok(context)
}
