/**
 * `specgit setup` — installs the agent entry points into the current
 * repository, from templates embedded in the CLI binary. Complements
 * `init` (which lays the harness); setup tailors per-tool triggers:
 *
 * - `opencode`  → `.opencode/command/specgit-{issue,finish,doctor,pr,status}.md`
 * - `generic`   → `.agents/skills/specgit-{issue,finish,doctor,pr,status}/SKILL.md`
 *   (portable SKILL.md frontmatter, discoverable by codex / pi-agent /
 *   cursor and any harness that scans skill directories)
 *
 * With no `--tool` flag the tool is auto-detected: an existing
 * `.opencode/` directory selects opencode, otherwise generic.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ISSUE_TYPE_LIST } from './commands/issue.js';

export type SetupTool = 'opencode' | 'generic' | 'all';

const ISSUE_COMMAND = `---
description: Start a SpecGit delivery from a title or existing issue number
---

# /specgit-issue

Thin trigger for the delivery bootstrap. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Collect the argument: \`$ARGUMENTS\` is either an issue title (create) or a
   pure number (reuse). Multiple arguments = N issues in one delivery.
2. Run from the repo root:

   \`\`\`bash
   specgit issue "$ARGUMENTS" --json
   \`\`\`

3. On success report the brief: issue URL(s), PR URL (draft), branch name —
   then fill in the draft PR's scaffold (Why / What changed / Evidence).
   Its placeholders are advisory; never treat them as gates and never
   remove the closing references.
4. Switch to the delivery branch and begin the TDD loop.
5. On error, read \`errors[].fix\` and follow it — never bypass the record.
`;

const FINISH_COMMAND = `---
description: Run the SpecGit evidence verdict and drive the fix loop to exit 0
---

# /specgit-finish

Thin trigger for the acceptance verdict. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the delivery branch:

   \`\`\`bash
   specgit finish --json
   \`\`\`

2. Branch on the exit code:
   - \`exit 0\` → produce the merge brief (issues + PR + CI run links + the
     verdict) and ask the user to approve the merge. Do not merge yourself
     without approval.
   - \`exit 1\` → read \`errors[].fix\` / gate failures, fix exactly what they
     name, re-run. Loop until exit 0.
   - \`exit 3\` → report the environment problem (gh auth / network); never
     edit the record or the policy to work around it.
3. Iron rules: never weaken \`spec_git/policy.yaml\` to pass; \`--json\` is the
   only parse surface; a non-zero verdict never merges.
`;

const ISSUE_SKILL = `---
name: specgit-issue
description: Start a SpecGit delivery — create or reuse GitHub issues, branch, draft PR that closes them, and record the binding, in one command.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
metadata:
  author: specgit
---

# specgit-issue

The delivery bootstrap. One command binds the whole aggregate: N issues, one
branch, one draft pull request, one record (\`.specgit.yaml\`).

## Usage

\`\`\`bash
specgit issue "<title>"                 # create one issue and start
specgit issue "<title A>" "<title B>"   # N issues, one delivery
specgit issue 42                        # reuse an existing issue
specgit issue "<no-slug title>" --delivery my-name   # explicit delivery name
\`\`\`

New titles must start with \`<type>: \`; allowed types: ${ISSUE_TYPE_LIST}.

## What it does (idempotent; re-run resumes)

1. Creates (or reuses) the issues — one issue = one independently verifiable
   WHY.
2. Creates and checks out the delivery branch.
3. Opens a draft PR pre-filled with a deterministic scaffold: the
   \`Closes #n\` line for every bound issue first, then Why / What changed /
   Evidence / Checklist sections.
4. Writes \`.specgit.yaml\` and commits it.
5. Pushes the branch.

## Rules

- Run it from the repository root; context comes from live git.
- Fill in the scaffold sections as you deliver; placeholders are advisory,
  never gates. Keep the closing references intact.
- The PR body is written once at creation; no SpecGit command edits it
  afterwards, and the repository's own PR template is never read.
- If it fails mid-chain, re-run the same command — completed steps are
  detected and resumed; never hand-edit \`.specgit.yaml\`.
- When the title yields no ASCII slug, the command asks for a kebab-case
  delivery name on an interactive terminal; a scripted session must pass
  \`--delivery <slug>\` (exit 2 otherwise). Bootstrap never invents a name.
`;

const FINISH_SKILL = `---
name: specgit-finish
description: Run the SpecGit evidence verdict — fail-closed acceptance derived from real git, PR, and CI evidence; exit 0 is the only done.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
metadata:
  author: specgit
---

# specgit-finish

The acceptance verdict. Eleven gates evaluate live evidence: record, policy,
completeness, context, origin, provider, issues, sequence (ordered
deliveries), PR, closing refs, and required checks at the PR head.

## Usage

\`\`\`bash
specgit finish --json
\`\`\`

## Steps

1. Before running the verdict, confirm the bound pull request is not a
   draft — a draft always fails with \`pr_draft\` (factual, exit 1). If it
   is still a draft, mark it ready for review first:

   \`\`\`bash
   gh pr ready <number>              # GitHub deliveries
   glab mr update <number> --ready   # GitLab deliveries
   \`\`\`

2. Run the verdict from the delivery branch:

   \`\`\`bash
   specgit finish --json
   \`\`\`

3. Branch on the exit code using the contract below; on \`1\` fix exactly
   what the failures name and re-run until \`0\`.

## Exit contract

- \`0\` accepted — produce the merge brief and ask the human to approve.
- \`1\` rejected — each failure carries a \`fix\`; fix what the gates name,
  re-run until 0.
- \`3\` unknown — fix the environment; never touch the record or policy.

## Rules

- Evidence only: file contents can never change the verdict.
- Never weaken \`spec_git/policy.yaml\` to make a verdict pass.
- \`--json\` is the only parse surface.
`;

// #165: exit 3 is the one verdict outcome an agent cannot fix by editing
// the delivery — the skill below installs the probe-driven repair loop.
const DOCTOR_COMMAND = `---
description: Diagnose the SpecGit environment probes and drive the exit-3 repair loop
---

# /specgit-doctor

Thin trigger for the exit-3 diagnostic loop. The canonical behavior lives in
the AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the repo root:

   \`\`\`bash
   specgit doctor --json
   \`\`\`

2. Read \`probes[]\`: every failing probe carries a \`code\` (git, repo,
   origin, gh/glab presence and auth, policy).
3. Fix exactly what the failing probe names, then re-run
   \`specgit doctor --json\` until exit 0.
4. Return to the verdict: \`specgit finish --json\`. Exit 3 is environment,
   never delivery — do not edit the record or the policy to work around it.
5. \`--json\` is the only parse surface.
`;

const PR_COMMAND = `---
description: Repair the SpecGit PR binding — auto-discover by head branch or bind explicitly
---

# /specgit-pr

Thin trigger for PR-binding repair. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the delivery branch:

   \`\`\`bash
   specgit pr --json
   \`\`\`

2. Branch on the result:
   - \`exit 0\` → the record's PR binding is repaired; resume the delivery.
   - \`pr_not_found\` → push the branch (re-running \`specgit issue\`
     resumes the bootstrap), then rerun this command.
   - \`pr_ambiguous\` → several open PRs share the head branch; bind one
     explicitly: \`specgit pr <number>\`.
3. \`specgit pr\` owns the PR binding; never hand-edit \`.specgit.yaml\`.
   \`--json\` is the only parse surface.
`;

const STATUS_COMMAND = `---
description: Show local SpecGit evidence — record, delivery state, drift, origin
---

# /specgit-status

Thin trigger for local evidence. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the repo root:

   \`\`\`bash
   specgit status --json
   \`\`\`

2. Read \`state\` and \`record\` from the envelope: local evidence only —
   record, drift, origin. Platform evidence (issues, PR, checks) belongs
   to \`specgit finish\`.
3. No record → bootstrap with \`specgit issue\`. On \`exit 3\` read
   \`errors[].fix\`. Never hand-edit \`.specgit.yaml\`.
`;

const DOCTOR_SKILL = `---
name: specgit-doctor
description: Resolve a SpecGit exit 3 — run the doctor probes, apply each fix, re-run until the verdict can run again.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
metadata:
  author: specgit
---

# specgit-doctor

The exit-3 diagnostic loop. Exit code 3 means no verdict was possible — the
environment, not the delivery, is broken. Retrying \`finish\` blindly will
never pass; the probes tell you what to fix.

## When to use

\`specgit finish --json\` exited \`3\` (unknown). The \`errors[].code\` names
the failing gate; the loop below resolves it.

## Steps

1. Run the probes from the repository root:

   \`\`\`bash
   specgit doctor --json
   \`\`\`

2. Read \`probes[]\`: each failing probe carries a \`code\` — git binary,
   repository, origin, gh/glab presence and auth, policy.
3. Apply the fix the failing probe names:
   - \`git\` missing → install the git binary or fix PATH.
   - \`repo\` → run from the repository root.
   - \`no_origin\` / origin parse → configure a parseable origin remote.
   - \`gh_missing\` / \`glab_missing\` → install the platform CLI.
   - gh/glab auth → \`gh auth login\` (or \`glab auth login\`).
   - \`policy\` missing → run \`specgit init\`.
4. Re-run \`specgit doctor --json\` until exit 0.
5. Return to the verdict: \`specgit finish --json\`.

## Rules

- Exit 3 is environment, never delivery: never edit the record or the
  policy to work around a probe.
- \`--json\` is the only parse surface — parse the envelope, never
  human-readable lines.
- Do not loop on \`finish\` itself; always go through the probes first.
`;

const PR_SKILL = `---
name: specgit-pr
description: Repair the SpecGit PR binding — auto-discover the pull request by head branch, or bind an explicit number.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
metadata:
  author: specgit
---

# specgit-pr

Repairs the record's PR binding without touching issues or the branch.

## Usage

\`\`\`bash
specgit pr              # auto-discover the PR for this head branch
specgit pr 123          # bind an explicit number (no platform round-trip)
\`\`\`

## Steps

1. Run from the delivery branch:

   \`\`\`bash
   specgit pr --json
   \`\`\`

2. Branch on the result:
   - \`exit 0\` → the binding is repaired; resume the delivery.
   - \`pr_not_found\` → push the branch and re-run \`specgit issue\` to
     resume the bootstrap, then rerun this command.
   - \`pr_ambiguous\` → several open PRs share the head branch; bind one
     explicitly: \`specgit pr <number>\`.

## Rules

- \`specgit pr\` owns the PR binding; never hand-edit \`.specgit.yaml\`.
- \`--json\` is the only parse surface.
`;

const STATUS_SKILL = `---
name: specgit-status
description: Show local SpecGit evidence — record, delivery state, drift, origin — without contacting the platform.
allowed-tools: Bash(specgit:*), Bash(git:*)
license: MIT
metadata:
  author: specgit
---

# specgit-status

Local evidence only: the record, the delivery state, drift, and the origin.
Platform evidence (issues, PR, checks) belongs to \`specgit finish\`.

## Usage

\`\`\`bash
specgit status --json
\`\`\`

## Steps

1. Run from the repository root.
2. Read \`state\` and \`record\` from the envelope: use them to see what is
   bound and what drifted before touching anything.
3. No record → bootstrap with \`specgit issue\`. On \`exit 3\` read
   \`errors[].fix\`.

## Rules

- Never hand-edit \`.specgit.yaml\`; repairs go through the commands.
- \`--json\` is the only parse surface.
`;

const OPENCODE_COMMANDS: Record<string, string> = {
  'specgit-issue.md': ISSUE_COMMAND,
  'specgit-finish.md': FINISH_COMMAND,
  'specgit-doctor.md': DOCTOR_COMMAND,
  'specgit-pr.md': PR_COMMAND,
  'specgit-status.md': STATUS_COMMAND,
};

const GENERIC_SKILLS: Record<string, string> = {
  ['specgit-issue/SKILL.md']: ISSUE_SKILL,
  ['specgit-finish/SKILL.md']: FINISH_SKILL,
  ['specgit-doctor/SKILL.md']: DOCTOR_SKILL,
  ['specgit-pr/SKILL.md']: PR_SKILL,
  ['specgit-status/SKILL.md']: STATUS_SKILL,
};

export interface SetupWriteResult {
  tool: SetupTool;
  installed: string[];
}

async function dirExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function detectSetupTool(root: string): Promise<'opencode' | 'generic'> {
  return (await dirExists(path.join(root, '.opencode'))) ? 'opencode' : 'generic';
}

export async function writeAgentSurface(root: string, tool: SetupTool): Promise<SetupWriteResult> {
  const installed: string[] = [];

  const wantsOencode = tool === 'opencode' || tool === 'all';
  const wantsGeneric = tool === 'generic' || tool === 'all';

  if (wantsOencode) {
    for (const [rel, content] of Object.entries(OPENCODE_COMMANDS)) {
      const target = path.join(root, '.opencode', 'command', rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      installed.push(`.opencode/command/${rel}`);
    }
  }

  if (wantsGeneric) {
    for (const [rel, content] of Object.entries(GENERIC_SKILLS)) {
      const target = path.join(root, '.agents', 'skills', rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      installed.push(`.agents/skills/${rel}`);
    }
  }

  return { tool, installed };
}
