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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct HostRegistration {
    pub(crate) root: PathBuf,
    pub(crate) skill_hash: String,
    pub(crate) instructions: String,
    pub(crate) block: String,
    pub(crate) created_instructions: bool,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
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
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadonlyPermissionRegistration {
    pub(crate) settings: PathBuf,
    pub(crate) rules: BTreeSet<String>,
    #[serde(default)]
    pub(crate) preexisting: BTreeSet<String>,
    #[serde(default)]
    pub(crate) created_file: bool,
    #[serde(default)]
    pub(crate) created_permissions_object: bool,
    #[serde(default)]
    pub(crate) created_allow_array: bool,
    #[serde(default)]
    pub(crate) created_rules: BTreeSet<String>,
}
#[derive(Serialize, Deserialize, Debug)]
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) readonly_permissions: BTreeMap<String, ReadonlyPermissionRegistration>,
}

/// A rule is only the exact `Bash(specgit <argv> *)` shape this runtime writes.
/// Layer 0 cannot know the current rule set; it rejects anything that could be
/// re-pointed at another executable or inject another shell command. The argv
/// must be non-empty and free of parentheses, so `Bash(specgit *)` and
/// concatenated rules such as `Bash(specgit status *) Bash(npm *)` are invalid.
fn valid_rule(rule: &str) -> bool {
    let Some(argv) = rule
        .strip_prefix("Bash(specgit ")
        .and_then(|rule| rule.strip_suffix(" *)"))
    else {
        return false;
    };
    rule.chars().count() <= 256
        && !argv.is_empty()
        && !argv.contains(['(', ')'])
        && !rule
            .chars()
            .any(|c| matches!(c, '\n' | '\r' | ';' | '|' | '&' | '$' | '`' | '\'' | '"'))
}

