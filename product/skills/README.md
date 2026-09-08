# SpecGit skills

Portable agent entry points, tool-agnostic (codex, pi-agent, cursor, and any
harness that discovers `SKILL.md` files). For opencode, prefer the project
commands under `.opencode/command/` — same behavior, native trigger.

These five files are a **generated mirror**, not a second source: each
`SKILL.md` is byte-identical to what `specgit setup --tool generic` installs
under `.agents/skills/<name>/SKILL.md` in a project (ownership marker and
frontmatter included). The skill text lives in
`src/cli/agent-surface.ts`; after changing it, regenerate the mirror with
the project commands —

```bash
pnpm run build && pnpm run build:skills
```

— and the byte-level pin in `test/specgit-cli/skills-mirror.test.ts` fails
if the tracked copy ever drifts from the generator.

| Skill | Purpose |
| --- | --- |
| [`specgit-issue`](specgit-issue/SKILL.md) | One-command delivery bootstrap: N issues → branch → draft PR/MR → record |
| [`specgit-finish`](specgit-finish/SKILL.md) | The evidence verdict and the fix loop to exit 0 |
| [`specgit-doctor`](specgit-doctor/SKILL.md) | The exit-3 diagnostic loop: run the probes, apply each fix, re-run |
| [`specgit-pr`](specgit-pr/SKILL.md) | Repair the PR/MR binding — auto-discover by head branch or bind explicitly |
| [`specgit-status`](specgit-status/SKILL.md) | Local evidence: record, delivery state, drift, origin |

## Install

Inside a SpecGit project, `specgit setup` is the installer — it writes the
entry points itself:

```bash
specgit setup --tool generic   # .agents/skills/specgit-*/SKILL.md in the project
specgit setup --tool opencode  # .opencode/command/specgit-*.md in the project
specgit setup --tool all       # both surfaces
```

For a tool that lives outside any project, copy or link the skill
directories into that tool's skills location, e.g.:

```bash
ln -s "$PWD/skills/specgit-issue"  ~/.agents/skills/specgit-issue
ln -s "$PWD/skills/specgit-finish" ~/.agents/skills/specgit-finish
ln -s "$PWD/skills/specgit-doctor" ~/.agents/skills/specgit-doctor
ln -s "$PWD/skills/specgit-pr"     ~/.agents/skills/specgit-pr
ln -s "$PWD/skills/specgit-status" ~/.agents/skills/specgit-status
```

The AGENTS.md block installed by `specgit init` remains the canonical
behavior source; skills only provide discovery entry points and stay
deliberately thin.
