//! Best-effort host tool classification, not a file-write sandbox.
use serde_json::Value;

pub(super) fn relevant(event: &str, payload: &Value) -> bool {
    let tool = payload
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if ["Write", "Edit", "MultiEdit"].contains(&tool) || patch_tool(tool) {
        return true;
    }
    if !["Bash", "PowerShell"].contains(&tool) {
        return false;
    }
    let command = payload
        .pointer("/tool_input/command")
        .and_then(Value::as_str)
        .unwrap_or("");
    let compound = has_unquoted_shell_control(command);
    shell_segments(command)
        .into_iter()
        .any(|segment| segment_relevant(event, segment, compound))
}

fn executable(token: &str) -> &str {
    token
        .trim_matches(['\'', '"'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
}

fn assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

// Keep quoted words together, including assignment values and --cwd paths.
fn words(command: &str) -> Vec<&str> {
    let mut result = vec![];
    let mut start = None;
    let (mut single, mut double, mut escaped) = (false, false, false);
    for (index, character) in command.char_indices() {
        if !single && !double && !escaped && character.is_whitespace() {
            if let Some(start) = start.take() {
                result.push(&command[start..index]);
            }
            continue;
        }
        start.get_or_insert(index);
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if !single => escaped = true,
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            _ => {}
        }
    }
    if let Some(start) = start {
        result.push(&command[start..]);
    }
    result
}

fn command_index(tokens: &[&str]) -> usize {
    let mut index = 0;
    while let Some(token) = tokens.get(index) {
        if assignment(token) {
            index += 1;
            continue;
        }
        let name = executable(token);
        if !["sudo", "env", "command", "nohup", "time"].contains(&name) {
            break;
        }
        index += 1;
        while let Some(option) = tokens.get(index).filter(|s| s.starts_with('-')) {
            index += 1;
            if *option == "--" {
                break;
            }
            let takes_value = match name {
                "sudo" => [
                    "-u", "-g", "-h", "-p", "-C", "-T", "--user", "--group", "--host", "--prompt",
                    "--chdir",
                ]
                .contains(option),
                "env" => ["-u", "-C", "--unset", "--chdir"].contains(option),
                "time" => ["-f", "-o", "--format", "--output"].contains(option),
                _ => false,
            };
            if takes_value {
                index += 1;
            }
        }
    }
    index
}

fn segment_relevant(event: &str, command: &str, compound: bool) -> bool {
    let tokens = words(command);
    let index = command_index(&tokens);
    let name = tokens.get(index).map(|token| executable(token));
    let remaining = tokens.get(index + 1..).unwrap_or_default();
    if name.is_some_and(|name| {
        [
            "rm", "mv", "cp", "touch", "mkdir", "rmdir", "truncate", "install", "patch", "rm.exe",
            "mv.exe", "cp.exe",
        ]
        .contains(&name)
    }) || (name == Some("sed")
        && remaining
            .iter()
            .any(|token| *token == "-i" || token.starts_with("-i.")))
        || has_unquoted_redirect(command)
    {
        return true;
    }
    // A substitution runs arbitrary commands, so no read-only exemption applies.
    let substituted = has_substitution(command);
    let specgit_index =
        if name.is_some_and(|n| ["specgit", "specgit.exe", "specgit.js"].contains(&n)) {
            Some(index)
        } else if name.is_some_and(|n| ["node", "node.exe"].contains(&n)) {
            tokens
                .iter()
                .enumerate()
                .skip(index + 1)
                .find_map(|(i, token)| (executable(token) == "specgit.js").then_some(i))
        } else {
            None
        };
    if let Some(index) = specgit_index {
        let mut remaining = &tokens[index + 1..];
        loop {
            let Some(option) = remaining.first().copied() else {
                return false;
            };
            if ["--json", "--human"].contains(&option) {
                remaining = &remaining[1..];
                continue;
            }
            // Issue lifecycle commands establish or inspect the checkpoint.
            // Their CLI performs duplicate inspection and write preflight before
            // any local or native mutation, so the source-edit guard must not
            // block a direct command that creates the first checkpoint. Do not
            // exempt compound shell input; the hook must still inspect it.
            if option == "issue" {
                return event != "PreToolUse" || index != 0 || compound;
            }
            if option == "--cwd" {
                let Some(rest) = remaining.get(2..) else {
                    return false;
                };
                remaining = rest;
            } else if option.starts_with("--cwd=") {
                remaining = &remaining[1..];
            } else {
                return option == "merge"
                    || (option == "pr" && substituted)
                    || (option == "pr"
                        && !(remaining.contains(&"--status") && !remaining.contains(&"--ready")));
            }
        }
    }
    match name {
        Some("git" | "git.exe") => remaining.first().is_some_and(|subcommand| {
            [
                "push", "commit", "checkout", "switch", "merge", "rebase", "reset", "add",
                "restore",
            ]
            .contains(subcommand)
        }),
        Some("gh" | "gh.exe" | "glab" | "glab.exe") => {
            let group = remaining.first().copied().unwrap_or("");
            let subcommand = remaining.get(1).copied().unwrap_or("");
            let readonly: &[&str] = match (name, group) {
                (Some("gh" | "gh.exe"), "pr") => &["view", "list", "checks", "diff", "status"],
                (Some("glab" | "glab.exe"), "mr") => &["view", "list", "diff"],
                (_, "issue") => &["view", "list"],
                _ => return false,
            };
            substituted || !readonly.contains(&subcommand)
        }
        _ => false,
    }
}

// The ampersand in a descriptor duplication or &> redirect is not a separator.
fn shell_segments(command: &str) -> Vec<&str> {
    let mut result = vec![];
    let mut start = 0;
    let (mut single, mut double, mut escaped) = (false, false, false);
    for (index, character) in command.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if !single => escaped = true,
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            ';' | '&' | '|' | '\n' | '\r' if !single && !double => {
                if character == '&'
                    && (command[..index].trim_end().ends_with('>')
                        || command[index + 1..].starts_with('>'))
                {
                    continue;
                }
                result.push(&command[start..index]);
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    result.push(&command[start..]);
    result
}

fn harmless_redirect(rest: &str) -> bool {
    let rest = rest.trim_start_matches('>').trim_start();
    let target = rest
        .split(|c: char| c.is_whitespace() || [';', '|', '<', '>'].contains(&c))
        .next()
        .unwrap_or("");
    if let Some(fd) = target.strip_prefix('&') {
        !fd.is_empty() && fd.bytes().all(|b| b.is_ascii_digit())
    } else {
        target.split('&').next() == Some("/dev/null")
    }
}
fn has_unquoted_redirect(command: &str) -> bool {
    let mut single = false;
    let mut double = false;
    let mut escaped = false;
    for (index, character) in command.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if !single => escaped = true,
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            '>' if !single && !double && !harmless_redirect(&command[index..]) => return true,
            _ => {}
        }
    }
    false
}
fn has_substitution(command: &str) -> bool {
    let (mut single, mut double, mut escaped) = (false, false, false);
    let mut characters = command.chars().peekable();
    while let Some(character) = characters.next() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if !single => escaped = true,
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            '`' if !single => return true,
            '$' if !single && characters.peek() == Some(&'(') => return true,
            _ => {}
        }
    }
    false
}
fn has_unquoted_shell_control(command: &str) -> bool {
    let mut single = false;
    let mut double = false;
    let mut escaped = false;
    let mut characters = command.chars().peekable();
    while let Some(character) = characters.next() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single {
            escaped = true;
            continue;
        }
        if character == '\'' && !double {
            single = !single;
        } else if character == '"' && !single {
            double = !double;
        } else if !single && !double {
            if [';', '&', '|', '\n', '\r', '`', '(', ')'].contains(&character)
                || (character == '$' && characters.peek() == Some(&'('))
            {
                return true;
            }
        } else if double
            && (character == '`' || (character == '$' && characters.peek() == Some(&'(')))
        {
            return true;
        }
    }
    false
}
pub(super) fn patch_tool(tool: &str) -> bool {
    matches!(
        tool,
        "apply_patch" | "functions.apply_patch" | "mcp__functions__apply_patch"
    )
}
