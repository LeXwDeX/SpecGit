---
'specgit': patch
---

Executable doc examples enforced by a contract test (#353). The Quick Start multi-issue example in README.md, docs/cli.md, and docs/workflow-guide.md ("Harden the session model", "Extend the harness") lacked the required `<type>:` prefix and exited 2 when copy-pasted; they now read `security: harden the session model` / `refactor: extend the harness`. A new docs-consistency test extracts every concrete `specgit issue "…"` example from code contexts (fenced blocks and inline code spans; placeholders skipped) across README, CONTRIBUTING, docs/, and workflows/, and runs it through the production `validateIssueTitles` — future doc rot of this class fails CI.
