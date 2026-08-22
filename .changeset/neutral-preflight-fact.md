---
"specgit": patch
---

Extract the preflight fact into a named, platform-neutral `PreflightFact`
on the forge port and rename the advisory flag to `versionUnverified`
(#247). No behaviour or machine-contract change: exit codes, `--json`
fields, and the `gitlab_version_unverified` diagnostic code are
untouched. Also untracks review scratch files and hardens `.gitignore`
so `git add -A` never sweeps local scratch into a delivery.
