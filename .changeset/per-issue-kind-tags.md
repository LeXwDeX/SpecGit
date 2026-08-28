---
"specgit": patch
---

Multi-title bootstraps now tag each issue with its OWN title's `kind::<type>` instead of stamping the first title's kind on every bound issue: the record carries `issueKinds` (issue → kind) written durably per issue, reused numeric issues and title-less issues carry no kind rather than inheriting one, and explicit `--tags` behaviour is unchanged.
