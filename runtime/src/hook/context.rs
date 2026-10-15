//! Bounded input and the addressed project/branch context.
use super::{INPUT_LIMIT, Output, notice};
use crate::{
    config::{self, Language},
    diagnostic::Code,
    input,
    process::{Limits, Process},
    project,
};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

pub(super) struct Prepared {
    pub(super) context: project::Context,
    pub(super) language: Language,
    pub(super) session: String,
    pub(super) observation: config::Observation,
}
pub(super) async fn prepare(event: &str, bytes: &[u8]) -> Result<Option<Prepared>, Output> {
    if !matches!(event, "SessionStart" | "PreToolUse") {
        return Ok(None);
    }
    let payload = match input::json(bytes, INPUT_LIMIT, 32) {
        Ok(v) => v,
        Err(d) => return Err(notice(&d)),
    };
    if payload.get("hook_event_name").and_then(Value::as_str) != Some(event) {
        return Err(notice(
            "The hook event identity does not match the registered event.",
        ));
    }
    if payload
        .get("schema_version")
        .is_some_and(|v| v.as_u64() != Some(1))
    {
        return Err(notice("This hook input schema version is unsupported."));
    }
    let session = match payload.get("session_id").and_then(Value::as_str) {
        Some(s)
            if !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c)) =>
        {
            s
        }
        _ => return Err(notice("The hook session identity is missing or invalid.")),
    };
    let cwd = match payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    {
        Some(p) if p.is_absolute() => p,
        _ => return Err(notice("The hook cwd is missing or invalid.")),
    };
    let process = Process {
        limits: Limits {
            timeout: Duration::from_secs(2),
            output_bytes: 262_144,
            ..Limits::default()
        },
        ..Process::default()
    };
    let state = match project::git_state(&process, &cwd).await {
        Ok(state) => state,
        Err(_) => return Ok(None),
    };
    let root = &state.root;
    let marker = match config::read(root) {
        Ok(Some(d)) => d,
        Ok(None) => {
            return match config::worktree::declaration_lost(&process, root).await {
                Ok(None) => Ok(None),
                Ok(Some(lost)) => Err(notice(&lost)),
                Err(d) => Err(notice(&d)),
            };
        }
        Err(d) if d.code == Code::MigrationRequired => return Ok(None),
        Err(d) => return Err(notice(&d)),
    };
    let context = match project::resolve_git_state(
        &process,
        state,
        marker.remote.as_deref(),
        marker.provider,
        None,
    )
    .await
    {
        Ok(mut c) => {
            // Keep config::resolve's repository-scoped API routing semantics
            // while reusing the Git probe that selected the actual edit target.
            match config::read_routing(&c) {
                Ok(Some(routing)) => c.repository.host = routing.api_host,
                Ok(None) => {}
                Err(d) => return Err(notice(&d)),
            }
            c
        }
        Err(d) => return Err(notice(&d)),
    };
    Ok(Some(Prepared {
        context,
        language: marker.language,
        session: session.to_owned(),
        observation: marker.observation,
    }))
}

