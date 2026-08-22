---
"specgit": patch
---

Align the contract docs with the shipped delivery-name behaviour: the
product-contract bullet in AGENTS.md, the language section of
`docs/cli.md` (which contradicted its own updated command section), and
the v1 baseline now all state that a title yielding no ASCII slug never
falls back to `issue<N>` — bootstrap asks for a kebab-case delivery
name, and scripted sessions pass `--delivery <slug>`
([#263](https://github.com/LeXwDeX/SpecGit/issues/263)). Documentation
only — no behaviour or machine-contract change.
