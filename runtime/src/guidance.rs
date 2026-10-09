//! Generated project guidance owns only its marked block.
use crate::{
    assets::{Change, hash},
    declaration::{Agent, Declaration, Language, Source, Validation},
    diagnostic::{Code, Diagnostic},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
const START: &str = "<!-- specgit:v2:start -->";
const END: &str = "<!-- specgit:v2:end -->";
fn conflict() -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "guidance",
        "The generated marker is damaged or its content was edited.",
        "Preserve the file and reconcile the owned block explicitly before refreshing.",
    )
}
/// Generated blocks end with a digest of everything before it, so any later
/// runtime can verify an unmodified block without a worktree receipt.
const DIGEST: &str = "<!-- specgit:v2:sha256 ";
const DIGEST_END: &str = " -->\n";
const RULES: &str = "\n\nDeclared rules: `";
/// SHA-256 of the text between the start marker line and the declared rules of
/// each released render without a digest. Fixtures: `tests/fixtures/guidance-*`.
const RELEASED_EN: &[&str] = &[
    "38123400b066271bd415cce34ce3b487711689eef0b0039666c6116be02fdd38", // 2.0.0
    "ba8006746f0d171bc1dd7229be38ab1bc3c867cf67cb58462893f33933dcb72b", // 2.0.1
    "07520d26c687c04f7f55d9a9985536df3b47d52f0428ada791363830961fad9f", // 2.0.2
    "2b924f3d6a965966f0de115a423024473eae6fcc438de2e4aa2c098cad0c04dc", // 2.0.3
    "85adad46aeb8da212ba110807b97a81fac6f96fe4836003cf6e2fc452c0c3877", // 2.0.4
    "8b994edfa649fe92add197a17fff9c883503400d448175281c47cb977adac0ba", // 2.1.0
    "0512b3762ec2d05965245e67c9222d4fdfd42db7705666c4b3046ae9b0b88692", // 2.1.1
    "1ce0fb29e5119f9c257ed89f7bc53f04d179499267f9ab469290aa4516bf44bb", // 2.1.2
    "94300cbac545efdb5dfe678c2df3582df0f1d47038e3b3ed6f752f473b97136b", // 2.2.0
    "6ab6e5787288ac09c774349347f79138275137579bf3dda6b1d3801199de80e3", // 2.2.1
    "4f87b79dcfae977d144d9c7b9b6c7a687d29e065a3a88d38b03e01af4cf91734", // 2.3.0
    "63591c169351e8c5b779e5d1929ba804894ef9601b9d528c1dd6828ea4d6c806", // 2.4.0
    "ce332e40f897fd1b06147d0e9e5e1afdd9375b1716e6a6b90f8f8992c266a4c1", // 2.5.0
];
const RELEASED_ZH: &[&str] = &[
    "30256ebc0704278fed2555e8ce02a46c83b111541c50da6875e0c6ae231dc0bf", // 2.0.0
    "669fb3dfef89221df930b3e68d708141647f24c6a602eadd505bbbdb32636061", // 2.0.1
    "c42ade3730684dc56666ac822ce2b3887e3b117eaedf08b93329b800131b23f2", // 2.0.2
    "ce3f0c4671a44192eebb9533a3404d33bc170f5d826cddc895861c55444fb5e6", // 2.0.3
    "d64f38e728b54da4e953eeca53040f08115b425e0117cfd3ac3919e87df828f0", // 2.0.4
    "f660b883b3c2dc1593b4c48e448bc76b61920c24dfa85c3ee23384949766076c", // 2.1.0
    "5b672e35722e8a4f1b326de3688829054fddd2df1fc4b0d7a1439875825d143e", // 2.1.1
    "b8503be23291e00782f5788d740f090b30359f35b5e06037ef61fd0d46d37902", // 2.1.2
    "30c7b9e66195aa28d946eeb36155a8e35fb9eb4d5f5f7e4f733dee921fcccb55", // 2.2.0
    "d1aa14efcf77e2d820151a54a3f8cc7cc07896abf1b2e7043279ac7a1acd2906", // 2.2.1
    "e134a47571c41b4112217fb9320663440872f2f0428e57c34f8db08af4b8a055", // 2.3.0
    "a6fa3718928a11b2d9dede1d06a208b68536b80d59e5bf06b9324bb5929b55be", // 2.4.0
    "e670aa480c5ccd3e0b8b11f5be26f5eb15b29b9d49dbcd4b6cca091ff196f5fa", // 2.5.0
];
fn summary(
    language: Language,
    validation: &Validation,
    issue: Source,
    pr: Source,
    agent: &Agent,
) -> String {
    // Template bodies are content, not instructions injected into the harness.
    serde_json::json!({"language":language,"validation":validation,"issue_template":issue,"pr_template":pr,"agent":agent}).to_string()
}
fn declared(d: &Declaration) -> String {
    summary(
        d.language,
        &d.validation,
        d.templates.issue.source,
        d.templates.pr.source,
        &d.agent,
    )
}
pub fn render(d: &Declaration) -> String {
    render_as(d, env!("CARGO_PKG_VERSION"))
}
/// Render as another runtime version, to test digest verification across upgrades.
#[cfg(feature = "test-fixtures")]
#[doc(hidden)]
pub fn render_for_version(d: &Declaration, version: &str) -> String {
    render_as(d, version)
}
fn render_as(d: &Declaration, version: &str) -> String {
    let prompt = crate::prompts::project(d.language);
    let body = format!(
        "{START}\n## SpecGit 2\n\nRuntime: {version}. Declaration: `.specgit.yaml` (v2, local configuration).\n\n{}{RULES}{}`\n",
        prompt.trim_end(),
        declared(d)
    );
    format!("{body}{DIGEST}{}{DIGEST_END}{END}", hash(body.as_bytes()))
}
/// Verify a canonical (LF) block against its own embedded digest.
fn certified(block: &str) -> bool {
    block
        .strip_suffix(END)
        .and_then(|b| b.strip_suffix(DIGEST_END))
        .and_then(|b| b.rsplit_once(DIGEST))
        .is_some_and(|(body, digest)| body.ends_with('\n') && digest == hash(body.as_bytes()))
}
/// Recognize an exact released render without a digest. Its declared rules
/// must equal `previous`, or be rules the declaration types reproduce exactly.
fn released(block: &str, previous: &Declaration) -> bool {
    let Some((head, rules)) = block
        .strip_prefix(START)
        .and_then(|b| b.strip_prefix('\n'))
        .and_then(|b| b.strip_suffix(END))
        .and_then(|b| b.strip_suffix("`\n"))
        .and_then(|b| b.rsplit_once(RULES))
    else {
        return false;
    };
    let head = hash(head.as_bytes());
    let language = if RELEASED_EN.contains(&head.as_str()) {
        Language::En
    } else if RELEASED_ZH.contains(&head.as_str()) {
        Language::Zh
    } else {
        return false;
    };
    let declared_language = if rules == declared(previous) {
        Some(previous.language)
    } else {
        embedded(rules)
    };
    declared_language == Some(language)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rules {
    language: Language,
    validation: Validation,
    issue_template: Source,
    pr_template: Source,
    agent: Agent,
}
fn embedded(rules: &str) -> Option<Language> {
    let value = crate::input::json(rules.as_bytes(), 4096, 8).ok()?;
    let r: Rules = serde_json::from_value(value).ok()?;
    (summary(
        r.language,
        &r.validation,
        r.issue_template,
        r.pr_template,
        &r.agent,
    ) == rules)
        .then_some(r.language)
}
pub fn change(
    path: &Path,
    previous: &Declaration,
    next: &Declaration,
    recorded_hash: Option<&str>,
) -> Result<Change, Diagnostic> {
    let mut c = Change::new(path.to_path_buf(), None)?;
    let before = std::str::from_utf8(c.before.bytes.as_deref().unwrap_or_default())
        .map_err(|_| conflict())?;
    let starts: Vec<_> = before.match_indices(START).collect();
    let ends: Vec<_> = before.match_indices(END).collect();
    let block = render(next);
    let after = match (starts.as_slice(), ends.as_slice()) {
        ([], []) => {
            let separator = if before.is_empty() || before.ends_with("\n\n") {
                ""
            } else if before.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            format!("{before}{separator}{block}\n")
        }
        ([(start, _)], [(end, _)]) if start < end => {
            let end = end + END.len();
            let current = &before[*start..end];
            // A worktree-local receipt may describe another checked-out branch.
            // A verified digest or exact released render is independent evidence.
            let canonical = current.replace("\r\n", "\n");
            if !certified(&canonical)
                && !released(&canonical, previous)
                && recorded_hash != Some(hash(current.as_bytes()).as_str())
                && recorded_hash != Some(hash(canonical.as_bytes()).as_str())
            {
                return Err(conflict());
            }
            let block = if current.contains("\r\n") {
                block.replace('\n', "\r\n")
            } else {
                block
            };
            format!("{}{}{}", &before[..*start], block, &before[end..])
        }
        _ => return Err(conflict()),
    };
    c.after = Some(after.into_bytes());
    Ok(c)
}

pub fn has_block(path: &Path) -> Result<bool, Diagnostic> {
    let snapshot = crate::assets::Snapshot::read(path)?;
    let bytes = snapshot.bytes.unwrap_or_default();
    let text = std::str::from_utf8(&bytes).map_err(|_| conflict())?;
    Ok(text.contains(START) || text.contains(END))
}

pub(crate) fn removal(
    root: &Path,
    private: &Path,
    declaration: &Declaration,
) -> Result<Vec<Change>, Diagnostic> {
    let receipt = Change::new(private.join("guidance.json"), None)?;
    let state: Option<Receipt> = receipt
        .before
        .bytes
        .as_deref()
        .map(|bytes| {
            let parsed: Receipt = serde_json::from_value(crate::input::json(bytes, 1_048_576, 16)?)
                .map_err(|_| conflict())?;
            if parsed.version != 1
                || parsed
                    .blocks
                    .keys()
                    .any(|name| !["AGENTS.md", "CLAUDE.md"].contains(&name.as_str()))
            {
                return Err(conflict());
            }
            Ok(parsed)
        })
        .transpose()?;
    let mut changes = vec![];
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let path = root.join(name);
        if !has_block(&path)? {
            if state.as_ref().is_some_and(|s| s.blocks.contains_key(name)) {
                return Err(conflict());
            }
            continue;
        }
        // Reuse refresh validation without using its replacement content.
        let mut c = change(
            &path,
            declaration,
            declaration,
            state
                .as_ref()
                .and_then(|s| s.blocks.get(name))
                .map(String::as_str),
        )?;
        let text = std::str::from_utf8(c.before.bytes.as_deref().unwrap_or_default())
            .map_err(|_| conflict())?;
        let start = text.find(START).ok_or_else(conflict)?;
        let end = text.find(END).ok_or_else(conflict)? + END.len();
        let suffix = &text[end..];
        let suffix = suffix
            .strip_prefix("\r\n")
            .or_else(|| suffix.strip_prefix('\n'))
            .unwrap_or(suffix);
        let after = format!("{}{suffix}", &text[..start]);
        c.after = if after.is_empty() {
            None
        } else {
            Some(after.into_bytes())
        };
        changes.push(c);
    }
    if receipt.before.bytes.is_some() {
        changes.push(receipt);
    }
    Ok(changes)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    generator: String,
    blocks: BTreeMap<String, String>,
}
/// Commit last-generated block hashes together with the corresponding guidance.
pub fn changes(
    root: &Path,
    private: &Path,
    previous: &Declaration,
    next: &Declaration,
    mirror: bool,
) -> Result<Vec<Change>, Diagnostic> {
    let mut receipt = Change::new(private.join("guidance.json"), None)?;
    let mut state = match receipt.before.bytes.as_deref() {
        Some(bytes) => {
            let parsed: Receipt = serde_json::from_value(crate::input::json(bytes, 1_048_576, 16)?)
                .map_err(|_| conflict())?;
            if parsed.version != 1 {
                return Err(conflict());
            }
            parsed
        }
        None => Receipt {
            version: 1,
            generator: env!("CARGO_PKG_VERSION").into(),
            blocks: BTreeMap::new(),
        },
    };
    let mut changes = vec![];
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let path = root.join(name);
        if name == "CLAUDE.md" && !mirror && !has_block(&path)? {
            continue;
        }
        changes.push(change(
            &path,
            previous,
            next,
            state.blocks.get(name).map(String::as_str),
        )?);
        state
            .blocks
            .insert(name.into(), hash(render(next).as_bytes()));
    }
    state.generator = env!("CARGO_PKG_VERSION").into();
    receipt.after = Some(serde_json::to_vec_pretty(&state).map_err(|_| conflict())?);
    changes.push(receipt);
    Ok(changes)
}

/// Migration writes the same ownership evidence as initialization, so later
/// versions can refresh a pristine block without adopting arbitrary user edits.
pub fn migration_receipt(
    root: &Path,
    private: &Path,
    next: &Declaration,
    changes: &[Change],
) -> Result<Change, Diagnostic> {
    let mut receipt = Change::new(private.join("guidance.json"), None)?;
    if receipt.before.bytes.is_some() {
        return Err(conflict());
    }
    let blocks = ["AGENTS.md", "CLAUDE.md"]
        .into_iter()
        .filter(|name| changes.iter().any(|c| c.path == root.join(name)))
        .map(|name| (name.to_owned(), hash(render(next).as_bytes())))
        .collect();
    receipt.after = Some(
        serde_json::to_vec_pretty(&Receipt {
            version: 1,
            generator: env!("CARGO_PKG_VERSION").into(),
            blocks,
        })
        .map_err(|_| conflict())?,
    );
    Ok(receipt)
}
