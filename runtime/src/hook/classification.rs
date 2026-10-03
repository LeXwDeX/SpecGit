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
    let tokens: Vec<_> = command.split_whitespace().collect();
    let executable = tokens.first().map(|token| {
        token
            .trim_matches(['\'', '"'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
    });
    if executable.is_some_and(|name| {
        [
            "rm", "mv", "cp", "touch", "mkdir", "rmdir", "truncate", "install", "patch", "rm.exe",
            "mv.exe", "cp.exe",
        ]
        .contains(&name)
    }) || (executable == Some("sed")
        && tokens
            .iter()
            .any(|token| *token == "-i" || token.starts_with("-i.")))
        || has_unquoted_redirect(command)
    {
        return true;
    }
    if let Some(index) = tokens.iter().position(|token| {
        let executable = token
            .trim_matches(['\'', '"'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("");
        ["specgit", "specgit.exe", "specgit.js"].contains(&executable)
    }) {
        let mut remaining = &tokens[index + 1..];
        loop {
            let Some(option) = remaining.first().copied() else {
                return false;
            };
            if option == "--json" {
                remaining = &remaining[1..];
                continue;
            }
            // Issue lifecycle commands establish or inspect the checkpoint.
            // Their CLI performs duplicate inspection and write preflight before
            // any local or native mutation, so the source-edit guard must not
            // block a direct command that creates the first checkpoint. Do not
            // exempt compound shell input; the hook must still inspect it.
            if option == "issue" {
                return event != "PreToolUse" || index != 0 || has_unquoted_shell_control(command);
            }
            let value = if option == "--cwd" {
                remaining = &remaining[1..];
                let Some(value) = remaining.first().copied() else {
                    return false;
                };
                value
            } else if let Some(value) = option.strip_prefix("--cwd=") {
                value
            } else {
                return ["pr", "merge"].contains(&option);
            };
            let quote = value.chars().next().filter(|c| ['\'', '"'].contains(c));
            let mut ends_here = quote.is_none_or(|q| value.len() > 1 && value.ends_with(q));
            remaining = &remaining[1..];
            while !ends_here {
                let Some(part) = remaining.first().copied() else {
                    return false;
                };
                ends_here = part.ends_with(quote.expect("an open quote exists"));
                remaining = &remaining[1..];
            }
        }
    }
    tokens.windows(2).any(|pair| {
        ["git", "git.exe", "gh", "glab"].contains(&pair[0])
            && [
                "push", "commit", "checkout", "switch", "merge", "rebase", "reset", "add",
                "restore", "pr", "mr",
            ]
            .contains(&pair[1])
    })
}
fn has_unquoted_redirect(command: &str) -> bool {
    let mut single = false;
    let mut double = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if !single => escaped = true,
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            '>' if !single && !double => return true,
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
