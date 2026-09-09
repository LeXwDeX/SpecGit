//! Native delivery facts and explicit writes. The observer owns only ForgeRead.
use crate::{
    diagnostic::{Code, Diagnostic, classify_failure},
    probe::{ForgeRead, encode},
    process::{Process, Request, resolve_executable},
    project::{Provider, Repository},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Issue {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub state: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PullRequest {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub state: String,
    pub draft: bool,
    pub head: String,
    pub source: String,
    pub target: String,
    pub source_project: u64,
    pub target_project: u64,
    pub updated_at: String,
}
fn malformed() -> Diagnostic {
    Diagnostic::new(
        Code::MalformedResponse,
        "delivery",
        "Native delivery evidence is missing or malformed.",
        "Inspect the exact issue/request through the selected authenticated CLI; missing fields are not defaults.",
    )
}
fn text(v: &Value, key: &str) -> Result<String, Diagnostic> {
    v.get(key)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(malformed)
}
fn id(v: &Value, key: &str) -> Result<u64, Diagnostic> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(malformed)
}
fn labels(v: &Value, provider: Provider) -> Result<Vec<String>, Diagnostic> {
    v.get("labels")
        .and_then(Value::as_array)
        .ok_or_else(malformed)?
        .iter()
        .map(|v| {
            if provider == Provider::Github {
                text(v, "name")
            } else {
                v.as_str().map(String::from).ok_or_else(malformed)
            }
        })
        .collect()
}
pub fn prefix(repo: &Repository) -> String {
    match repo.provider {
        Provider::Github => format!("repos/{}", repo.path),
        Provider::Gitlab => format!("projects/{}", encode(&repo.path)),
    }
}
fn requests(provider: Provider) -> &'static str {
    if provider == Provider::Github {
        "pulls"
    } else {
        "merge_requests"
    }
}
fn issue_value(v: &Value, repo: &Repository, project_id: u64) -> Result<Issue, Diagnostic> {
    if v.get("pull_request").is_some()
        || (repo.provider == Provider::Gitlab && id(v, "project_id")? != project_id)
    {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "issue",
            "The native object is not an issue in the selected project.",
            "Select an exact same-project issue ID.",
        ));
    }
    let state = text(v, "state")?;
    if !["open", "opened", "closed"].contains(&state.as_str()) {
        return Err(malformed());
    }
    Ok(Issue {
        id: id(
            v,
            if repo.provider == Provider::Github {
                "number"
            } else {
                "iid"
            },
        )?,
        title: text(v, "title")?,
        body: body(v, repo.provider)?,
        labels: labels(v, repo.provider)?,
        state,
        updated_at: text(v, "updated_at")?,
    })
}
fn body(v: &Value, provider: Provider) -> Result<String, Diagnostic> {
    let field = if provider == Provider::Github {
        "body"
    } else {
        "description"
    };
    match v.get(field) {
        Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(malformed()),
    }
}
pub async fn issue(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    number: u64,
) -> Result<Issue, Diagnostic> {
    let v = reader
        .get(&format!("{}/issues/{number}", prefix(repo)))
        .await?;
    let result = issue_value(&v, repo, project_id)?;
    if result.id != number {
        return Err(malformed());
    }
    Ok(result)
}
pub async fn candidates(
    reader: &ForgeRead,
    repo: &Repository,
    project_id: u64,
    query: &str,
) -> Result<Vec<Issue>, Diagnostic> {
    // Search is bounded and every result is expanded before use.
    let (route, key) = match repo.provider {
        Provider::Github => (
            format!(
                "search/issues?q={}",
                encode(&format!("repo:{} is:issue is:open {query}", repo.path))
            ),
            Some("items"),
        ),
        Provider::Gitlab => (
            format!(
                "{}/issues?state=opened&search={}&in=title",
                prefix(repo),
                encode(query)
            ),
            None,
        ),
    };
    let rows = if key.is_some() {
        let mut rows = vec![];
        for page in 1..=10 {
            let value = reader
                .get(&format!("{route}&per_page=100&page={page}"))
                .await?;
            if value.get("incomplete_results").and_then(Value::as_bool) != Some(false) {
                return Err(Diagnostic::new(
                    Code::OutputLimit,
                    "issue_search",
                    "Native issue search is incomplete.",
                    "Narrow the specification query or adopt exact issue IDs.",
                ));
            }
            let items = value
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(malformed)?;
            if items.len() > 100 {
                return Err(malformed());
            }
            rows.extend(items.iter().cloned());
            if items.len() < 100 {
                break;
            }
            if page == 10 {
                return Err(Diagnostic::new(
                    Code::OutputLimit,
                    "issue_search",
                    "Issue candidates exceed the complete search budget.",
                    "Narrow the query or select exact IDs.",
                ));
            }
        }
        rows
    } else {
        reader.list(&route, None, 10).await?
    };
    let mut out = vec![];
    for row in rows {
        out.push(
            issue(
                reader,
                repo,
                project_id,
                id(
                    &row,
                    if repo.provider == Provider::Github {
                        "number"
                    } else {
                        "iid"
                    },
                )?,
            )
            .await?,
        );
    }
    Ok(out)
}
pub async fn label_pool(reader: &ForgeRead, repo: &Repository) -> Result<Vec<String>, Diagnostic> {
    reader
        .list(&format!("{}/labels", prefix(repo)), None, 10)
        .await?
        .iter()
        .map(|v| text(v, "name"))
        .collect()
}
pub async fn pull_request(
    reader: &ForgeRead,
    repo: &Repository,
    number: u64,
) -> Result<PullRequest, Diagnostic> {
    let v = reader
        .get(&format!(
            "{}/{}/{number}",
            prefix(repo),
            requests(repo.provider)
        ))
        .await?;
    request_value(&v, repo, number)
}
pub fn request_value(v: &Value, repo: &Repository, number: u64) -> Result<PullRequest, Diagnostic> {
    let gh = repo.provider == Provider::Github;
    let (source, target, head, source_project, target_project) = if gh {
        let source = v.get("head").ok_or_else(malformed)?;
        let target = v.get("base").ok_or_else(malformed)?;
        (
            text(source, "ref")?,
            text(target, "ref")?,
            text(source, "sha")?,
            id(source.get("repo").ok_or_else(malformed)?, "id")?,
            id(target.get("repo").ok_or_else(malformed)?, "id")?,
        )
    } else {
        (
            text(v, "source_branch")?,
            text(v, "target_branch")?,
            text(v, "sha")?,
            id(v, "source_project_id")?,
            id(v, "target_project_id")?,
        )
    };
    if !crate::project::valid_oid(&head) {
        return Err(malformed());
    }
    let mut state = text(v, "state")?;
    if gh
        && v.get("merged")
            .and_then(Value::as_bool)
            .ok_or_else(malformed)?
    {
        state = "merged".into();
    }
    if !["open", "opened", "closed", "merged"].contains(&state.as_str()) {
        return Err(malformed());
    }
    let result = PullRequest {
        id: id(v, if gh { "number" } else { "iid" })?,
        title: text(v, "title")?,
        body: body(v, repo.provider)?,
        labels: labels(v, repo.provider)?,
        state,
        draft: v
            .get("draft")
            .and_then(Value::as_bool)
            .ok_or_else(malformed)?,
        head,
        source,
        target,
        source_project,
        target_project,
        updated_at: text(v, "updated_at")?,
    };
    if result.id != number {
        return Err(malformed());
    }
    Ok(result)
}
pub async fn request_candidates(
    reader: &ForgeRead,
    repo: &Repository,
    source: &str,
) -> Result<Vec<PullRequest>, Diagnostic> {
    let route = if repo.provider == Provider::Github {
        let owner = repo.path.split('/').next().ok_or_else(malformed)?;
        format!(
            "{}/pulls?state=all&head={}",
            prefix(repo),
            encode(&format!("{owner}:{source}"))
        )
    } else {
        format!(
            "{}/merge_requests?scope=all&source_branch={}",
            prefix(repo),
            encode(source)
        )
    };
    let rows = reader.list(&route, None, 10).await?;
    let mut results = vec![];
    for row in rows {
        let number = id(
            &row,
            if repo.provider == Provider::Github {
                "number"
            } else {
                "iid"
            },
        )?;
        results.push(pull_request(reader, repo, number).await?);
    }
    Ok(results)
}
pub async fn branch_head(
    reader: &ForgeRead,
    repo: &Repository,
    branch: &str,
) -> Result<String, Diagnostic> {
    let route = if repo.provider == Provider::Github {
        format!("{}/branches/{}", prefix(repo), encode(branch))
    } else {
        format!("{}/repository/branches/{}", prefix(repo), encode(branch))
    };
    let value = reader.get(&route).await?;
    if text(&value, "name")? != branch {
        return Err(malformed());
    }
    let sha = text(
        value.get("commit").ok_or_else(malformed)?,
        if repo.provider == Provider::Github {
            "sha"
        } else {
            "id"
        },
    )?;
    if !crate::project::valid_oid(&sha) {
        return Err(malformed());
    }
    Ok(sha)
}
/// Only establishes that at least one real changed file exists; never an exhaustive diff inventory.
pub async fn has_changes(
    reader: &ForgeRead,
    repo: &Repository,
    base: &str,
    head: &str,
) -> Result<bool, Diagnostic> {
    if !crate::project::valid_oid(base) || !crate::project::valid_oid(head) {
        return Err(malformed());
    }
    let gh = repo.provider == Provider::Github;
    let route = if gh {
        format!("{}/compare/{base}...{head}", prefix(repo))
    } else {
        format!("{}/repository/compare?from={base}&to={head}", prefix(repo))
    };
    let value = reader.get(&route).await?;
    if !gh && value.get("compare_timeout").and_then(Value::as_bool) != Some(false) {
        return Err(malformed());
    }
    let files = value
        .get(if gh { "files" } else { "diffs" })
        .and_then(Value::as_array)
        .ok_or_else(malformed)?;
    if gh {
        let ahead = value
            .get("ahead_by")
            .and_then(Value::as_u64)
            .ok_or_else(malformed)?;
        if ahead == 0 {
            return Ok(false);
        }
    }
    Ok(!files.is_empty())
}

