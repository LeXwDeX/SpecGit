//! Read and validate the proposed declaration before preparing project assets.
use super::Options;
use crate::{
    assets::Change,
    config::{self, Declaration, Language},
    diagnostic::{Code, Diagnostic},
    templates,
};
use std::path::Path;

pub(super) struct Prepared {
    pub declaration_change: Change,
    pub existing: Option<Declaration>,
    pub previous: Declaration,
    pub declaration: Declaration,
}

pub(super) fn prepare(
    options: &Options,
    root: &Path,
    language: &mut Language,
) -> Result<Prepared, Diagnostic> {
    let before = config::snapshot(root)?;
    let declaration_change = Change {
        path: root.join(".specgit.yaml"),
        permissions: before.permissions.clone(),
        before,
        after: None,
    };
    let existing = declaration_change
        .before
        .bytes
        .as_ref()
        .map(|bytes| Declaration::parse(bytes))
        .transpose()?;
    if existing.is_none() && crate::migration_assets::legacy_present(root)? {
        return Err(Diagnostic::new(
            Code::MigrationRequired,
            "init",
            "Existing v1 integration must be retired before initializing v2.",
            "Preview specgit migrate --config-file <v2.yaml>; preserve orphaned configuration and old work instead of enabling a competing integration.",
        ));
    }
    let previous = existing.clone().unwrap_or_default();
    let mut declaration = if let Some(path) = &options.config_file {
        Declaration::parse(templates::read_text(path)?.as_bytes())?
    } else {
        previous.clone()
    };
    if let Some(remote) = &options.remote {
        declaration.remote = Some(remote.clone());
    }
    if let Some(provider) = options.provider {
        declaration.provider = Some(provider);
    }
    if let Some(target) = &options.target {
        declaration.target = Some(target.clone());
    }
    if let Some(language) = options.language {
        declaration.language = language;
    }
    if options.manual_observe && options.native_auto_merge == Some(true) {
        return Err(Diagnostic::input(
            "Manual observation conflicts with native auto-merge=true.",
        ));
    }
    if let Some(enabled) = options.native_auto_merge {
        declaration.agent.native_auto_merge = enabled;
    }
    if options.manual_observe {
        declaration.agent.native_auto_merge = false;
    }
    *language = declaration.language;
    declaration.validate()?;
    Ok(Prepared {
        declaration_change,
        existing,
        previous,
        declaration,
    })
}
