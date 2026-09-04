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
 *
 * Since #307 re-running setup is the version-upgrade refresh for the agent
 * surfaces: the selected surface converges inside ONE managed-asset
 * reconciliation transaction — current entry points are created/refreshed,
 * retired SpecGit-owned entries (ownership proven from their bytes) are
 * removed with only-empty directory pruning, and any failure restores the
 * exact pre-run tree.
 */

import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';

import { DELIVERY_TYPES } from '../tags/catalog.js';
import { reconcileLocalAssetIgnore } from './commands/init-ignore.js';
import {
  reconcileManagedAssets,
  type ManagedReconcileReport,
  type ManagedStep,
} from './managed-reconcile.js';

export type SetupTool = 'opencode' | 'generic' | 'all';

const ISSUE_TYPE_LIST = DELIVERY_TYPES.join(', ');

const LOCAL_MAINTENANCE_GUIDANCE = `Local CLI installation, upgrades, and \`init\` / \`setup\` refreshes need no
issue, PR, product build, or release when no product or shared-rule change is
intended for commit. Review tracked diffs before choosing what to share.
For intended deliveries, follow the host project's verification policy for
the actual changed inputs; documentation may itself be a product input.
Ignore rules are never CI exemptions. Publishing requires explicit authorization.`;

const MERGE_GUIDANCE = `Continue within existing user authorization. With automation enabled, the
trusted remote completion workflow continues after CI without another user
confirmation. \`specgit pr --merge --json\` is its recovery path. It requires
the approved target policy, \`finish\` exit 0, and all CI checks passing at the
current PR head. Completion means the merge and every bound issue closure are
confirmed; a partial closure remains recoverable. \`finish\` is read-only and
exit 0 means accepted, not necessarily completed. A failed delivery is tracked
by a repair issue; retries reuse that cause and preserve the original PR.
Automation defaults to no. Only the user's own yes enables it through
\`specgit init --automation yes --merge-target <branch>\`; ordinary \`init --force\`
preserves that choice and target. An agent must not choose yes for the user. When an
action lacks user authorization or platform permission, report the specific
missing permission with the prepared result.`;

const ISSUE_COMMAND = `---
description: Start a SpecGit delivery from a title or existing issue number
---

# /specgit-issue

Thin trigger for the delivery bootstrap. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

${LOCAL_MAINTENANCE_GUIDANCE}

## Steps

1. Collect the argument: \`$ARGUMENTS\` is either an issue title (create) or a
   pure number (reuse). Multiple arguments = N issues in one delivery.
   If policy selects body validation or required sections, prepare complete
   content first and include \`--body-file <path>\` per title and
   \`--pr-body-file <path>\` for the request.
2. Run from the repo root — keep \`$ARGUMENTS\` UNQUOTED so each quoted title
   arrives as its own argument:

   \`\`\`bash
   specgit issue $ARGUMENTS --json
   \`\`\`

3. On success report the issue URL(s), draft PR URL and branch name.
   Verify the issue bodies contain the discussed Why / Scope / Approach /
   Acceptance, fill only missing content, preserve remote edits, then
   implement. Fill in the draft PR's scaffold (Why / What changed /
   Evidence / Checklist) as you deliver when no body rules were selected.
   Enabled content rules must pass; preserve every closing reference and
   existing remote body on resume.
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

1. Complete the authorized PR body and mark the PR ready for review, then
   run from the delivery branch:

   \`\`\`bash
   specgit finish --json
   \`\`\`

2. Branch on the exit code:
   - \`exit 0\` → report issues, PR, CI run links, and the verdict; continue
     the authorized merge through the guidance below.
   - \`exit 1\` → read \`errors[].fix\` / gate failures, fix exactly what they
     name, re-run. Loop until exit 0.
   - \`exit 3\` → run \`specgit doctor --json\`, repair the named evidence
     failure within your permissions, and retry the verdict.
3. Iron rules: never weaken \`spec_git/policy.yaml\` to pass; \`--json\` is the
   only parse surface; a non-zero verdict never merges.

${MERGE_GUIDANCE}
`;

