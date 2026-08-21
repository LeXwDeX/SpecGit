# SpecGit skills

Portable agent entry points, tool-agnostic (codex, pi-agent, cursor, and any
harness that discovers `SKILL.md` files). For opencode, prefer the project
commands under `.opencode/command/` — same behavior, native trigger.

| Skill | Purpose |
| --- | --- |
| [`specgit-issue`](specgit-issue/SKILL.md) | One-command delivery bootstrap: N issues → branch → draft PR → record |
| [`specgit-finish`](specgit-finish/SKILL.md) | The evidence verdict and the fix loop to exit 0 |

## Install

Copy or link the skill directories into your tool's skills location, e.g.:

```bash
ln -s "$PWD/skills/specgit-issue"  ~/.agents/skills/specgit-issue
ln -s "$PWD/skills/specgit-finish" ~/.agents/skills/specgit-finish
```

The AGENTS.md block installed by `specgit init` remains the canonical
behavior source; skills only provide discovery entry points and stay
deliberately thin. A guided `specgit setup` installer shipped with
[#7](https://github.com/LeXwDeX/SpecGit/issues/7) (`--tool opencode | generic | all`).
