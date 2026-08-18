/**
 * Generated harness assets for `specgit init`.
 *
 * Two artifacts, both deterministic so that re-init rewrites byte-identical
 * files:
 *
 * - `.github/workflows/specgit-accept.yml` — the CI acceptance gate that
 *   runs `specgit finish --json` on every pull request targeting the
 *   default branch.
 * - the managed prompt block — injected into AGENTS.md (created when
 *   missing) and CLAUDE.md (only when the file already exists), delimited
 *   by exact markers; re-init replaces only the region between them.
 *
 * Paths surfaced in output are repo-relative with forward slashes; file
 * contents use LF line endings only.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const HARNESS_WORKFLOW_SEGMENTS = ['.github', 'workflows', 'specgit-accept.yml'];

export const HARNESS_WORKFLOW_PATH = HARNESS_WORKFLOW_SEGMENTS.join('/');
export const AGENTS_FILENAME = 'AGENTS.md';
export const CLAUDE_FILENAME = 'CLAUDE.md';
export const BLOCK_START_MARKER = '<!-- specgit:block:start -->';
export const BLOCK_END_MARKER = '<!-- specgit:block:end -->';

export function harnessWorkflowYaml(): string {
  return `name: SpecGit Acceptance

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  specgit-acceptance:
    name: SpecGit Acceptance
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout code
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # Check out the PR head branch by name so HEAD is on the branch
          # (not the detached merge ref): the execution context gate reads
          # live git. Falls back to the default ref on non-PR events.
          ref: \${{ github.head_ref || github.ref }}
          fetch-depth: 0
          persist-credentials: false

      - name: Setup pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6

      - name: Setup Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '20.19.0'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build CLI
        run: pnpm run build

      - name: Wait for sibling checks
        # The verdict must see the OTHER required checks in a terminal
        # state. Sibling jobs start in parallel AND may not have registered
        # their check-runs yet, so an empty poll is not "done": wait until
        # every name in spec_git/policy.yaml is present with a terminal
        # conclusion. This job is not in the policy, so no self-deadlock.
        env:
          GH_TOKEN: \${{ github.token }}
          WAIT_REPO: \${{ github.repository }}
          WAIT_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          node --input-type=module <<'EOF'
          import { readFileSync } from 'node:fs';
          import { parse } from 'yaml';
          const policy = parse(readFileSync('spec_git/policy.yaml', 'utf8'));
          const required = policy.required_checks ?? [];
          const headers = {
            authorization: 'Bearer ' + process.env.GH_TOKEN,
            accept: 'application/vnd.github+json',
          };
          const url = 'https://api.github.com/repos/' + process.env.WAIT_REPO
            + '/commits/' + process.env.WAIT_SHA + '/check-runs?per_page=100';
          const terminal = new Set(['completed']);
          const terminalHas = (byName, name) => {
            if (byName.has(name)) return terminal.has(byName.get(name));
            const retried = [...byName.keys()].find((k) => k.startsWith(name + ' ('));
            return retried !== undefined && terminal.has(byName.get(retried));
          };
          const deadline = Date.now() + 15 * 60 * 1000;
          while (Date.now() < deadline) {
            const res = await fetch(url, { headers });
            if (!res.ok) throw new Error('check-runs API ' + res.status);
            const payload = await res.json();
            const byName = new Map(payload.check_runs.map((r) => [r.name, r.status]));
            const missing = required.filter((n) => !terminalHas(byName, n));
            if (missing.length === 0) {
              console.log('All required checks are in a terminal state.');
              process.exit(0);
            }
            console.log('Waiting for: ' + missing.join(', '));
            await new Promise((r) => setTimeout(r, 10000));
          }
          console.error('Timed out waiting for sibling checks.');
          process.exit(1);
          EOF

      - name: specgit finish
        run: node bin/specgit.js finish --json
        env:
          GH_TOKEN: \${{ github.token }}
`;
}

export function managedPromptBlock(): string {
  return `${BLOCK_START_MARKER}
## SpecGit delivery harness

Managed by \`specgit init\`. Everything between the markers is rewritten on
re-init; keep manual guidance outside them.

### The delivery story

- Start with \`specgit issue <title-or-number>...\`: it creates or reuses
  the issues, branches, opens the draft pull request that closes every
  bound issue, and writes \`.specgit.yaml\`. Re-running resumes; it is
  idempotent.
- Finish with \`specgit finish\`: the verdict, derived from real git, PR,
  and CI evidence. Exit code 0 is the only "done".

### Repair and diagnostics

- \`specgit pr\` repairs the pull-request binding: with no arguments it
  auto-discovers the pull request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- \`specgit status\` shows local evidence only: record, state, drift,
  origin. \`specgit doctor\` probes git, repository, origin, gh, and
  policy.

### Issue granularity

One issue = one independently verifiable WHY. If a deliverable cannot be
verified on its own evidence, split it before binding.

### Iron rules

- \`specgit finish\` exit code other than 0: never request merge. Fix the
  delivery, not the gate.
- Never weaken \`spec_git/policy.yaml\` to make a verdict pass.
- \`--json\` is the only parse surface: stdout is exactly one JSON
  document; never scrape human-readable output.
${BLOCK_END_MARKER}`;
}

/**
 * Pure transform: place `block` (which carries the markers) into existing
 * file content. When both markers are present, only the delimited region is
 * replaced; otherwise the block is appended after a blank line. Byte-stable
 * for repeated injection of the same block.
 */
