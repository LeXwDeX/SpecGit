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
/// Generated files only: other Skills and project instructions stay visible.
pub const SKILL_PATHS: [&str; 2] = [
    ".agents/skills/specgit-native/SKILL.md",
    ".claude/skills/specgit-native/SKILL.md",
];

fn allowed(name: &str) -> bool {
    [".specgit.yaml", "AGENTS.md", "CLAUDE.md"].contains(&name) || SKILL_PATHS.contains(&name)
}

fn owned_body(text: &str) -> Option<&str> {
    text.split_once(START)?
        .1
        .split_once(END)
        .map(|(body, _)| body)
}

pub(crate) fn excluded_paths(change: &Change) -> Vec<&'static str> {
    let body = change
        .after
        .as_deref()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(owned_body)
        .unwrap_or_default();
    let mut names = vec![".specgit.yaml"];
    names.extend(SKILL_PATHS.into_iter().filter(|name| {
        body.lines()
            .any(|line| line.strip_prefix('/') == Some(*name))
    }));
    names
}

/// Plan against one snapshot. Keep shared Skill rules while sibling worktrees
/// may still use them, but retire legacy whole-instruction-file exclusions.
pub fn project_change(
    root: &Path,
    exclude: &Path,
    changes: &[Change],
) -> Result<Change, Diagnostic> {
    let current = Change::new(exclude.to_owned(), None)?;
    let text = std::str::from_utf8(current.before.bytes.as_deref().unwrap_or_default())
        .map_err(|_| conflict())?;
    let body = owned_body(text).unwrap_or_default();
    let mut names = vec![".specgit.yaml"];
    for name in SKILL_PATHS {
        if body
            .lines()
            .any(|line| line.strip_prefix('/') == Some(name))
            || changes
                .iter()
                .any(|change| change.path == root.join(name) && change.after.is_some())
        {
            names.push(name);
        }
    }
    change_from(current, &names)
}

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
    change_from(Change::new(path.to_owned(), None)?, names)
}

fn change_from(mut change: Change, names: &[&str]) -> Result<Change, Diagnostic> {
    if names.iter().any(|name| !allowed(name)) {
        return Err(conflict());
    }
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
                    .any(|line| !line.strip_prefix('/').is_some_and(allowed))
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

/// Committing an untrack deletes the file in other checkouts that cross the commit.
const TRACKED_REMEDY: &str = "Ignore rules do not untrack existing files. Review generated assets and use authorized git rm --cached for whole generated files; keep manual guidance tracked. Warning: committing git rm --cached for .specgit.yaml or a generated Skill deletes that file in every other clone or worktree that later fast-forwards, pulls or switches across that commit. Preserve declarations and manual edits before crossing that commit; restore the declaration from its original source and rerun specgit init to regenerate the project Skill. Refresh never changes the Git index.";

fn mixed_guidance(root: &Path, changes: &[Change]) -> Result<Vec<&'static str>, Diagnostic> {
    let mut mixed = vec![];
    for name in ["AGENTS.md", "CLAUDE.md"] {
        if let Some(c) = changes.iter().find(|c| c.path == root.join(name)) {
            let text = std::str::from_utf8(c.after.as_deref().unwrap_or_default())
                .map_err(|_| conflict())?;
            for (start, end) in [
                ("<!-- specgit:v2:start -->", "<!-- specgit:v2:end -->"),
                (
                    "<!-- specgit:project:v2:start -->",
                    "<!-- specgit:project:v2:end -->",
                ),
            ] {
                if let Some((prefix, rest)) = text.split_once(start)
                    && let Some((_, suffix)) = rest.split_once(end)
                    && (!prefix.trim().is_empty() || !suffix.trim().is_empty())
                {
                    mixed.push(name);
                    break;
                }
            }
        }
    }
    Ok(mixed)
}

pub(crate) async fn tracked(
    process: &Process,
    root: &Path,
    names: &[&str],
) -> Result<Vec<String>, Diagnostic> {
    let mut args = vec!["ls-files", "-z", "--"];
    args.extend(names.iter().copied());
    let tracked = project::git(process, root, &args).await?;
    Ok(tracked
        .split(|b| *b == 0)
        .filter(|b| !b.is_empty())
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .collect())
}

/// Classify the owned block from a planned refresh: absent, current, refresh or damaged.
fn block_state(planned: &Result<Change, Diagnostic>) -> &'static str {
    match planned {
        Err(_) => "damaged",
        Ok(c) if c.unchanged() => "current",
        Ok(c)
            if c.before
                .bytes
                .as_deref()
                .is_some_and(|b| std::str::from_utf8(b).is_ok_and(|text| text.contains(START))) =>
        {
            "refresh"
        }
        Ok(_) => "absent",
    }
}

fn report(
    exclude: &Path,
    names: &[&str],
    mixed: &[&str],
    tracked: &[String],
    state: &str,
) -> Value {
    json!({"path":exclude,"excluded_paths":names,"mixed_guidance_paths":mixed,"already_tracked":tracked,"block_state":state,"index_changed":false,"tracked_remedy":TRACKED_REMEDY})
}

pub async fn plan(
    process: &Process,
    root: &Path,
    exclude: &Path,
    changes: &mut Vec<Change>,
) -> Result<Value, Diagnostic> {
    // info/exclude is shared by linked worktrees. Guidance ownership is not.
    let planned = project_change(root, exclude, changes);
    let names = planned
        .as_ref()
        .map(excluded_paths)
        .unwrap_or_else(|_| vec![".specgit.yaml"]);
    let mixed = mixed_guidance(root, changes)?;
    let tracked = tracked(process, root, &names).await?;
    let index = changes
        .iter()
        .position(|c| c.path == root.join(".specgit.yaml"))
        .unwrap_or(changes.len());
    let state = block_state(&planned);
    changes.insert(index, planned?);
    Ok(report(exclude, &names, &mixed, &tracked, state))
}

/// Read-only form of [`plan`] for `init --check`: it reports a damaged block
/// with its diagnostic instead of failing, and never records a change.
pub async fn inspect(
    process: &Process,
    root: &Path,
    exclude: &Path,
    guidance: &[Change],
) -> Result<Value, Diagnostic> {
    let planned = project_change(root, exclude, guidance);
    let names = planned
        .as_ref()
        .map(excluded_paths)
        .unwrap_or_else(|_| vec![".specgit.yaml"]);
    let mixed = mixed_guidance(root, guidance)?;
    let tracked = tracked(process, root, &names).await?;
    let mut value = report(exclude, &names, &mixed, &tracked, block_state(&planned));
    if let Err(d) = planned {
        value["diagnostic"] = json!(d);
    }
    Ok(value)
}
