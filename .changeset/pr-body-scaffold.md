---
"specgit": minor
---

### Deterministic draft PR scaffold

`specgit issue` now opens the draft pull request with a deterministic
scaffold body instead of a bare closing-keyword list: the `Closes #n`
line for every bound issue comes first, followed by Why / What changed /
Evidence / Checklist sections. The renderer is a pure function of the
bound issues — the same binding always renders the identical body — and
its placeholders are advisory: closing references remain the only body
gate, and the section text adds no closing-shaped content of its own.

The body is written exactly once, at draft creation. Resume and
`specgit pr` repair bind or adopt the existing PR without touching its
body, so user edits survive every re-run. The renderer reads none of the
adopting repository's files: repositories keep full ownership of their
own pull-request templates (`PULL_REQUEST_TEMPLATE.md` in `.github/`,
the root, or `docs/`), which GitHub skips anyway when a body is passed
explicitly.