export function injectManagedBlock(existing: string, block: string): string {
  const startIndex = existing.indexOf(BLOCK_START_MARKER);
  const endIndex = existing.indexOf(BLOCK_END_MARKER);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const afterEnd = endIndex + BLOCK_END_MARKER.length;
    return existing.slice(0, startIndex) + block + existing.slice(afterEnd);
  }
  if (existing.length === 0) {
    return `${block}\n`;
  }
  const separator = existing.endsWith('\n') ? '' : '\n';
  return `${existing}${separator}\n${block}\n`;
}

export interface HarnessWriteResult {
  workflow: string;
  prompts: string[];
  hooks: string[];
  gitHook: string | null;
}

const GUARD_HOOK_JSON = `{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": ".opencode/hooks/specgit-merge-guard.sh",
          "timeout": 10
        }
      ]
    }
  ]
}
`;

// Blocks merge/push-main attempts that bypass the evidence verdict. Matches
// only the command's leading verb pattern so prose containing the keywords
// (e.g. an issue body) never trips the guard.
const GUARD_SCRIPT = `#!/bin/sh
# SpecGit merge guard (managed by specgit init). Exit 2 = block with reason.
command=\$(printf '%s' "\$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.command)||'')}catch{process.stdout.write('')}})")

case "\$command" in
  gh\\ pr\\ merge*|git\\ push\\ origin\\ main*|git\\ push\\ origin\\ +main*|git\\ push\\ origin\\ HEAD:main*)
    echo "specgit: merge/push-main attempted without a recorded verdict. Run 'specgit finish' first - exit 0 is the only path to merge; fix what the failures name; never weaken spec_git/policy.yaml to pass." >&2
    exit 2
    ;;
esac
exit 0
`;

// Local git-layer guard: refuses direct pushes to main; deliveries must go
// through PR + CI + specgit finish.
const GIT_PRE_PUSH = `#!/bin/sh
# SpecGit pre-push guard (managed by specgit init).
while read -r local_ref local_sha remote_ref remote_sha; do
  case "\$remote_ref" in
    refs/heads/main)
      echo "specgit: direct push to main is not the delivery path." >&2
      echo "Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge." >&2
      exit 1
      ;;
  esac
done
exit 0
`;

const HOOKS_SEGMENTS = ['.opencode', 'hooks'];
const GUARD_HOOK_PATH = [...HOOKS_SEGMENTS, 'specgit-merge-guard.sh'].join('/');

async function readIfExists(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

export async function writeHarnessAssets(root: string): Promise<HarnessWriteResult> {
  const workflowTarget = path.join(root, ...HARNESS_WORKFLOW_SEGMENTS);
  await fs.mkdir(path.dirname(workflowTarget), { recursive: true });
  await fs.writeFile(workflowTarget, harnessWorkflowYaml(), 'utf-8');

  const block = managedPromptBlock();
  const prompts: string[] = [];
  for (const filename of [AGENTS_FILENAME, CLAUDE_FILENAME]) {
    const target = path.join(root, filename);
    const existing = await readIfExists(target);
    if (existing === null && filename === CLAUDE_FILENAME) {
      continue;
    }
    await fs.writeFile(target, injectManagedBlock(existing ?? '', block), 'utf-8');
    prompts.push(filename);
  }

  const hooksJsonTarget = path.join(root, '.opencode', 'hooks.json');
  await fs.mkdir(path.dirname(hooksJsonTarget), { recursive: true });
  await fs.writeFile(hooksJsonTarget, GUARD_HOOK_JSON, 'utf-8');

  const guardTarget = path.join(root, ...HOOKS_SEGMENTS, 'specgit-merge-guard.sh');
  await fs.mkdir(path.dirname(guardTarget), { recursive: true });
  await fs.writeFile(guardTarget, GUARD_SCRIPT, 'utf-8');
  await fs.chmod(guardTarget, 0o755);

  const hooks = ['.opencode/hooks.json', GUARD_HOOK_PATH];

  let gitHook: string | null = null;
  const gitHookTarget = path.join(root, '.git', 'hooks', 'pre-push');
  const gitDir = path.join(root, '.git');
  const gitStat = await fs.stat(gitDir).catch(() => null);
  if (gitStat?.isDirectory() ?? false) {
    await fs.mkdir(path.dirname(gitHookTarget), { recursive: true });
    await fs.writeFile(gitHookTarget, GIT_PRE_PUSH, 'utf-8');
    await fs.chmod(gitHookTarget, 0o755);
    gitHook = '.git/hooks/pre-push';
  }

  return { workflow: HARNESS_WORKFLOW_PATH, prompts, hooks, gitHook };
}
