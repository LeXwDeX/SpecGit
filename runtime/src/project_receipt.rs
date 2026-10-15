//! Complete project integration receipt decoding; no filesystem or process I/O.
use crate::diagnostic::{Code, Diagnostic};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    Generic,
    Claude,
    Codex,
    Opencode,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
pub enum HookPurpose {
    Guard,
    Context,
    Observe,
    None,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct HostRegistration {
    pub(crate) root: PathBuf,
    pub(crate) skill_hash: String,
    pub(crate) instructions: String,
    pub(crate) block: String,
    pub(crate) created_instructions: bool,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub(crate) struct Registration {
    pub(crate) settings: PathBuf,
    pub(crate) entries: BTreeMap<String, Value>,
    #[serde(default)]
    pub(crate) created_file: bool,
    #[serde(default)]
    pub(crate) created_hook_map: bool,
    #[serde(default)]
    pub(crate) created_event_keys: Vec<String>,
    // Persisted 2.3 project receipts contain this null field; project hooks never own an external skill.
    #[serde(default)]
    pub(crate) skill: Option<Value>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectReceipt {
    pub(crate) version: u8,
    pub(crate) owner: String,
    pub(crate) root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) shared_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) generation: Option<String>,
    pub(crate) agents: BTreeSet<Agent>,
    pub(crate) skills: BTreeMap<String, String>,
    pub(crate) instructions: BTreeMap<String, HostRegistration>,
    pub(crate) hooks: BTreeMap<String, Registration>,
    #[serde(default)]
    pub(crate) purposes: BTreeMap<String, BTreeSet<HookPurpose>>,
}

pub(crate) fn decode(bytes: &[u8]) -> Result<ProjectReceipt, Diagnostic> {
    let r: ProjectReceipt = serde_json::from_value(crate::input::json(bytes, 1_048_576, 20)?)
        .map_err(|_| conflict("The project integration receipt is malformed."))?;
    if ![1, 2, 3, 4].contains(&r.version)
        || (r.version == 1) != r.shared_root.is_some()
        || if r.version >= 3 {
            !r.generation.as_ref().is_some_and(|generation| {
                generation.len() == 64
                    && generation
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            })
        } else {
            r.generation.is_some()
        }
        || (r.version < 4 && !r.purposes.is_empty())
        || r.purposes.len() > 4
        || r.purposes.iter().any(|(host, purposes)| {
            !["generic", "claude", "codex", "opencode"].contains(&host.as_str())
                || purposes.contains(&HookPurpose::None)
                || purposes.contains(&HookPurpose::Observe)
        })
        || r.owner != "specgit"
        || r.agents.is_empty()
        || r.skills.len() > 2
        || r.instructions.len() > 3
        || r.hooks.len() > 3
        || r.skills.keys().any(|p| {
            ![
                ".agents/skills/specgit-native/SKILL.md",
                ".claude/skills/specgit-native/SKILL.md",
            ]
            .contains(&p.as_str())
        })
        || r.instructions.iter().any(|(host, g)| {
            g.root != r.root
                || !matches!(
                    (host.as_str(), g.instructions.as_str()),
                    ("generic", "AGENTS.md")
                        | ("codex", "AGENTS.md" | "AGENTS.override.md")
                        | ("claude", "CLAUDE.md")
                )
        })
        || r.hooks.iter().any(|(host, h)| {
            h.skill.is_some()
                || match host.as_str() {
                    "claude" => h.settings != r.root.join(".claude/settings.json"),
                    "codex" => h.settings != r.root.join(".codex/hooks.json"),
                    "opencode" => {
                        h.settings != r.root.join(".opencode/hooks.json") || h.created_hook_map
                    }
                    _ => true,
                }
        })
    {
        return Err(conflict(
            "The project integration receipt is unsupported or unsafe.",
        ));
    }
    let shared_guidance = r.instructions.contains_key("generic")
        || r.instructions
            .get("codex")
            .is_some_and(|g| g.instructions == "AGENTS.md");
    if !r
        .skills
        .contains_key(".agents/skills/specgit-native/SKILL.md")
        || r.skills
            .contains_key(".claude/skills/specgit-native/SKILL.md")
            != r.agents.contains(&Agent::Claude)
        || (r.hooks.contains_key("claude") && !r.agents.contains(&Agent::Claude))
        || (r.hooks.contains_key("codex") && !r.agents.contains(&Agent::Codex))
        || r.instructions.contains_key("claude") != r.agents.contains(&Agent::Claude)
        || (r.hooks.contains_key("opencode") && !r.agents.contains(&Agent::Opencode))
        || (r.version >= 4
            && (r.purposes.len() != r.agents.len()
                || r.purposes.iter().any(|(host, purposes)| {
                    let agent = match host.as_str() {
                        "generic" => Agent::Generic,
                        "claude" => Agent::Claude,
                        "codex" => Agent::Codex,
                        "opencode" => Agent::Opencode,
                        _ => return true,
                    };
                    !r.agents.contains(&agent)
                        || (purposes.contains(&HookPurpose::Context) != r.hooks.contains_key(host))
                        || (agent == Agent::Generic && purposes.contains(&HookPurpose::Context))
                })))
        || (r.agents.contains(&Agent::Codex)
            && !shared_guidance
            && !r.instructions.contains_key("codex"))
        || ((r.agents.contains(&Agent::Generic) || r.agents.contains(&Agent::Opencode))
            && !shared_guidance)
    {
        return Err(conflict(
            "The project receipt lacks required selected-agent ownership.",
        ));
    }
    Ok(r)
}

fn conflict(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "setup",
        message,
        "Preserve existing content and explicitly reconcile ownership before retrying.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_legacy_receipts_keep_their_original_version_contract() {
        for version in [1, 2, 3] {
            let mut value = serde_json::json!({
                "version": version, "owner": "specgit", "root": "project",
                "agents": ["generic"],
                "skills": {".agents/skills/specgit-native/SKILL.md": "digest"},
                "instructions": {"generic": {"root": "project", "skill_hash": "digest",
                    "instructions": "AGENTS.md", "block": "owned", "created_instructions": false}},
                "hooks": {}
            });
            if version == 1 {
                value["shared_root"] = Value::String("legacy".into());
            }
            if version == 3 {
                value["generation"] = Value::String("a".repeat(64));
            }
            let receipt = decode(&serde_json::to_vec(&value).unwrap()).unwrap();
            assert_eq!(receipt.version, version);
            assert!(receipt.purposes.is_empty());
        }
    }
}