const ISSUE_SKILL = `---
name: specgit-issue
description: Start a SpecGit delivery — create or reuse GitHub issues, branch, draft PR that closes them, and record the binding, in one command.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
license: MIT
metadata:
  author: specgit
---

# specgit-issue

The delivery bootstrap. One command binds the whole aggregate: N issues, one
branch, one draft pull request, one record (\`.specgit.yaml\`).

${LOCAL_MAINTENANCE_GUIDANCE}

## Usage

\`\`\`bash
specgit issue "<title>"                 # create one issue and start
specgit issue "<title A>" "<title B>"   # N issues, one delivery
specgit issue 42                        # reuse an existing issue
specgit issue "<no-slug title>" --delivery my-name   # explicit delivery name
specgit issue "<title>" --tags kind::fix,module::auth  # explicit tag selection
\`\`\`

New titles must start with \`<type>: \`; allowed types: ${ISSUE_TYPE_LIST}.

## Tagging (choose before you bootstrap)

- Follow the policy's \`language\` for issue/PR prose. Enabled
  \`validation\` rules check live titles and labels. In \`kind\` mode,
  select exactly one catalog kind plus only declared extras; in \`project\`
  mode, select only from policy \`tags\`.
- Every bootstrap applies the title's \`kind::<type>\` member by default;
  pass \`--tags <a,b>\` to choose the full set yourself instead.
- Selection is pool-first: existing on-spec labels win verbatim; anything
  missing is seeded from the built-in kind:: catalog or the policy's
  \`tags:\` declarations — unknown vocabulary exits 2 naming what exists.
- Pick at most one label per axis (\`kind::\`, \`module::\`, ...).
  Omit uncertain optional labels; the selected policy determines which
  labels are required. An existing pool label cannot override that policy.

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
- The trigger is the decision to deliver an intended tracked change:
  when you begin implementing that delivery, run this command FIRST, before tracked
  implementation edits. Preparing temporary body files belongs to bootstrap.
  Working without a binding is a contract violation, not a style
  choice.
- After bootstrap, verify each issue contains the discussed Why / Scope /
  Approach / Acceptance. Fill missing content with \`gh issue edit <n>\` or
  \`glab issue update <n>\`, preserve complete remote bodies, then implement.
- With selected body rules, prepare complete content before creation using
  \`--body-file\` and \`--pr-body-file\`. Otherwise fill the built-in scaffold
  during delivery. Enabled content rules must pass; keep closing references
  and existing remote edits intact.
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
description: Run the SpecGit evidence verdict — fail-closed acceptance derived from real git, PR, and CI evidence; exit 0 means accepted; completion requires confirmed merge and issue closure.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
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

- \`0\` accepted — report the verdict and continue the authorized merge
  through the guidance below.
- \`1\` rejected — each failure carries a \`fix\`; fix what the gates name,
  re-run until 0.
- \`3\` unknown — run \`specgit doctor --json\`, fix the named evidence
  failure within your permissions, then retry.

## Rules

- Policy defines the requirements; real git, PR, issue, and CI evidence
  decides the verdict. Task lists and specification prose are not acceptance evidence.
- Never weaken \`spec_git/policy.yaml\` to make a verdict pass.
- \`--json\` is the only parse surface.

${MERGE_GUIDANCE}
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
description: Repair the SpecGit PR binding or complete a configured automatic merge
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

${MERGE_GUIDANCE}
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
3. No record is not an error: \`state: "unbound"\` with exit \`0\` is the
   normal pre-binding state — bootstrap with \`specgit issue\` (the
   \`record_missing\` warning carries the next step in \`warnings[].fix\`).
   Exit \`3\` is different: \`state: "unknown"\`, a genuine evidence
   failure — read \`errors[].fix\`.
4. Never hand-edit \`.specgit.yaml\`.
`;

const DOCTOR_SKILL = `---
name: specgit-doctor
description: Resolve a SpecGit exit 3 — run the doctor probes, apply each fix, re-run until the verdict can run again.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
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
description: Repair the SpecGit PR binding or complete a configured automatic merge.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
license: MIT
metadata:
  author: specgit
---

# specgit-pr

Repairs the record's PR binding. With \`--merge\`, completes the configured
merge and issue closure after fresh evidence passes.

## Usage

\`\`\`bash
specgit pr              # auto-discover the PR for this head branch
specgit pr 123          # bind an explicit number (no platform round-trip)
specgit pr --merge --json  # merge the bound PR when automation is enabled
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

${MERGE_GUIDANCE}
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
3. No record is not an error: \`state: "unbound"\` with exit \`0\` is the
   normal pre-binding state (#175) — bootstrap with \`specgit issue\`; the
   \`record_missing\` warning names that next step in \`warnings[].fix\`.
   Exit \`3\` is different: a genuine evidence failure (\`state: "unknown"\`)
   happened; read \`errors[].fix\`.

## Rules

- Never hand-edit \`.specgit.yaml\`; repairs go through the commands.
- \`--json\` is the only parse surface.
`;

/**
 * Ownership marker (#307): every generated entry point carries this HTML
 * comment — inert for every markdown consumer — directly after its YAML
 * frontmatter. A later version that retires an entry point proves SpecGit
 * ownership of the retired bytes from this marker; for the released
 * pre-marker generic skills, an `author: specgit` value in the file's YAML
 * frontmatter is equivalent evidence. A file with neither is user
 * content — preserved verbatim, never deleted.
 */
