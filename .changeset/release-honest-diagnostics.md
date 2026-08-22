---
"specgit": patch
---

Fix the release watchdog's evidence source and make GitLab diagnostics honest: the version-PR watchdog now polls workflow runs instead of the per-commit check-run list (approval-waiting runs never create check-runs, so the alarm could not fire — #265), and init on a declared GitLab origin no longer claims to create the GitHub Actions workflow it skips, with checks diagnostics GitLab-shaped there (#269).
