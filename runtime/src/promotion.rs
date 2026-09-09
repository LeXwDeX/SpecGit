//! Read-only promotion candidates from native associations and immutable Git postimages.
use crate::{
    delivery_context::Workspace,
    diagnostic::{Code, Diagnostic},
    forge,
    native_delivery::{self, PullRequest},
    native_file::object_id,
    process::Process,
    project::{self},
    report::Report,
    spec,
};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::Duration,
};

#[derive(Debug, clap::Args)]
pub struct Options {
    /// Exact native promotion request for the selected source worktree.
    #[arg(long)]
    pub request: u64,
    /// Deliberately inspect additional source requests when native discovery is incomplete.
    #[arg(long, value_delimiter = ',')]
    pub source_request: Vec<u64>,
}
#[derive(Serialize)]
struct Candidate {
    request: u64,
    issues: Vec<IssueState>,
    anchor: Option<String>,
    inclusion: String,
    reason: String,
    next_action: String,
}
fn missing(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::UnsupportedOperation,
        "promotion",
        message,
        "Inspect the exact native source request and immutable Git objects; explicitly fetch missing history or select source request IDs. No association was added.",
    )
}
fn malformed() -> Diagnostic {
    missing("Native association or Git evidence is malformed or incomplete.")
}
#[derive(Serialize)]
struct IssueState {
    id: u64,
    state: String,
}
fn text(bytes: Vec<u8>) -> Result<String, Diagnostic> {
    String::from_utf8(bytes)
        .map_err(|_| missing("Non-UTF-8 Git paths require explicit native review."))
}
async fn git(w: &Workspace, args: &[&str]) -> Result<Vec<u8>, Diagnostic> {
    project::git(&w.process, &w.context.root, args).await
}
async fn target(w: &Workspace, name: &str) -> Result<String, Diagnostic> {
    native_delivery::branch_head(&w.reader, &w.context.repository, name).await
}
#[derive(Clone, PartialEq, Eq)]
struct Change {
    path: String,
    before: String,
    after: String,
}
async fn delta(w: &Workspace, parent: &str, anchor: &str) -> Result<Vec<Change>, Diagnostic> {
    let bytes = git(
        w,
        &[
            "diff",
            "--raw",
            "-z",
            "--no-abbrev",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            parent,
            anchor,
            "--",
        ],
    )
    .await?;
    let parts: Vec<_> = bytes.split(|c| *c == 0).collect();
    if parts.last() != Some(&b"".as_slice()) || (parts.len() - 1) % 2 != 0 {
        return Err(malformed());
    }
    let mut result = vec![];
    for pair in parts[..parts.len() - 1].chunks_exact(2) {
        let header = std::str::from_utf8(pair[0]).map_err(|_| malformed())?;
        let fields: Vec<_> = header.split_whitespace().collect();
        if fields.len() != 5
            || !fields[0].starts_with(':')
            || !object_id(fields[2])
            || !object_id(fields[3])
        {
            return Err(malformed());
        }
        let path = std::str::from_utf8(pair[1])
            .map_err(|_| malformed())?
            .to_owned();
        if path.is_empty() || result.len() >= 100 {
            return Err(missing(
                "A source request exceeds the supported 100 changed-path proof bound.",
            ));
        }
        let image = |mode: &str, id: &str| {
            if mode == "000000" {
                String::new()
            } else {
                format!("{mode} {id}")
            }
        };
        result.push(Change {
            path,
            before: image(&fields[0][1..], fields[2]),
            after: image(fields[1], fields[3]),
        });
    }
    Ok(result)
}
async fn image(w: &Workspace, head: &str, path: &str) -> Result<String, Diagnostic> {
    let bytes = git(
        w,
        &["--literal-pathspecs", "ls-tree", "-z", head, "--", path],
    )
    .await?;
    if bytes.is_empty() {
        return Ok(String::new());
    }
    let records: Vec<_> = bytes.split(|b| *b == 0).collect();
    if records.len() != 2 || !records[1].is_empty() {
        return Err(malformed());
    }
    let line = std::str::from_utf8(records[0]).map_err(|_| malformed())?;
    let (header, actual_path) = line.split_once('\t').ok_or_else(malformed)?;
    let fields: Vec<_> = header.split_whitespace().collect();
    if fields.len() != 3 || actual_path != path || !object_id(fields[2]) {
        return Err(malformed());
    }
    Ok(format!("{} {}", fields[0], fields[2]))
}
async fn proof(
    w: &Workspace,
    r: &PullRequest,
    native: &forge::RequestObservation,
    anchor: &str,
) -> Result<Vec<Change>, Diagnostic> {
    let parents = text(git(w, &["rev-list", "--parents", "-n", "1", anchor]).await?)?;
    let parents: Vec<_> = parents.split_whitespace().collect();
    if parents.first().copied() != Some(anchor) || ![2, 3].contains(&parents.len()) {
        return Err(missing(
            "Root/octopus merge histories are outside the supported promotion proof.",
        ));
    }
    if parents.len() == 3 {
        if parents[2] != r.head {
            return Err(missing(
                "The native merge's source parent does not match the recorded source head.",
            ));
        }
    } else if !native.is_squash_anchor(anchor) {
        // One-parent GitHub merge SHA may be squash OR the last rebased commit.
        // Require the complete source delta, never infer squash from topology.
        let base = text(git(w, &["merge-base", parents[1], &r.head]).await?)?;
        let base = base.trim();
        if !object_id(base) {
            return Err(malformed());
        }
        let source = delta(w, base, &r.head).await?;
        let merged = delta(w, parents[1], anchor).await?;
        if source != merged {
            return Err(missing(
                "A one-parent native anchor does not prove the full source request delta; rebase/partial squash needs explicit review.",
            ));
        }
    }
    delta(w, parents[1], anchor).await
}
async fn candidate(
    w: &Workspace,
    promotion: &PullRequest,
    number: u64,
    commits: &BTreeSet<String>,
) -> Result<Candidate, Diagnostic> {
    let native = forge::request(&w.reader, &w.context.repository, number).await?;
    let r = &native.facts;
    let eligible = r.state == "merged"
        && r.source_project == w.facts.id
        && r.target_project == w.facts.id
        && r.target == promotion.source;
    let refs = if eligible {
        spec::references(&r.body)?
    } else {
        BTreeSet::new()
    };
    let mut issues = vec![];
    let mut originals = vec![];
    for id in refs {
        let issue =
            native_delivery::issue(&w.reader, &w.context.repository, w.facts.id, id).await?;
        issues.push(IssueState {
            id,
            state: issue.state.clone(),
        });
        originals.push(issue);
    }
    let anchor = native
        .anchors()
        .into_iter()
        .find(|s| commits.contains(*s))
        .map(String::from);
    let mut result = Candidate {request:number, issues, anchor:anchor.clone(), inclusion:"unverified".into(), reason:String::new(),next_action:"Inspect this source request and deliberately select its issues only after resolving the evidence limitation.".into()};
    if !eligible {
        result.inclusion = "excluded".into();
        result.reason = "Source request is not a merged same-project delivery into this promotion source branch.".into();
    } else if let Some(anchor) = &anchor {
        match proof(w, r, &native, anchor).await {
            Ok(changes) if changes.is_empty() => {
                result.inclusion = "excluded".into();
                result.reason = "The native anchor has no net change.".into();
            }
            Ok(changes) => {
                let mut after = 0;
                let mut before = 0;
                for c in &changes {
                    let current = image(w, &promotion.head, &c.path).await?;
                    after += usize::from(current == c.after);
                    before += usize::from(current == c.before);
                }
                if after == changes.len() {
                    result.inclusion = "included".into();
                    result.reason="The complete native merge delta's modes and blobs remain present at the promotion head.".into();
                    result.next_action="Review these native issue associations and deliberately add the intended references to the promotion body; no issue state was changed.".into();
                } else if before == changes.len() {
                    result.inclusion = "excluded".into();
                    result.reason =
                        "The complete native delta is reverted or absent from the promotion head."
                            .into();
                } else {
                    result.reason="Later changes, a partial revert or partial inclusion prevent an exact full-delta proof.".into();
                }
            }
            Err(d) if matches!(d.code, Code::UnsupportedOperation | Code::ProcessFailed) => {
                result.reason = d.message;
            }
            Err(d) => return Err(d),
        }
    } else {
        result.reason="No native merge/squash anchor is in this range. Unpromoted or cherry-picked histories require explicit review; patch similarity alone is not association proof.".into();
    }
    if !forge::unchanged(&w.reader, &w.context.repository, &native).await? {
        return Err(changed());
    }
    for issue in originals {
        if native_delivery::issue(&w.reader, &w.context.repository, w.facts.id, issue.id).await?
            != issue
        {
            return Err(changed());
        }
    }
    Ok(result)
}
fn changed() -> Diagnostic {
    Diagnostic::new(
        Code::ConcurrentEdit,
        "promotion",
        "Native request, issue, target or local facts changed during discovery.",
        "Repeat the read-only promotion assessment before adding associations.",
    )
}
pub async fn run(o: Options, process: Process, cwd: &Path) -> Report {
    match tokio::time::timeout(Duration::from_secs(180), Box::pin(execute(o, process, cwd))).await {
        Ok(Ok(r)) => r,
        Ok(Err(d)) => Report::failure("promotion", d),
        Err(_) => Report::failure(
            "promotion",
            Diagnostic::new(
                Code::Timeout,
                "promotion",
                "The bounded promotion assessment expired.",
                "Narrow the native range; partial discovery is not complete evidence.",
            ),
        ),
    }
}
async fn execute(o: Options, process: Process, cwd: &Path) -> Result<Report, Diagnostic> {
    if o.request == 0 || o.source_request.contains(&0) || o.source_request.len() > 100 {
        return Err(Diagnostic::input(
            "Select one positive promotion request and at most 100 positive source request IDs.",
        ));
    }
    let w = Workspace::load(process, cwd).await?;
    let repo = &w.context.repository;
    let native = forge::request(&w.reader, repo, o.request).await?;
    let promotion = &native.facts;
    if promotion.source_project != w.facts.id
        || promotion.target_project != w.facts.id
        || promotion.head != w.context.head
        || promotion.source != w.branch()?
        || promotion.target != w.target
        || w.context.dirty
    {
        return Err(missing(
            "Promotion requires the exact clean pushed same-project source worktree and selected target.",
        ));
    }
    if text(git(&w, &["rev-parse", "--is-shallow-repository"]).await?)?.trim() != "false" {
        return Err(missing(
            "Promotion requires complete local Git ancestry; explicitly unshallow the repository first.",
        ));
    }
    let base = target(&w, &promotion.target).await?;
    let range = format!("{base}..{}", promotion.head);
    let rows = text(git(&w, &["rev-list", "--max-count=201", &range, "--"]).await?)?;
    let commits: BTreeSet<String> = rows.lines().map(String::from).collect();
    if commits.len() > 200 || commits.iter().any(|s| !object_id(s)) {
        return Err(missing(
            "Promotion discovery supports at most 200 exact commits with locally available target/head history.",
        ));
    }
    let mut source: BTreeSet<_> = o.source_request.into_iter().collect();
    let mut associations = BTreeMap::new();
    for commit in &commits {
        let association = forge::associations(&w.reader, repo, commit).await?;
        for id in &association.requests {
            if *id != o.request {
                source.insert(*id);
            }
        }
        associations.insert(commit, association);
    }

    if source.len() > 100 || source.contains(&o.request) {
        return Err(missing(
            "Source candidates exceed the bound or include the promotion itself.",
        ));
    }
    let mut candidates = vec![];
    for number in source {
        candidates.push(candidate(&w, promotion, number, &commits).await?);
    }
    let issues: BTreeSet<_> = candidates
        .iter()
        .filter(|c| c.inclusion == "included")
        .flat_map(|c| c.issues.iter().map(|i| i.id))
        .collect();
    for (commit, observed) in associations {
        if forge::associations(&w.reader, repo, commit).await? != observed {
            return Err(changed());
        }
    }
    if !forge::unchanged(&w.reader, repo, &native).await?
        || target(&w, &promotion.target).await? != base
    {
        return Err(changed());
    }
    w.unchanged().await?;
    let mut result = Report::success(
        "promotion",
        "candidates",
        json!({"request":promotion.id,"source":promotion.source,"target":promotion.target,"native_default":w.facts.default_branch,"base":base,"head":promotion.head,"commits":commits.len(),"candidates":candidates,"suggested_issue_ids":issues,"discovery":"bounded_native_commit_associations_plus_explicit_ids","exhaustive":false,"association_written":false,"completed":false,"limitations":["Native commit associations may omit historical source requests; use explicit source IDs.","Only complete exact postimages prove inclusion. Later changes may require manual review.","Unanchored cherry-picks, partial rebase/squash and unavailable history remain unverified."]}),
    );
    if candidates.iter().any(|c| c.inclusion == "unverified") {
        result.exit = 3;
        result.status = "partial".into();
    }
    Ok(result)
}