export const ENTRY_POINT_MARKER = '<!-- specgit-managed-entry-point -->';

/**
 * A released skill's authorship declaration: a YAML mapping line whose
 * value is exactly `specgit` (optionally quoted) — the released
 * `metadata: author: specgit` shape, never mere body prose.
 */
const FRONTMATTER_AUTHOR_LINE = /^\s*author:\s*["']?specgit["']?\s*$/;

/**
 * The YAML frontmatter's interior lines, empty when the file has none:
 * the leading `---` fence up to the closing fence, found the same way
 * `withEntryPointMarker` locates the block it stamps.
 */
function frontmatterLines(content: string): string[] {
  if (!content.startsWith('---\n')) {
    return [];
  }
  const close = content.indexOf('\n---\n', 3);
  return close === -1 ? [] : content.slice(4, close).split('\n');
}

/**
 * Structural ownership proof for a SpecGit entry point (#307): the managed
 * marker at its writer's anchor, or `author: specgit` as a frontmatter
 * metadata value. Body text quoting the marker or the authorship string
 * proves nothing — user prose may discuss either line itself.
 */
export function isSpecGitOwnedEntryPoint(content: string): boolean {
  if (hasAnchoredEntryPointMarker(content)) {
    return true;
  }
  return frontmatterLines(content).some((line) => FRONTMATTER_AUTHOR_LINE.test(line));
}

/**
 * The marker exactly where its writer puts it, mirroring
 * `withEntryPointMarker`: bytes without a closing frontmatter fence carry
 * it as the leading line; frontmatter carries it directly after the close
 * fence. Anywhere else — quoted in body prose — it is not ownership
 * evidence.
 */
function hasAnchoredEntryPointMarker(content: string): boolean {
  const close = content.indexOf('\n---\n', 3);
  if (close === -1) {
    return content.startsWith(`${ENTRY_POINT_MARKER}\n`);
  }
  return content.startsWith(`\n${ENTRY_POINT_MARKER}\n`, close + '\n---\n'.length);
}

/**
 * Stamp a template with the ownership marker directly after the frontmatter
 * (a leading comment would break frontmatter parsers); templates without
 * frontmatter get it as the leading line.
 */
function withEntryPointMarker(template: string): string {
  const close = template.indexOf('\n---\n', 3);
  if (close === -1) {
    return `${ENTRY_POINT_MARKER}\n\n${template}`;
  }
  const insertAt = close + '\n---\n'.length;
  return `${template.slice(0, insertAt)}\n${ENTRY_POINT_MARKER}\n${template.slice(insertAt)}`;
}

const OPENCODE_COMMANDS: Record<string, string> = {
  'specgit-issue.md': withEntryPointMarker(ISSUE_COMMAND),
  'specgit-finish.md': withEntryPointMarker(FINISH_COMMAND),
  'specgit-doctor.md': withEntryPointMarker(DOCTOR_COMMAND),
  'specgit-pr.md': withEntryPointMarker(PR_COMMAND),
  'specgit-status.md': withEntryPointMarker(STATUS_COMMAND),
};

const GENERIC_SKILLS: Record<string, string> = {
  ['specgit-issue/SKILL.md']: withEntryPointMarker(ISSUE_SKILL),
  ['specgit-finish/SKILL.md']: withEntryPointMarker(FINISH_SKILL),
  ['specgit-doctor/SKILL.md']: withEntryPointMarker(DOCTOR_SKILL),
  ['specgit-pr/SKILL.md']: withEntryPointMarker(PR_SKILL),
  ['specgit-status/SKILL.md']: withEntryPointMarker(STATUS_SKILL),
};

const OPENCODE_COMMAND_DIR = '.opencode/command';
const GENERIC_SKILLS_DIR = '.agents/skills';

export interface SetupWriteResult {
  tool: SetupTool;
  installed: string[];
  /** #307: what the reconciliation transaction did (created/updated/removed/preserved). */
  reconciled: ManagedReconcileReport;
}

/** The desired agent-surface state for one setup run (#307). */
export interface AgentSurfaceDesiredState {
  /** Ordered reconciliation steps: current writes, then proven removals. */
  steps: ManagedStep[];
  /** Repo-relative paths of the selected surfaces' current entry points. */
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
  const opencode = path.join(root, '.opencode');
  if (!(await dirExists(opencode))) return 'generic';
  const entries = await fs.readdir(opencode);
  if (entries.length === 0 || entries.some((name) => name !== 'hooks' && name !== 'hooks.json')) {
    return 'opencode';
  }
  const hooks = await readdirEntries(path.join(opencode, 'hooks'));
  if (hooks.some((entry) => entry.name !== 'specgit-merge-guard.sh')) return 'opencode';
  // init creates these guard assets for every adopter. Their presence
  // alone cannot identify the user's agent tool.
  try {
    const config = JSON.parse(await fs.readFile(path.join(opencode, 'hooks.json'), 'utf8')) as Record<string, unknown>;
    if (Object.keys(config).some((key) => key !== 'PreToolUse')) return 'opencode';
    if (!Array.isArray(config.PreToolUse) || config.PreToolUse.some((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || !('hooks' in entry) || !Array.isArray(entry.hooks)) return true;
      return entry.hooks.some((hook: unknown) => typeof hook !== 'object' || hook === null ||
        !('command' in hook) || hook.command !== '.opencode/hooks/specgit-merge-guard.sh');
    })) return 'opencode';
  } catch {
    return 'opencode';
  }
  return 'generic';
}

