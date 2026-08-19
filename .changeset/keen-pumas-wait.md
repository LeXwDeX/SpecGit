---
"specgit": patch
---

### Attributed timeout diagnostics (`gh_timeout`)

A `gh` call that exceeds its time budget (default 15 s) now fails with the
dedicated `gh_timeout` code instead of the generic `gh_transport`, and the
fix names the three likely causes in order — network reachability
(`curl -sI https://api.github.com`), a GitHub incident (githubstatus.com),
or a genuinely slow call — plus the knob: `SPECGIT_GH_TIMEOUT_MS`
(milliseconds) raises the per-call budget for every `gh` invocation SpecGit
spawns.
