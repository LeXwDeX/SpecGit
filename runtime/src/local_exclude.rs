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

fn owned_body(text: &[u8]) -> Option<&[u8]> {
    let start = positions(text, START.as_bytes()).into_iter().next()?;
    let end = positions(text, END.as_bytes())
        .into_iter()
        .find(|end| *end > start)?;
    Some(&text[start + START.len()..end])
}

pub(crate) fn excluded_paths(change: &Change) -> Vec<&'static str> {
    let body = change
        .after
        .as_deref()
        .and_then(owned_body)
        .unwrap_or_default();
    let mut names = vec![".specgit.yaml"];
    names.extend(SKILL_PATHS.into_iter().filter(|name| {
        body.split(|byte| *byte == b'\n').any(|line| {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            line.strip_prefix(b"/") == Some(name.as_bytes())
        })
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
    project_change_with_shared(root, exclude, changes, &[])
}

pub(crate) fn project_change_with_shared(
    root: &Path,
    exclude: &Path,
    changes: &[Change],
    shared_skills: &[String],
) -> Result<Change, Diagnostic> {
    let current = Change::new(exclude.to_owned(), None)?;
    let body = owned_body(current.before.bytes.as_deref().unwrap_or_default()).unwrap_or_default();
    let mut names = vec![".specgit.yaml"];
    for name in SKILL_PATHS {
        let owned = body.split(|byte| *byte == b'\n').any(|line| {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            line.strip_prefix(b"/") == Some(name.as_bytes())
        });
        if owned
            || shared_skills.iter().any(|skill| skill == name)
            || changes
                .iter()
                .any(|change| change.path == root.join(name) && change.after.is_some())
        {
            names.push(name);
        }
    }
    change_from(current, &names)
}

/// Generated paths only. Legacy whole-file rules for `AGENTS.md` or `CLAUDE.md`
/// never turn those files into guard-protected assets.
fn generated_asset(name: &[u8]) -> bool {
    name == b".specgit.yaml" || SKILL_PATHS.iter().any(|skill| skill.as_bytes() == name)
}

fn positions(text: &[u8], needle: &[u8]) -> Vec<usize> {
    text.windows(needle.len())
        .enumerate()
        .filter_map(|(index, window)| (window == needle).then_some(index))
        .collect()
}

fn marker_line(text: &[u8], index: usize, marker: &[u8]) -> bool {
    let before = index == 0 || text[index - 1] == b'\n';
    let after = match text.get(index + marker.len()) {
        None | Some(&b'\n') => true,
        Some(&b'\r') => text.get(index + marker.len() + 1) == Some(&b'\n'),
        _ => false,
    };
    before && after
}

/// Exactly one complete block, or no block. Damaged and duplicate blocks are
/// conflicts so the guard never treats unreadable evidence as an empty set.
fn managed_body(text: &[u8]) -> Result<Option<&[u8]>, Diagnostic> {
    let starts = positions(text, START.as_bytes());
    let ends = positions(text, END.as_bytes());
    match (starts.as_slice(), ends.as_slice()) {
        ([], []) => Ok(None),
        ([start], [end])
            if start < end
                && marker_line(text, *start, START.as_bytes())
                && marker_line(text, *end, END.as_bytes()) =>
        {
            let body = &text[start + START.len()..*end];
            let rules = std::str::from_utf8(body).map_err(|_| conflict())?;
            if rules
                .lines()
                .any(|line| !line.is_empty() && !(line.starts_with('/') && allowed(&line[1..])))
            {
                return Err(conflict());
            }
            Ok(Some(body))
        }
        _ => Err(conflict()),
    }
}

fn receipt_conflict() -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "local_exclude",
        "The project ownership receipt is damaged and cannot be verified.",
        "Run `specgit doctor`; repair or refresh the recorded project integration before retrying.",
    )
}

fn receipt_read_conflict(error: &std::io::Error) -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "local_exclude",
        &format!(
            "The project ownership receipt could not be read ({:?}).",
            error.kind()
        ),
        "Check file permissions or locks, then run `specgit doctor`.",
    )
}

