//! Immutable native repository files. A complete tree proves absence; a failed GET does not.
use crate::{
    config::MAX_BYTES,
    diagnostic::{Code, Diagnostic},
    native_delivery::prefix,
    probe::{ForgeRead, encode},
    project::{Provider, Repository},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Serialize)]
pub struct File {
    pub commit: String,
    pub blob: Option<String>,
    #[serde(skip)]
    pub bytes: Option<Vec<u8>>,
}
fn malformed() -> Diagnostic {
    Diagnostic::new(
        Code::MalformedResponse,
        "native_file",
        "Immutable repository file evidence is incomplete or inconsistent.",
        "Verify the exact commit, full tree and regular-file blob through the selected native CLI.",
    )
}
pub fn object_id(value: &str) -> bool {
    [40, 64].contains(&value.len()) && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Diagnostic> {
    value.get(key).and_then(Value::as_str).ok_or_else(malformed)
}
fn object<'a>(value: &'a Value, key: &str) -> Result<&'a str, Diagnostic> {
    string(value, key).and_then(|s| {
        if object_id(s) {
            Ok(s)
        } else {
            Err(malformed())
        }
    })
}
/// Only root-level regular files are representable. Symlinks and submodules are not declarations.
pub async fn root_file(
    reader: &ForgeRead,
    repo: &Repository,
    commit: &str,
    name: &str,
) -> Result<File, Diagnostic> {
    if reader.provider != repo.provider
        || reader.host != repo.host
        || !object_id(commit)
        || name.is_empty()
        || name.contains(['/', '\\'])
        || [".", ".."].contains(&name)
        || name.chars().any(char::is_control)
    {
        return Err(Diagnostic::input(
            "An exact selected-repository commit and root filename are required.",
        ));
    }
    let base = prefix(repo);
    let rows = if repo.provider == Provider::Github {
        let value = reader.get(&format!("{base}/git/commits/{commit}")).await?;
        if object(&value, "sha")? != commit {
            return Err(malformed());
        }
        let tree = object(&value["tree"], "sha")?;
        // Omit recursive entirely: GitHub treats even recursive=false as true.
        let value = reader.get(&format!("{base}/git/trees/{tree}")).await?;
        if object(&value, "sha")? != tree
            || value.get("truncated").and_then(Value::as_bool) != Some(false)
        {
            return Err(malformed());
        }
        value
            .get("tree")
            .and_then(Value::as_array)
            .ok_or_else(malformed)?
            .clone()
    } else {
        let value = reader
            .get(&format!("{base}/repository/commits/{commit}"))
            .await?;
        if object(&value, "id")? != commit {
            return Err(malformed());
        }
        reader
            .list(
                &format!("{base}/repository/tree?ref={commit}&recursive=false"),
                None,
                10,
            )
            .await?
    };
    let mut paths = BTreeSet::new();
    let mut selected = None;
    for row in &rows {
        let path = string(row, "path")?;
        if path.is_empty() || path.contains('/') || !paths.insert(path) {
            return Err(malformed());
        }
        let id = object(
            row,
            if repo.provider == Provider::Github {
                "sha"
            } else {
                "id"
            },
        )?;
        let kind = string(row, "type")?;
        let mode = string(row, "mode")?;
        if path == name {
            if kind != "blob" || !["100644", "100755"].contains(&mode) {
                return Err(malformed());
            }
            selected = Some(id.to_owned());
        }
    }
    let Some(blob) = selected else {
        return Ok(File {
            commit: commit.into(),
            blob: None,
            bytes: None,
        });
    };
    let route = if repo.provider == Provider::Github {
        format!("{base}/git/blobs/{blob}")
    } else {
        format!("{base}/repository/blobs/{}", encode(&blob))
    };
    let value = reader.get(&route).await?;
    if repo.provider == Provider::Github && object(&value, "sha")? != blob {
        return Err(malformed());
    }
    let bytes = decode(&value)?;
    Ok(File {
        commit: commit.into(),
        blob: Some(blob),
        bytes: Some(bytes),
    })
}
fn decode(value: &Value) -> Result<Vec<u8>, Diagnostic> {
    let size = value
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(malformed)?;
    let content = string(value, "content")?;
    if size > MAX_BYTES as u64
        || content.len() > MAX_BYTES * 2
        || string(value, "encoding")? != "base64"
    {
        return Err(malformed());
    }
    let compact: String = content
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let bytes = STANDARD.decode(compact).map_err(|_| malformed())?;
    if bytes.len() as u64 != size {
        return Err(malformed());
    }
    Ok(bytes)
}
