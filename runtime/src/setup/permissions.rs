//! Deterministic read-only command allowlist for supported host permissions.
//!
//! This is a security asset, not user configuration: the desired rule set must
//! come from these compile-time constants so a receipt and a refresh can never
//! widen write authority. Rules are rendered with spaces because every host
//! integration in this repository uses that spelling.
use crate::project_receipt::Agent;
use std::collections::BTreeSet;

/// One native command whose effects are bounded to local reads or previews.
pub struct ReadOnlyCommand {
    /// Arguments after the `specgit` executable.
    pub argv: &'static [&'static str],
    /// Why the command cannot mutate project or platform state.
    pub safety: &'static str,
}

const READ_ONLY_COMMANDS: &[ReadOnlyCommand] = &[
    ReadOnlyCommand {
        argv: &["status"],
        safety: "Reads local Git identity and the recorded checkpoint only.",
    },
    ReadOnlyCommand {
        argv: &["--help"],
        safety: "Prints the offline command contract.",
    },
    ReadOnlyCommand {
        argv: &["--version"],
        safety: "Prints the installed executable version.",
    },
    ReadOnlyCommand {
        argv: &["--schema"],
        safety: "Prints the offline typed command contract.",
    },
    ReadOnlyCommand {
        argv: &["setup", "--catalog"],
        safety: "Returns the offline capability catalog without reading the project.",
    },
    ReadOnlyCommand {
        argv: &["setup", "--dry-run"],
        safety: "Plans project assets without creating files, locks or transactions.",
    },
    ReadOnlyCommand {
        argv: &["doctor", "--offline"],
        safety: "Runs local static checks without authentication or network probes.",
    },
    ReadOnlyCommand {
        argv: &["init", "--dry-run"],
        safety: "Previews project initialization without writes.",
    },
    ReadOnlyCommand {
        argv: &["init", "--inspect"],
        safety: "Inspects native capability without writes.",
    },
    ReadOnlyCommand {
        argv: &["issue", "--dry-run"],
        safety: "Previews Issue preparation without local or native writes.",
    },
    ReadOnlyCommand {
        argv: &["issue", "--inspect"],
        safety: "Reads duplicate candidates without local or native writes.",
    },
    ReadOnlyCommand {
        argv: &["pr", "--dry-run"],
        safety: "Previews request preparation without local or native writes.",
    },
    ReadOnlyCommand {
        argv: &["pr", "--inspect"],
        safety: "Reads request preparation without local or native writes.",
    },
    ReadOnlyCommand {
        argv: &["update", "--check"],
        safety: "Reads release metadata without downloading or replacing the executable.",
    },
    ReadOnlyCommand {
        argv: &["skill", "--user", "--dry-run"],
        safety: "Previews the user Skill without creating or removing files.",
    },
    ReadOnlyCommand {
        argv: &["guard", "--install", "--dry-run"],
        safety: "Previews the native Git guard without creating hooks or state.",
    },
    ReadOnlyCommand {
        argv: &["guard", "--uninstall", "--dry-run"],
        safety: "Previews guard removal without deleting hooks or state.",
    },
    ReadOnlyCommand {
        argv: &["remove", "--dry-run"],
        safety: "Previews whole-project removal without writes.",
    },
];

/// Commands that stay outside the allowlist. `pr --status` is excluded because a
/// verified merged request makes it write `delivered_request` to the checkpoint.
pub fn read_only_commands() -> &'static [ReadOnlyCommand] {
    READ_ONLY_COMMANDS
}

/// The exact Claude Code `permissions.allow` rules for the current rule set.
pub fn claude_allow_rules() -> BTreeSet<String> {
    READ_ONLY_COMMANDS
        .iter()
        .map(|command| format!("Bash(specgit {} *)", command.argv.join(" ")))
        .collect()
}

/// Why this release does not write a host-managed allowlist for the agent.
pub fn decline_reason(agent: Agent) -> Option<&'static str> {
    match agent {
        Agent::Claude => None,
        Agent::Generic => Some(
            "Generic projects have no host permission configuration; approve each read-only command per invocation.",
        ),
        Agent::Codex => Some(
            "Codex approval and sandbox configuration is still experimental, and allow rules can be bypassed; approve each read-only command per invocation.",
        ),
        Agent::Opencode => Some(
            "OpenCode allows tools by default, so a read-only allowlist would require a global deny-by-default configuration with JSONC and multi-path ownership; approve each read-only command per invocation.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rule_set_stays_bounded_and_excludes_checkpoint_writes() {
        for command in read_only_commands() {
            assert!(!command.argv.is_empty());
            assert!(!command.safety.is_empty(), "{:?}", command.argv);
        }
        let rules = claude_allow_rules();
        assert_eq!(rules.len(), READ_ONLY_COMMANDS.len());
        assert!(rules.len() <= 64);
        let bounded = |rule: &str| {
            rule.starts_with("Bash(specgit ")
                && rule.ends_with(" *)")
                && !rule
                    .chars()
                    .any(|c| matches!(c, '\n' | '\r' | ';' | '|' | '&' | '$' | '`' | '\'' | '"'))
        };
        for rule in &rules {
            assert!(bounded(rule), "{rule}");
            assert!(!rule.contains("--status"), "{rule}");
            assert!(!rule.contains("--apply"), "{rule}");
            assert!(!rule.contains("--fix"), "{rule}");
            assert!(!rule.contains("watch"), "{rule}");
            assert!(!rule.contains("inbox"), "{rule}");
            assert!(!rule.contains("migrate"), "{rule}");
            assert!(!rule.contains("remove --apply"), "{rule}");
        }
        assert_eq!(decline_reason(Agent::Claude), None);
        for agent in [Agent::Generic, Agent::Codex, Agent::Opencode] {
            assert!(decline_reason(agent).is_some());
        }
    }
}