pub(crate) fn decode(bytes: &[u8]) -> Result<ProjectReceipt, Diagnostic> {
    let r: ProjectReceipt = serde_json::from_value(crate::input::json(bytes, 1_048_576, 20)?)
        .map_err(|_| conflict("The project integration receipt is malformed."))?;
    if r.version > 5 {
        return Err(Diagnostic::new(
            Code::OwnershipConflict,
            "setup",
            "The project integration receipt was written by a newer SpecGit and cannot be safely read.",
            "Upgrade the shared CLI before running setup. To downgrade, use the newer CLI to remove the managed read-only permissions first; preserve the receipt and assets until then.",
        ));
    }
    if ![1, 2, 3, 4, 5].contains(&r.version)
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
        || (r.version < 5 && !r.readonly_permissions.is_empty())
        || (r.version == 5 && r.readonly_permissions.is_empty())
        || r.readonly_permissions.len() > 1
        || r.readonly_permissions.iter().any(|(host, permissions)| {
            host != "claude"
                || !r.agents.contains(&Agent::Claude)
                || permissions.settings != r.root.join(".claude/settings.json")
                || permissions.rules.is_empty()
                || permissions.rules.len() > 64
                || permissions.preexisting.len() > 64
                || !permissions.created_rules.is_subset(&permissions.rules)
                || !permissions.rules.is_disjoint(&permissions.preexisting)
                || permissions
                    .rules
                    .iter()
                    .chain(&permissions.preexisting)
                    .any(|rule| !valid_rule(rule))
                || r.hooks.get(host).is_some_and(|hooks| {
                    hooks.settings != permissions.settings
                        || hooks.created_file != permissions.created_file
                })
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

    fn base(version: u8) -> Value {
        let mut value = serde_json::json!({
            "version": version, "owner": "specgit", "root": "project",
            "agents": ["claude"],
            "skills": {
                ".agents/skills/specgit-native/SKILL.md": "digest",
                ".claude/skills/specgit-native/SKILL.md": "digest"
            },
            "instructions": {"claude": {"root": "project", "skill_hash": "digest",
                "instructions": "CLAUDE.md", "block": "owned", "created_instructions": false}},
            "hooks": {},
            "purposes": {"claude": []}
        });
        if version >= 3 {
            value["generation"] = Value::String("a".repeat(64));
        }
        value
    }

    fn readonly_receipt() -> Value {
        let mut value = base(5);
        value["readonly_permissions"] = serde_json::json!({
            "claude": {
                "settings": "project/.claude/settings.json",
                "rules": ["Bash(specgit status *)", "Bash(specgit --help *)"],
                "preexisting": ["Bash(specgit doctor --offline *)"],
                "created_file": true,
                "created_permissions_object": true,
                "created_allow_array": true,
                "created_rules": ["Bash(specgit status *)", "Bash(specgit --help *)"]
            }
        });
        value
    }

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

    #[test]
    fn version_five_requires_and_serializes_readonly_permissions() {
        let receipt = decode(&serde_json::to_vec(&readonly_receipt()).unwrap()).unwrap();
        assert_eq!(receipt.version, 5);
        let registration = &receipt.readonly_permissions["claude"];
        assert_eq!(registration.rules.len(), 2);
        let serialized = serde_json::to_value(&receipt).unwrap();
        assert!(
            serialized["readonly_permissions"]["claude"]["rules"]
                .as_array()
                .unwrap()
                .contains(&Value::String("Bash(specgit status *)".into()))
        );

        // A v4 receipt must stay byte-identical when serialized again.
        let legacy = decode(&serde_json::to_vec(&base(4)).unwrap()).unwrap();
        let serialized = serde_json::to_value(&legacy).unwrap();
        assert!(serialized.get("readonly_permissions").is_none());
    }

    #[test]
    fn readonly_permission_invariants_reject_ambiguous_receipts() {
        for mutate in [
            |value: &mut Value| value["version"] = serde_json::json!(4),
            |value: &mut Value| value["agents"] = serde_json::json!([]),
            |value: &mut Value| {
                value["readonly_permissions"]["claude"]["settings"] =
                    serde_json::json!("other/settings.json")
            },
            |value: &mut Value| {
                value["readonly_permissions"]["claude"]["rules"] = serde_json::json!([])
            },
            |value: &mut Value| {
                value["readonly_permissions"]["claude"]["created_rules"] =
                    serde_json::json!(["Bash(specgit other *)"])
            },
            |value: &mut Value| {
                value["readonly_permissions"]["claude"]["preexisting"] =
                    serde_json::json!(["Bash(specgit status *)"])
            },
            |value: &mut Value| {
                value["readonly_permissions"]["claude"]["rules"][0] =
                    serde_json::json!("Bash(specgit status *); rm -rf /")
            },
            |value: &mut Value| {
                value["readonly_permissions"]["claude"]["rules"][0] =
                    serde_json::json!("Bash(npm test *)")
            },
            |value: &mut Value| {
                value["readonly_permissions"]["codex"] =
                    value["readonly_permissions"]["claude"].clone()
            },
        ] {
            let mut value = readonly_receipt();
            mutate(&mut value);
            assert_eq!(
                decode(&serde_json::to_vec(&value).unwrap())
                    .unwrap_err()
                    .code,
                Code::OwnershipConflict,
                "{value}"
            );
        }
        let mut value = base(4);
        value["readonly_permissions"] = readonly_receipt()["readonly_permissions"].clone();
        assert_eq!(
            decode(&serde_json::to_vec(&value).unwrap())
                .unwrap_err()
                .code,
            Code::OwnershipConflict
        );
        let value = base(5);
        assert_eq!(
            decode(&serde_json::to_vec(&value).unwrap())
                .unwrap_err()
                .code,
            Code::OwnershipConflict
        );
    }

    #[test]
    fn managed_rule_shape_rejects_empty_argv_and_concatenated_rules() {
        for rule in [
            "Bash(specgit *)",
            "Bash(specgit  *)",
            "Bash(specgit status *) Bash(npm *)",
            "Bash(specgit (status) *)",
        ] {
            let mut value = readonly_receipt();
            value["readonly_permissions"]["claude"]["rules"] = serde_json::json!([rule]);
            value["readonly_permissions"]["claude"]["created_rules"] = serde_json::json!([rule]);
            assert_eq!(
                decode(&serde_json::to_vec(&value).unwrap())
                    .unwrap_err()
                    .code,
                Code::OwnershipConflict,
                "{rule}"
            );
        }
    }

    #[test]
    fn every_current_managed_rule_decodes() {
        let rules: Vec<String> = crate::setup::permissions::claude_allow_rules()
            .into_iter()
            .collect();
        assert_eq!(rules.len(), 17);
        let mut value = readonly_receipt();
        value["readonly_permissions"]["claude"]["rules"] = serde_json::json!(&rules);
        value["readonly_permissions"]["claude"]["created_rules"] = serde_json::json!(&rules);
        // The fixture's preexisting `doctor --offline` rule is no longer in the
        // current set, but receipts recorded by older CLIs must still decode.
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_ok());
    }

    #[test]
    fn shared_settings_path_must_agree_on_created_file() {
        let mut value = readonly_receipt();
        value["purposes"]["claude"] = serde_json::json!(["context"]);
        value["hooks"] = serde_json::json!({"claude": {
            "settings": "project/.claude/settings.json", "entries": {},
            "created_file": false
        }});
        let error = decode(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert_eq!(error.code, Code::OwnershipConflict);
        value["hooks"]["claude"]["created_file"] = serde_json::json!(true);
        assert!(decode(&serde_json::to_vec(&value).unwrap()).is_ok());
    }

    #[test]
    fn newer_receipt_versions_are_actionable_conflicts() {
        let mut value = base(4);
        value["version"] = serde_json::json!(6);
        let error = decode(&serde_json::to_vec(&value).unwrap()).unwrap_err();
        assert_eq!(error.code, Code::OwnershipConflict);
        assert_eq!(error.exit(), 3);
        assert!(error.message.contains("newer"));
        assert!(
            error
                .remedy
                .contains("remove the managed read-only permissions")
        );
    }
}