/// A bounded advisory offer cache; it is neither acknowledgment nor authorization.
pub(super) fn offer_all(
    context: &project::Context,
    session: &str,
    candidates: &[(&str, &str)],
) -> Result<String, crate::diagnostic::Diagnostic> {
    offer_at(&context.git_dir, session, candidates)
}
fn offer_at(
    git_dir: &std::path::Path,
    session: &str,
    candidates: &[(&str, &str)],
) -> Result<String, crate::diagnostic::Diagnostic> {
    use crate::assets::{AssetStore, Snapshot};
    use serde::{Deserialize, Serialize};
    if candidates.is_empty() {
        return Ok(String::new());
    }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Offer {
        key: String,
        digest: String,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Offers {
        version: u8,
        entries: Vec<Offer>,
    }
    let directory = git_dir.join("specgit-v2/hook-context");
    let path = directory.join("offers.json");
    let store = AssetStore::lock(
        &directory,
        std::slice::from_ref(&directory),
        Duration::from_millis(50),
    )?;
    let current = Snapshot::read(&path)?;
    let mut offers = if let Some(bytes) = current.bytes.as_deref() {
        let offers: Offers = serde_json::from_value(crate::input::json(bytes, 32_768, 6)?)
            .map_err(|_| {
                crate::diagnostic::Diagnostic::input(
                    "Invalid hook context offers; preserve them for inspection.",
                )
            })?;
        let hash = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        };
        if offers.version != 1
            || offers.entries.len() > 128
            || offers
                .entries
                .iter()
                .any(|offer| !hash(&offer.key) || !hash(&offer.digest))
            || offers
                .entries
                .iter()
                .map(|offer| &offer.key)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != offers.entries.len()
        {
            return Err(crate::diagnostic::Diagnostic::input(
                "Invalid hook context offer identities.",
            ));
        }
        offers
    } else {
        Offers {
            version: 1,
            entries: vec![],
        }
    };
    let mut selected = vec![];
    for (kind, text) in candidates {
        let key = crate::assets::hash(format!("{session}\0{kind}").as_bytes());
        let digest = crate::assets::hash(text.as_bytes());
        if offers
            .entries
            .iter()
            .any(|offer| offer.key == key && offer.digest == digest)
        {
            continue;
        }
        offers.entries.retain(|offer| offer.key != key);
        if offers.entries.len() == 128 {
            offers.entries.remove(0);
        }
        offers.entries.push(Offer { key, digest });
        selected.push(*text);
    }
    if selected.is_empty() {
        return Ok(String::new());
    }
    let text = selected.join("\n");
    let bytes = serde_json::to_vec(&offers).map_err(|_| {
        crate::diagnostic::Diagnostic::input("Hook context offers cannot be represented.")
    })?;
    store.checkpoint(&path, &current, &bytes)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    #[test]
    fn concurrent_sessions_each_receive_their_rules_and_keep_both_offer_records() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for index in 0..128 {
            super::offer_at(
                &root,
                &format!("older-{index}"),
                &[("session-rules", "Read Skill")],
            )
            .unwrap();
        }
        for round in 0..16 {
            let sessions = [format!("left-{round}"), format!("right-{round}")];
            let start = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let threads: Vec<_> = sessions
                    .iter()
                    .map(|session| {
                        let root = &root;
                        let start = &start;
                        scope.spawn(move || {
                            start.wait();
                            super::offer_at(root, session, &[("session-rules", "Read Skill")])
                        })
                    })
                    .collect();
                for thread in threads {
                    assert_eq!(thread.join().unwrap().unwrap(), "Read Skill");
                }
            });
            for session in sessions {
                assert!(
                    super::offer_at(&root, &session, &[("session-rules", "Read Skill")])
                        .unwrap()
                        .is_empty(),
                    "concurrent callback lost the offer record for {session}"
                );
            }
        }
    }

    #[test]
    fn advisory_offers_remain_bounded_after_more_than_one_thousand_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        for index in 0..1005 {
            assert_eq!(
                super::offer_at(
                    &root,
                    &format!("session-{index}"),
                    &[("session-rules", "Read Skill")]
                )
                .unwrap(),
                "Read Skill",
                "session {index} lost its context"
            );
        }
        assert!(
            super::offer_at(&root, "session-1004", &[("session-rules", "Read Skill")])
                .unwrap()
                .is_empty()
        );
        let directory = root.join("specgit-v2/hook-context");
        let entries: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(
            entries.len() <= 2,
            "advisory cache created extra files: {entries:?}"
        );
        assert!(!directory.join("assets/transactions").exists());
        let cache: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("offers.json")).unwrap()).unwrap();
        assert_eq!(cache["entries"].as_array().unwrap().len(), 128);
    }
}
