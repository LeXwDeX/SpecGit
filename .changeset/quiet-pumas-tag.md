---
"specgit": patch
---

### Release idempotence decided by tag existence

The release workflow treated a MERGED version PR as "already shipped" — but
the `changeset-release/main` branch keeps the previous version's merged PR,
so the next release was silently skipped. The check now decides by tag:
`v<version>` already on the remote means shipped (exit 0); otherwise the
version PR is created (or recreated after an older merge), regardless of
the stale PR state.
