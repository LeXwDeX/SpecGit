---
"specgit": minor
---

## `specgit issue` never invents a delivery name

- When a title yields no ASCII slug, bootstrap no longer falls back to
  `issue<N>`: an interactive session is asked for a kebab-case delivery
  name (up to three attempts), and a scripted session fails closed with
  `issue_delivery_name_required` pointing at the explicit flag
  ([#246](https://github.com/LeXwDeX/SpecGit/issues/246)).
- New `--delivery <slug>` flag names the delivery explicitly and wins
  over the derived slug; an invalid value fails with
  `issue_delivery_name_invalid` before any side effect.
- Resume never asks again: the recorded name is reused as-is. Branch
  syntax is unchanged (`<type>/<issue>-<slug>`), and the machine
  contract (exit codes, `--json` fields) is untouched.