/** List a directory for removal-candidate discovery; absent means empty. */
async function readdirEntries(target: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return [];
    }
    throw error;
  }
}

/**
 * Build the selected surfaces' desired state (#307): a write step for every
 * current entry point, then — bounded strictly to the selected managed
 * roots — removal steps for retired candidates (`specgit-*.md` commands
 * and `SKILL.md` files in `specgit-*` skill directories; the naming every
 * released version used).
 * Reads only; the ownership decision itself stays with the transaction.
 */
export async function buildAgentSurfaceDesiredState(
  root: string,
  tool: SetupTool
): Promise<AgentSurfaceDesiredState> {
  const wantsOencode = tool === 'opencode' || tool === 'all';
  const wantsGeneric = tool === 'generic' || tool === 'all';

  const steps: ManagedStep[] = [];
  const installed: string[] = [];

  if (wantsOencode) {
    for (const [rel, content] of Object.entries(OPENCODE_COMMANDS)) {
      steps.push({
        kind: 'write',
        path: `${OPENCODE_COMMAND_DIR}/${rel}`,
        mode: 0o644,
        isOwned: isSpecGitOwnedEntryPoint,
        // The current template wholesale: a setup-owned entry point is
        // regenerated, local drift repaired.
        merge: () => content,
      });
      installed.push(`${OPENCODE_COMMAND_DIR}/${rel}`);
    }
    const current = new Set(Object.keys(OPENCODE_COMMANDS));
    const commandDir = path.join(root, ...OPENCODE_COMMAND_DIR.split('/'));
    for (const entry of await readdirEntries(commandDir)) {
      if (!entry.isFile() || !entry.name.startsWith('specgit-') || !entry.name.endsWith('.md')) {
        continue;
      }
      if (current.has(entry.name)) {
        continue;
      }
      steps.push({
        kind: 'remove',
        path: `${OPENCODE_COMMAND_DIR}/${entry.name}`,
        isOwned: isSpecGitOwnedEntryPoint,
      });
    }
  }

  if (wantsGeneric) {
    for (const [rel, content] of Object.entries(GENERIC_SKILLS)) {
      steps.push({
        kind: 'write',
        path: `${GENERIC_SKILLS_DIR}/${rel}`,
        mode: 0o644,
        isOwned: isSpecGitOwnedEntryPoint,
        merge: () => content,
      });
      installed.push(`${GENERIC_SKILLS_DIR}/${rel}`);
    }
    const current = new Set(Object.keys(GENERIC_SKILLS));
    const skillsDir = path.join(root, ...GENERIC_SKILLS_DIR.split('/'));
    for (const entry of await readdirEntries(skillsDir)) {
      if (!entry.isDirectory() || !entry.name.startsWith('specgit-')) {
        continue;
      }
      if (current.has(`${entry.name}/SKILL.md`)) {
        continue;
      }
      // Only the owned generated file is ever a candidate: a directory
      // holding user files keeps them (removal prunes dirs only when empty).
      steps.push({
        kind: 'remove',
        path: `${GENERIC_SKILLS_DIR}/${entry.name}/SKILL.md`,
        isOwned: isSpecGitOwnedEntryPoint,
      });
    }
  }

  return { steps, installed };
}

/**
 * Converge the selected agent surfaces to this version's entry-point set
 * (#307) inside one reversible managed-asset transaction: current entry
 * points are created/refreshed, retired SpecGit-owned entries are removed
 * (only with proven ownership, with emptied directories pruned), and a
 * failure at any step restores the pre-run tree — bytes, modes, and
 * run-created directories.
 */
export async function writeAgentSurface(root: string, tool: SetupTool): Promise<SetupWriteResult> {
  const desired = await buildAgentSurfaceDesiredState(root, tool);
  const reconciled = await reconcileManagedAssets(root, { steps: [...desired.steps, {
    kind: 'write', path: '.gitignore', mode: 0o644, merge: reconcileLocalAssetIgnore,
  }] });
  return { tool, installed: desired.installed, reconciled };
}
