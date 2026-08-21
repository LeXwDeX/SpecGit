# SpecGit skills

Portable agent entry points, tool-agnostic (codex, pi-agent, cursor, and any
harness that discovers `SKILL.md` files). For opencode, prefer the project
commands under `.opencode/command/` — same behavior, native trigger.

| Skill | Purpose |
| --- | --- |
| [`specgit-issue`](specgit-issue/SKILL.md) | One-command delivery bootstrap: N issues → branch → draft PR → record |
| [`specgit-finish`](specgit-finish/SKILL.md) | The evidence verdict and the fix loop to exit 0 |
| [`specgit-doctor`](specgit-doctor/SKILL.md) | The exit-3 diagnostic loop: run the probes, apply each fix, re-run |
| [`specgit-pr`](specgit-pr/SKILL.md) | Repair the PR binding — auto-discover by head branch or bind explicitly |
| [`specgit-status`](specgit-status/SKILL.md) | Local evidence: record, delivery state, drift, origin |

## Install

Copy or link the skill directories into your tool's skills location, e.g.:

```bash
ln -s "$PWD/skills/specgit-issue"  ~/.agents/skills/specgit-issue
ln -s "$PWD/skills/specgit-finish" ~/.agents/skills/specgit-finish
ln -s "$PWD/skills/specgit-doctor" ~/.agents/skills/specgit-doctor
ln -s "$PWD/skills/specgit-pr"     ~/.agents/skills/specgit-pr
ln -s "$PWD/skills/specgit-status" ~/.agents/skills/specgit-status
```

The AGENTS.md block installed by `specgit init` remains the canonical
behavior source; skills only provide discovery entry points and stay
deliberately thin. A guided `specgit setup` installer shipped with
[#7](https://github.com/LeXwDeX/SpecGit/issues/7) (`--tool opencode | generic | all`).
