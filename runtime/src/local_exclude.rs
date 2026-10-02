//! Git-local exclusions for project assets, without changing the index.
use crate::{
    assets::Change,
    diagnostic::{Code, Diagnostic},
    process::Process,
    project,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
const START: &str = "# specgit:local:v2:start";
const END: &str = "# specgit:local:v2:end";

pub async fn path(process: &Process, root: &Path) -> Result<PathBuf, Diagnostic> {
    let bytes = project::git(
        process,
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    )
    .await?;
    Ok(PathBuf::from(
        String::from_utf8(bytes)
            .map_err(|_| Diagnostic::input("Invalid Git exclude path."))?
            .trim_end_matches(['\r', '\n']),
    ))
}

fn conflict() -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "local_exclude",
        "The local exclusion block is damaged, duplicated or edited.",
        "Preserve user rules and reconcile the SpecGit block before retrying.",
    )
}

pub fn change(path: &Path, names: &[&str]) -> Result<Change, Diagnostic> {
    if names
        .iter()
        .any(|name| ![".specgit.yaml", "AGENTS.md", "CLAUDE.md"].contains(name))
    {
        return Err(conflict());
    }
    let mut change = Change::new(path.to_owned(), None)?;
    let before = std::str::from_utf8(change.before.bytes.as_deref().unwrap_or_default())
        .map_err(|_| conflict())?;
    let starts: Vec<_> = before.match_indices(START).collect();
    let ends: Vec<_> = before.match_indices(END).collect();
    let newline = if before.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut rules = names.to_vec();
    rules.sort_unstable();
    rules.dedup();
    let block = format!(
        "{START}{newline}{}{newline}{END}",
        rules
            .iter()
            .map(|n| format!("/{n}"))
            .collect::<Vec<_>>()
            .join(newline)
    );
    let after = match (starts.as_slice(), ends.as_slice()) {
        ([], []) => format!(
            "{before}{}{block}{newline}",
            if before.is_empty() || before.ends_with('\n') {
                ""
            } else {
                newline
            }
        ),
        ([(start, _)], [(end, _)]) if start < end => {
            let current = &before[*start..*end + END.len()];
            let lines: Vec<_> = current.lines().collect();
            if lines.first() != Some(&START)
                || lines.last() != Some(&END)
                || lines[1..lines.len() - 1]
                    .iter()
                    .any(|line| !["/.specgit.yaml", "/AGENTS.md", "/CLAUDE.md"].contains(line))
                || (*start > 0 && !before[..*start].ends_with('\n'))
                || !before[*end + END.len()..].starts_with(['\r', '\n'])
                    && *end + END.len() != before.len()
            {
                return Err(conflict());
            }
            format!(
                "{}{block}{}",
                &before[..*start],
                &before[*end + END.len()..]
            )
        }
        _ => return Err(conflict()),
    };
    change.after = Some(after.into_bytes());
    Ok(change)
}

pub(crate) fn removal(path: &Path) -> Result<Change, Diagnostic> {
    let mut c = Change::new(path.to_owned(), None)?;
    let text = std::str::from_utf8(c.before.bytes.as_deref().unwrap_or_default())
        .map_err(|_| conflict())?;
    if !text.contains(START) && !text.contains(END) {
        c.after = c.before.bytes.clone();
        return Ok(c);
    }
    // Refresh already checks marker count, line boundaries and the rule whitelist.
    change(path, &[".specgit.yaml"])?;
    let start = text.find(START).ok_or_else(conflict)?;
    let end = text.find(END).ok_or_else(conflict)? + END.len();
    let suffix = &text[end..];
    let suffix = suffix
        .strip_prefix("\r\n")
        .or_else(|| suffix.strip_prefix('\n'))
        .unwrap_or(suffix);
    c.after = Some(format!("{}{suffix}", &text[..start]).into_bytes());
    Ok(c)
}

pub async fn plan(
    process: &Process,
    root: &Path,
    exclude: &Path,
    changes: &mut Vec<Change>,
) -> Result<Value, Diagnostic> {
    // info/exclude is shared by linked worktrees. Guidance ownership is not.
    let names = vec![".specgit.yaml"];
    let mut mixed = vec![];
    for name in ["AGENTS.md", "CLAUDE.md"] {
        if let Some(c) = changes.iter().find(|c| c.path == root.join(name)) {
            let text = std::str::from_utf8(c.after.as_deref().unwrap_or_default())
                .map_err(|_| conflict())?;
            if let Some((prefix, rest)) = text.split_once("<!-- specgit:v2:start -->")
                && let Some((_, suffix)) = rest.split_once("<!-- specgit:v2:end -->")
                && (!prefix.trim().is_empty() || !suffix.trim().is_empty())
            {
                mixed.push(name);
            }
        }
    }
    let mut args = vec!["ls-files", "-z", "--"];
    args.extend(names.iter().copied());
    let tracked = project::git(process, root, &args).await?;
    let tracked: Vec<_> = tracked
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .collect();
    let index = changes
        .iter()
        .position(|c| c.path == root.join(".specgit.yaml"))
        .unwrap_or(changes.len());
    changes.insert(index, change(exclude, &names)?);
    Ok(
        json!({"path":exclude,"excluded_paths":names,"mixed_guidance_paths":mixed,"already_tracked":tracked,"index_changed":false,"tracked_remedy":"Ignore rules do not untrack existing files. Review generated assets and use authorized git rm --cached for whole generated files; preserve manual guidance and omit generated hunks from commits."}),
    )
}