/// Skill paths recorded as generated by init/setup. The receipt is the
/// ownership evidence; a same-named manual file is not a generated asset.
async fn recorded_skills(process: &Process, root: &Path) -> Result<Vec<String>, Diagnostic> {
    let bytes = project::git(process, root, &["rev-parse", "--absolute-git-dir"]).await?;
    let git_dir = std::str::from_utf8(&bytes)
        .map_err(|_| Diagnostic::input("Git returned a non-UTF-8 Git directory."))?;
    let git_dir = project::git_path_line(git_dir);
    let receipt = Path::new(git_dir).join("specgit-v2/agent-assets/ownership.json");
    let metadata = match std::fs::symlink_metadata(&receipt) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(receipt_read_conflict(&error)),
    };
    if !metadata.file_type().is_file() {
        return Err(receipt_conflict());
    }
    let bytes = std::fs::read(&receipt).map_err(|error| receipt_read_conflict(&error))?;
    let parsed = crate::project_receipt::decode(&bytes).map_err(|_| receipt_conflict())?;
    if !crate::project::same_root(&parsed.root, root).map_err(|_| receipt_conflict())? {
        return Err(receipt_conflict());
    }
    Ok(parsed.skills.into_keys().collect())
}

/// Repository-relative generated paths. The declaration is always protected.
/// Generated Skills come from the managed exclusion block and the ownership
/// receipt, so deleting the worktree copy does not remove protection and a
/// same-named manual file does not gain it. The block is parsed as bytes because
/// user rules outside it may not be UTF-8.
pub async fn managed_paths(process: &Process, root: &Path) -> Result<Vec<String>, Diagnostic> {
    let exclude = path(process, root).await?;
    let change = Change::new(exclude, None)?;
    let bytes = change.before.bytes.as_deref().unwrap_or_default();
    let mut names = vec![".specgit.yaml".to_owned()];
    for line in managed_body(bytes)?
        .unwrap_or_default()
        .split(|byte| *byte == b'\n')
    {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(name) = line.strip_prefix(b"/")
            && generated_asset(name)
        {
            names.push(std::str::from_utf8(name).unwrap_or_default().to_owned());
        }
    }
    for name in recorded_skills(process, root).await? {
        if generated_asset(name.as_bytes()) {
            names.push(name);
        }
    }
    names.sort_unstable();
    names.dedup();
    Ok(names)
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
    Ok(PathBuf::from(project::git_path_line(
        &String::from_utf8(bytes).map_err(|_| Diagnostic::input("Invalid Git exclude path."))?,
    )))
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
    let before = change.before.bytes.as_deref().unwrap_or_default();
    let starts = positions(before, START.as_bytes());
    let ends = positions(before, END.as_bytes());
    let newline: &[u8] = if before.windows(2).any(|pair| pair == b"\r\n".as_slice()) {
        b"\r\n"
    } else {
        b"\n"
    };
    let mut rules = names.to_vec();
    rules.sort_unstable();
    rules.dedup();
    let mut block = Vec::new();
    block.extend_from_slice(START.as_bytes());
    block.extend_from_slice(newline);
    for (index, name) in rules.iter().enumerate() {
        if index > 0 {
            block.extend_from_slice(newline);
        }
        block.extend_from_slice(b"/");
        block.extend_from_slice(name.as_bytes());
    }
    block.extend_from_slice(newline);
    block.extend_from_slice(END.as_bytes());
    let after = match (starts.as_slice(), ends.as_slice()) {
        ([], []) => {
            let mut after = before.to_vec();
            if !after.is_empty() && !after.ends_with(b"\n") {
                after.extend_from_slice(newline);
            }
            after.extend_from_slice(&block);
            after.extend_from_slice(newline);
            after
        }
        ([start], [end]) if start < end => {
            // Reuse the strict block check: damaged or edited blocks are conflicts.
            let _ = managed_body(before)?;
            let mut after = before[..*start].to_vec();
            after.extend_from_slice(&block);
            after.extend_from_slice(&before[*end + END.len()..]);
            after
        }
        _ => return Err(conflict()),
    };
    change.after = Some(after);
    Ok(change)
}

pub(crate) fn removal(path: &Path) -> Result<Change, Diagnostic> {
    let mut c = Change::new(path.to_owned(), None)?;
    let before = c.before.bytes.as_deref().unwrap_or_default();
    let starts = positions(before, START.as_bytes());
    let ends = positions(before, END.as_bytes());
    if starts.is_empty() && ends.is_empty() {
        c.after = c.before.bytes.clone();
        return Ok(c);
    }
    // Refresh already checks marker count, line boundaries and the rule whitelist.
    change(path, &[".specgit.yaml"])?;
    let start = starts.first().copied().ok_or_else(conflict)?;
    let end = ends.first().copied().ok_or_else(conflict)? + END.len();
    let mut suffix: &[u8] = &before[end..];
    if suffix.starts_with(b"\r\n") {
        suffix = &suffix[2..];
    } else if suffix.starts_with(b"\n") {
        suffix = &suffix[1..];
    }
    let mut after = before[..start].to_vec();
    after.extend_from_slice(suffix);
    c.after = Some(after);
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
