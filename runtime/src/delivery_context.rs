//! A command's selected Git/declaration/native identity, rechecked at write boundaries.
use crate::{
    config::{self, Declaration},
    diagnostic::{Code, Diagnostic},
    probe::{ForgeRead, ProjectFacts},
    process::Process,
    project::{self, Context},
};
use std::path::{Path, PathBuf};
pub struct Workspace {
    pub process: Process,
    pub context: Context,
    declaration: Declaration,
    pub reader: ForgeRead,
    pub facts: ProjectFacts,
    pub target: String,
    declaration_bytes: Option<Vec<u8>>,
}
impl Workspace {
    pub async fn load(process: Process, cwd: &Path) -> Result<Self, Diagnostic> {
        Self::load_with_message(
            process,
            cwd,
            "Initialize the v2 declaration before selecting a delivery.",
        )
        .await
    }
    pub(crate) async fn load_issue(process: Process, cwd: &Path) -> Result<Self, Diagnostic> {
        Self::load_with_message(
            process,
            cwd,
            "Initialize the v2 project declaration before selecting a delivery.",
        )
        .await
    }
    async fn load_with_message(
        process: Process,
        cwd: &Path,
        missing_declaration: &str,
    ) -> Result<Self, Diagnostic> {
        let bytes = project::git(&process, cwd, &["rev-parse", "--show-toplevel"]).await?;
        let root = PathBuf::from(
            String::from_utf8(bytes)
                .map_err(|_| Diagnostic::input("Invalid Git root."))?
                .trim_end_matches(['\r', '\n']),
        );
        let declaration_bytes = config::snapshot(&root)?.bytes;
        let declaration = Declaration::parse(
            declaration_bytes
                .as_deref()
                .ok_or_else(|| Diagnostic::input(missing_declaration))?,
        )?;
        let context = config::resolve(
            &process,
            &root,
            declaration.remote.as_deref(),
            declaration.provider,
            None,
        )
        .await?;
        let reader = ForgeRead::new(
            process.clone(),
            &root,
            context.repository.provider,
            &context.repository.host,
        )?;
        let facts = reader.project(&context.repository).await?;
        let target = declaration
            .target
            .clone()
            .unwrap_or(facts.default_branch.clone());
        Ok(Self {
            process,
            context,
            declaration,
            reader,
            facts,
            target,
            declaration_bytes,
        })
    }
    pub async fn unchanged(&self) -> Result<(), Diagnostic> {
        self.unchanged_with_diagnostic(Diagnostic::new(
            Code::ConcurrentEdit,
            "delivery",
            "Git, declaration or native project identity changed during the operation.",
            "Re-read the current worktree and project before retrying.",
        ))
        .await
    }
    pub(crate) async fn unchanged_issue(&self) -> Result<(), Diagnostic> {
        self.unchanged_with_diagnostic(Diagnostic::new(
            Code::ConcurrentEdit,
            "issue_workspace",
            "Git, declaration or native project identity changed during Issue preparation.",
            "Inspect the current branch and retained write intents before retrying.",
        ))
        .await
    }
    async fn unchanged_with_diagnostic(&self, changed: Diagnostic) -> Result<(), Diagnostic> {
        let current = config::resolve(
            &self.process,
            &self.context.root,
            self.declaration.remote.as_deref(),
            self.declaration.provider,
            None,
        )
        .await?;
        let facts = self.reader.project(&self.context.repository).await?;
        if current.repository != self.context.repository
            || current.branch != self.context.branch
            || current.head != self.context.head
            || current.dirty != self.context.dirty
            || current.git_dir != self.context.git_dir
            || current.remote != self.context.remote
            || facts.id != self.facts.id
            || facts.default_branch != self.facts.default_branch
            || config::snapshot(&self.context.root)?.bytes != self.declaration_bytes
        {
            return Err(changed);
        }
        Ok(())
    }
    pub fn specification(&self) -> crate::spec::Specification<'_> {
        crate::spec::Specification::new(&self.declaration)
    }
    pub fn close_issues_after_merge(&self) -> bool {
        self.declaration.agent.close_issues_after_merge
    }
    pub fn branch(&self) -> Result<&str, Diagnostic> {
        self.branch_with_message("A delivery request requires a selected branch.")
    }
    pub(crate) fn issue_branch(&self) -> Result<&str, Diagnostic> {
        self.branch_with_message(
            "Select a branch before binding issues; detached HEAD cannot own a delivery.",
        )
    }
    fn branch_with_message(&self, message: &str) -> Result<&str, Diagnostic> {
        self.context
            .branch
            .as_deref()
            .ok_or_else(|| Diagnostic::input(message))
    }
}