/// Constructed only by an explicit issue/pr operation, never passed to a hook or watch.
pub struct ForgeWrite {
    process: Process,
    executable: PathBuf,
    cwd: PathBuf,
    repo: Repository,
}
impl ForgeWrite {
    pub async fn merge(
        &self,
        number: u64,
        head: &str,
        mode: crate::merge::Mode,
        strategy: crate::merge::Strategy,
    ) -> Result<(), Diagnostic> {
        use crate::merge::{Mode, Strategy};
        if number == 0 || !crate::project::valid_oid(head) {
            return Err(malformed());
        }
        let number = number.to_string();
        let gh = self.repo.provider == Provider::Github;
        let repo = if gh {
            format!("{}/{}", self.repo.host, self.repo.path)
        } else {
            format!("https://{}/{}", self.repo.host, self.repo.path)
        };
        let mut args = vec![
            if gh { "pr" } else { "mr" },
            "merge",
            &number,
            "--repo",
            &repo,
            if gh { "--match-head-commit" } else { "--sha" },
            head,
        ];
        if gh {
            args.push(match strategy {
                Strategy::Merge => "--merge",
                Strategy::Squash => "--squash",
                Strategy::Rebase => "--rebase",
            });
            if mode == Mode::Auto {
                args.push("--auto");
            }
        } else {
            if strategy == Strategy::Rebase {
                return Err(Diagnostic::input(
                    "GitLab rebase must be an explicit separate operation.",
                ));
            }
            if strategy == Strategy::Squash {
                args.push("--squash");
            }
            args.extend([
                "--yes",
                if mode == Mode::Auto {
                    "--auto-merge=true"
                } else {
                    "--auto-merge=false"
                },
            ]);
        }
        let output = self
            .process
            .run(Request::new(&self.executable, &self.cwd, "native_merge").args(args))
            .await?;
        if output.code != 0 {
            return Err(classify_failure("native_merge", &output.stderr));
        }
        Ok(())
    }
    pub async fn update_request_body(&self, number: u64, body: &str) -> Result<(), Diagnostic> {
        let gh = self.repo.provider == Provider::Github;
        self.write(
            if gh { "PATCH" } else { "PUT" },
            &format!("{}/{number}", requests(self.repo.provider)),
            if gh {
                json!({"body":body})
            } else {
                json!({"description":body})
            },
        )
        .await?;
        Ok(())
    }
    pub async fn add_request_labels(
        &self,
        number: u64,
        labels: &[String],
    ) -> Result<(), Diagnostic> {
        if self.repo.provider == Provider::Github {
            self.write(
                "POST",
                &format!("issues/{number}/labels"),
                json!({"labels":labels}),
            )
            .await?;
        } else {
            self.write(
                "PUT",
                &format!("merge_requests/{number}"),
                json!({"add_labels":labels.join(",")}),
            )
            .await?;
        }
        Ok(())
    }
    pub async fn ready(&self, number: u64) -> Result<(), Diagnostic> {
        let number = number.to_string();
        let (noun, verb, repo) = if self.repo.provider == Provider::Github {
            (
                "pr",
                "ready",
                format!("{}/{}", self.repo.host, self.repo.path),
            )
        } else {
            (
                "mr",
                "update",
                format!("https://{}/{}", self.repo.host, self.repo.path),
            )
        };
        let mut args = vec![noun, verb, &number, "--repo", &repo];
        if self.repo.provider == Provider::Gitlab {
            args.push("--ready");
        }
        let out = self
            .process
            .run(Request::new(&self.executable, &self.cwd, "request_ready").args(args))
            .await?;
        if out.code != 0 {
            return Err(classify_failure("request_ready", &out.stderr));
        }
        Ok(())
    }
    pub fn new(process: Process, cwd: &Path, repo: &Repository) -> Result<Self, Diagnostic> {
        Ok(Self {
            process,
            executable: resolve_executable(repo.provider.executable())?,
            cwd: cwd.into(),
            repo: repo.clone(),
        })
    }
    async fn write(&self, method: &str, suffix: &str, body: Value) -> Result<Value, Diagnostic> {
        let endpoint = format!("{}/{}", prefix(&self.repo), suffix);
        let mut request = Request::new(&self.executable, &self.cwd, "delivery_write").args([
            "api",
            "--hostname",
            &self.repo.host,
            "--method",
            method,
            "--input",
            "-",
            &endpoint,
        ]);
        request.input = serde_json::to_vec(&body).map_err(|_| malformed())?;
        let output = self.process.run(request).await?;
        if output.code != 0 {
            return Err(classify_failure("delivery_write", &output.stderr));
        }
        crate::input::json(&output.stdout, self.process.limits.output_bytes, 32)
    }
    pub async fn create_label(&self, tag: &crate::config::Tag) -> Result<(), Diagnostic> {
        self.write("POST", "labels", json!({"name":tag.name,"color":if self.repo.provider == Provider::Gitlab { format!("#{}",tag.color) } else { tag.color.clone() },"description":tag.description})).await?;
        Ok(())
    }
    pub async fn create_issue(
        &self,
        title: &str,
        body: &str,
        labels: &[String],
    ) -> Result<u64, Diagnostic> {
        let payload = if self.repo.provider == Provider::Github {
            json!({"title":title,"body":body,"labels":labels})
        } else {
            json!({"title":title,"description":body,"labels":labels.join(",")})
        };
        let v = self.write("POST", "issues", payload).await?;
        id(
            &v,
            if self.repo.provider == Provider::Github {
                "number"
            } else {
                "iid"
            },
        )
    }
    pub async fn create_request(
        &self,
        source: &str,
        target: &str,
        title: &str,
        body: &str,
    ) -> Result<u64, Diagnostic> {
        let gh = self.repo.provider == Provider::Github;
        let payload = if gh {
            json!({"head":source,"base":target,"title":title,"body":body,"draft":true})
        } else {
            json!({"source_branch":source,"target_branch":target,"title":format!("Draft: {title}"),"description":body})
        };
        let v = self
            .write("POST", requests(self.repo.provider), payload)
            .await?;
        id(&v, if gh { "number" } else { "iid" })
    }
}
