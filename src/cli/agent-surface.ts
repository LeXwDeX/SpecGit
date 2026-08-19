/**
 * `specgit setup` — installs the agent entry points into the current
 * repository, from templates embedded in the CLI binary. Complements
 * `init` (which lays the harness); setup tailors per-tool triggers:
 *
 * - `opencode`  → `.opencode/command/specgit-{issue,finish}.md`
 * - `generic`   → `.agents/skills/specgit-{issue,finish}/SKILL.md`
 *   (portable SKILL.md frontmatter, discoverable by codex / pi-agent /
 *   cursor and any harness that scans skill directories)
 *
 * With no `--tool` flag the tool is auto-detected: an existing
 * `.opencode/` directory selects opencode, otherwise generic.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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

3. On success report the brief: issue URL(s), PR URL (draft), branch name.
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
\`\`\`

## What it does (idempotent; re-run resumes)

1. Creates (or reuses) the issues — one issue = one independently verifiable
   WHY.
2. Creates and checks out the delivery branch.
3. Opens a draft PR whose body closes every bound issue (\`Closes #n\`).
4. Writes \`.specgit.yaml\` and commits it.
5. Pushes the branch.

## Rules

- Run it from the repository root; context comes from live git.
- If it fails mid-chain, re-run the same command — completed steps are
  detected and resumed; never hand-edit \`.specgit.yaml\`.
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

The acceptance verdict. Ten gates evaluate live evidence: record, policy,
context, origin, provider, issues, PR, closing refs, and required checks at
the PR head.

## Usage

\`\`\`bash
specgit finish --json
\`\`\`

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

const OPENCODE_COMMANDS: Record<string, string> = {
  'specgit-issue.md': ISSUE_COMMAND,
  'specgit-finish.md': FINISH_COMMAND,
};

const GENERIC_SKILLS: Record<string, string> = {
  ['specgit-issue/SKILL.md']: ISSUE_SKILL,
  ['specgit-finish/SKILL.md']: FINISH_SKILL,
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
