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
    pub declaration: Declaration,
    pub reader: ForgeRead,
    pub facts: ProjectFacts,
    pub target: String,
    declaration_bytes: Option<Vec<u8>>,
}
impl Workspace {
    pub async fn load(process: Process, cwd: &Path) -> Result<Self, Diagnostic> {
        let bytes = project::git(&process, cwd, &["rev-parse", "--show-toplevel"]).await?;
        let root = PathBuf::from(
            String::from_utf8(bytes)
                .map_err(|_| Diagnostic::input("Invalid Git root."))?
                .trim_end_matches(['\r', '\n']),
        );
        let declaration_bytes = config::snapshot(&root)?.bytes;
        let declaration = Declaration::parse(declaration_bytes.as_deref().ok_or_else(|| {
            Diagnostic::input("Initialize the v2 declaration before selecting a delivery.")
        })?)?;
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
            || facts.id != self.facts.id
            || facts.default_branch != self.facts.default_branch
            || config::snapshot(&self.context.root)?.bytes != self.declaration_bytes
        {
            return Err(Diagnostic::new(
                Code::ConcurrentEdit,
                "delivery",
                "Git, declaration or native project identity changed during the operation.",
                "Re-read the current worktree and project before retrying.",
            ));
        }
        Ok(())
    }
    pub fn branch(&self) -> Result<&str, Diagnostic> {
        self.context
            .branch
            .as_deref()
            .ok_or_else(|| Diagnostic::input("A delivery request requires a selected branch."))
    }
}
