/**
 * #305 — version-upgrade refresh: `specgit init --force` must converge an
 * adopting repository to the running version's complete desired init-owned
 * asset state. These are behavior-level regressions seeded with OLD-version
 * fixtures (an incomplete managed `.gitignore` region, a stale SpecGit-owned
 * GitHub workflow, a platform switch to declared GitLab) plus the failure
 * atomicity of the whole local mutation phase. They were written RED against
 * the pre-#305 writer: the ignore marker short-circuit, the missing
 * obsolete-asset removal, and the per-phase failure scopes each left a
 * documented gap this suite pins shut.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN } from '../../src/cli/exit-codes.js';
import {
  BLOCK_END_MARKER,
  BLOCK_START_MARKER,
  managedPromptBlock,
} from '../../src/cli/harness-content.js';
import { HARNESS_WORKFLOW_PATH } from '../../src/cli/harness-placement.js';
import { externalAcceptanceWorkflowYaml } from '../../src/cli/external-harness.js';
import {
  LOCAL_ASSET_IGNORE_MARKER,
  LOCAL_ASSET_IGNORE_START,
  managedIgnoreBlock,
} from '../../src/cli/commands/init-ignore.js';
import { makeCtx, makeGitFacts, parseStdoutJson, samplePolicy } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const WORKFLOW_ABS = (root: string) => path.join(root, ...HARNESS_WORKFLOW_PATH.split('/'));
const AGENTS_ABS = (root: string) => path.join(root, 'AGENTS.md');
const GITIGNORE_ABS = (root: string) => path.join(root, '.gitignore');
const PROVIDERS_ABS = (root: string) => path.join(root, 'spec_git', 'providers.yaml');

/** The exact workflow bytes this test CLI version desires for an adopting repo on `main`. */
const CURRENT_EXTERNAL_WORKFLOW = externalAcceptanceWorkflowYaml({
  defaultBranch: 'main',
  version: '0.0.0-test',
});

/**
 * An older SpecGit-generated acceptance workflow: unmistakably SpecGit's
 * (the acceptance name, the finish invocation), byte-different from the
 * current template — the shape an upgrade must repair or, on the wrong
 * platform, remove.
 */
const OLD_OWNED_WORKFLOW = `name: SpecGit Acceptance

on: [pull_request]
jobs:
  specgit-acceptance:
    runs-on: ubuntu-latest
    steps:
      - run: specgit finish --json
`;

/**
 * The exact pre-#309 English managed guidance block: the current
 * generation minus the issue-first rule in "Agent contract essentials".
 * Not a `STALE GUIDANCE` placeholder — a real old-version install reads
 * almost like the current one, and the replacement must still find and
 * rebuild precisely the delimited region.
 */
const OLD_GUIDANCE_BLOCK = `${BLOCK_START_MARKER}
## SpecGit delivery harness

Managed by \`specgit init\`. Everything between the markers is regenerated
whenever init writes the harness (a fresh init, or \`--force\` when a policy
already exists); keep manual guidance outside them.

### The delivery story

- Start with \`specgit issue <title-or-number>...\`: it creates or reuses
  the issues, branches, opens the draft pull request pre-filled with a
  deterministic scaffold (the \`Closes #n\` line for every bound issue,
  then Why / What changed / Evidence / Checklist sections), and writes
  \`.specgit.yaml\`. Re-running resumes; it is idempotent.
- Fill in the scaffold sections as you deliver. Its placeholders are
  advisory — the closing references are the only body gate. The PR body
  is written once at creation; no SpecGit command edits an existing PR
  body, and the repository's own pull-request template is never read.
- A draft pull request always fails the verdict (\`pr_draft\`): before
  \`specgit finish\`, mark it ready for review — \`gh pr ready <number>\`
  on GitHub, \`glab mr update <number> --ready\` on GitLab.
- Finish with \`specgit finish\`: the verdict, derived from real git, PR,
  and CI evidence. Exit code 0 is the only "done".

### Repair and diagnostics

- \`specgit pr\` repairs the pull-request binding: with no arguments it
  auto-discovers the pull request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- \`specgit status\` shows local evidence only: record, state, drift,
  origin. \`specgit doctor\` probes git, repository, origin, gh, and
  policy.

### The command surface

- Ten commands: \`specgit init\`, \`specgit setup\`, \`specgit issue\`,
  \`specgit pr\`, \`specgit finish\`, \`specgit bind\`, \`specgit unbind\`,
  \`specgit status\`, \`specgit accept\`, \`specgit doctor\`.
- \`specgit setup\` installs the agent entry points (commands for opencode,
  portable skills for other tools); \`specgit bind\`, \`specgit unbind\`,
  and \`specgit accept\` are automation aliases for scripts and CI.

### Before creating an issue, check for duplicates

- Before running \`specgit issue\` with a new title, search the tracker for
  similar open work: \`gh issue list\` with keywords from the title
  (state, labels, and search terms via \`gh search issues\`).
- Open and read every plausible candidate (\`gh issue view <n>\`) — compare
  the WHY, not just the wording.
- If a candidate covers the same WHY, continue that issue instead of
  creating a new one; if it is close but different, say how they differ.
- When unsure, ask the requester to decide between continuing the existing
  issue and creating a duplicate. The team ships one line of work per WHY,
  never two.

### Issue granularity

One issue = one independently verifiable WHY. If a deliverable cannot be
verified on its own evidence, split it before binding.

### Iron rules

- \`specgit finish\` exit code other than 0: never request merge. Fix the
  delivery, not the gate.
- Never weaken \`spec_git/policy.yaml\` to make a verdict pass.
- \`--json\` is the only parse surface: stdout is exactly one JSON
  document; never scrape human-readable output.

### Agent contract essentials

- The one rule: a delivery is done if and only if \`specgit finish\`
  exits \`0\`. Never declare completion from task lists, file states, or
  test runs you performed yourself.
- Branch on exit codes, not phrasing: \`1\` = evidence complete, fix what
  the gates named; \`3\` = evidence missing, fix the environment first
  (\`specgit doctor\`). Never present exit \`3\` as success.
- Keep the \`Closes #n\` references in the PR body intact; after changing
  the PR body, head branch, or CI, re-run \`specgit finish\`. Never
  bypass or reconfig a required check to make acceptance pass.
- Forge evidence flows through the user's authenticated CLI session only
  (\`gh\` / \`glab\`): never read, log, or pass around tokens.
${BLOCK_END_MARKER}`;

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Full-file snapshot: bytes AND mode, so failure round-trips are exact. */
function treeState(root: string): Map<string, { content: string; mode: number }> {
  const state = new Map<string, { content: string; mode: number }>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        state.set(path.relative(root, full), {
          content: fs.readFileSync(full, 'utf-8'),
          mode: fs.statSync(full).mode,
        });
      }
    }
  };
  walk(root);
  return state;
}

describe('specgit init --force: version-upgrade convergence (#305)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-upgrade-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('reconciles an old managed .gitignore region to the current entry set, preserving unrelated rules', async () => {
    // An old-version install: the managed marker exists, but the region
    // carries only the first-generation entry — the pre-#305 writer
    // short-circuits on the marker and never adds the missing entry.
    fs.writeFileSync(
      GITIGNORE_ABS(root),
      `node_modules/\n# my comment\n${LOCAL_ASSET_IGNORE_MARKER}\n/.specgit.yaml\n`
    );

    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);

    const gitignore = read(GITIGNORE_ABS(root));
    // User-owned rules and formatting outside the managed region survive…
    expect(gitignore.startsWith('node_modules/\n# my comment\n')).toBe(true);
    // …and the managed region now carries the complete current entry set.
    expect(occurrences(gitignore, '/.specgit.yaml')).toBe(1);
    expect(occurrences(gitignore, '/spec_git/')).toBe(1);
    // The region stays recognizable as managed, in its delimited form.
    expect(gitignore).toContain(`specgit: local delivery assets (managed by specgit init)`);
  });

  it('a legacy marker migration preserves adjacent user rules and their order', async () => {
    // The pre-#305 shape: the single marker directly above its entries —
    // and, with no blank separator, a user rule glued to the run's end.
    // The migration must consume ONLY the marker and the entry lines
    // SpecGit knows it wrote; the user rule keeps its bytes and position.
    fs.writeFileSync(
      GITIGNORE_ABS(root),
      `node_modules/\n${LOCAL_ASSET_IGNORE_MARKER}\n/.specgit.yaml\n/spec_git/\n/my-user-rule/\n`
    );

    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(read(GITIGNORE_ABS(root))).toBe(`node_modules/\n${managedIgnoreBlock()}\n/my-user-rule/\n`);
  });

  it('a damaged delimited region migrates without consuming user lines', async () => {
    // Start marker present, end marker lost (truncated write, hand edit):
    // the repair consumes the start marker plus the known SpecGit entry
    // lines only; an unknown line ends the consumed run and stays put.
    fs.writeFileSync(
      GITIGNORE_ABS(root),
      `# header\n${LOCAL_ASSET_IGNORE_START}\n/.specgit.yaml\n/spec_git/\nuser-artifacts/\n`
    );

    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(read(GITIGNORE_ABS(root))).toBe(`# header\n${managedIgnoreBlock()}\nuser-artifacts/\n`);
  });

  it('converges an old-version GitHub fixture to the exact current asset set', async () => {
    fs.mkdirSync(path.dirname(WORKFLOW_ABS(root)), { recursive: true });
    fs.writeFileSync(WORKFLOW_ABS(root), OLD_OWNED_WORKFLOW);
    fs.writeFileSync(
      AGENTS_ABS(root),
      `# Project notes\n${BLOCK_START_MARKER}\nSTALE GUIDANCE\n${BLOCK_END_MARKER}\nTail.\n`
    );

    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);

    expect(read(WORKFLOW_ABS(root))).toBe(CURRENT_EXTERNAL_WORKFLOW);
    expect(read(AGENTS_ABS(root))).toBe(
      `# Project notes\n${managedPromptBlock()}\nTail.\n`
    );
    const envelope = parseStdoutJson(t.io);
    expect(envelope.reconciled?.created ?? []).toEqual(expect.arrayContaining(['.gitignore']));
    expect(envelope.reconciled?.updated ?? []).toEqual(
      expect.arrayContaining([HARNESS_WORKFLOW_PATH, 'AGENTS.md'])
    );
    expect(envelope.reconciled?.removed ?? []).toEqual([]);
  });

  it('upgrades a pre-#309 generated guidance block to the issue-first contract, preserving the user framing (#309)', async () => {
    // A real adopting repository after a CLI upgrade: the AGENTS.md block
    // is the old generation (no issue-first rule), framed by user prose
    // that init must never touch. The zh block travels the same code
    // path (one injectManagedBlock for both languages); its bytes are
    // pinned by the harness-content snapshots and the #309 language
    // assertions.
    const framed = `# Project notes\n\n${OLD_GUIDANCE_BLOCK}\n\nTail: local conventions.\n`;
    // Guard the fixture itself: it must be a genuine old generation
    // (never silently rot into the current block) framed by the markers.
    expect(OLD_GUIDANCE_BLOCK).not.toBe(managedPromptBlock());
    expect(OLD_GUIDANCE_BLOCK.startsWith(BLOCK_START_MARKER)).toBe(true);
    expect(OLD_GUIDANCE_BLOCK.endsWith(BLOCK_END_MARKER)).toBe(true);
    fs.writeFileSync(AGENTS_ABS(root), framed);

    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);

    // The whole file round-trips as: identical user bytes before and
    // after the markers, current guidance between them.
    const upgraded = read(AGENTS_ABS(root));
    expect(upgraded).toBe(`# Project notes\n\n${managedPromptBlock()}\n\nTail: local conventions.\n`);
    // The rebuilt block carries the issue-first contract…
    expect(upgraded).toContain('specgit issue <type>: <title>');
    expect(upgraded).toContain('as issues, never in private task');
    // …and the user framing survives byte-identically on both sides.
    expect(upgraded.startsWith('# Project notes\n\n')).toBe(true);
    expect(upgraded.endsWith('\n\nTail: local conventions.\n')).toBe(true);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.reconciled?.updated ?? []).toContain('AGENTS.md');
  });

  it('a declared-GitLab refresh removes the obsolete SpecGit-owned GitHub workflow', async () => {
    fs.mkdirSync(path.dirname(WORKFLOW_ABS(root)), { recursive: true });
    fs.writeFileSync(WORKFLOW_ABS(root), OLD_OWNED_WORKFLOW);
    // A user-owned sibling workflow must survive the platform switch.
    const userWorkflowPath = path.join(root, '.github', 'workflows', 'ci.yml');
    fs.writeFileSync(userWorkflowPath, 'name: CI\non: [pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n');

    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/adopted.git' }),
    });
    const code = await runCliWith(
      [
        'node', 'specgit', 'init',
        '--required-check', 'Test',
        '--force',
        '--gitlab-host', 'git.ycgame.com',
        '--json', '--no-protect',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);

    // The SpecGit-owned wrong-platform workflow is gone…
    expect(fs.existsSync(WORKFLOW_ABS(root))).toBe(false);
    // …the user workflow is untouched…
    expect(read(userWorkflowPath)).toBe('name: CI\non: [pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n');
    // …and platform-neutral assets still land.
    expect(read(AGENTS_ABS(root))).toContain(BLOCK_START_MARKER);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.platform).toEqual({ mode: 'gitlab', gitlabHost: 'git.ycgame.com' });
    expect(envelope.reconciled?.removed ?? []).toEqual([HARNESS_WORKFLOW_PATH]);
  });

  it('invalid providers bytes refuse heuristic classification instead of being overwritten (#308 symmetry)', async () => {
    // The write side must honor what the read side refuses: status calls
    // an unreadable platform declaration `providers_invalid` and makes no
    // platform claim, but init fell through to the origin heuristics —
    // on a gitlab-shaped host it SILENTLY OVERWROTE the broken bytes,
    // destroying the evidence the user needs to repair. Init must warn,
    // leave the bytes untouched, and stay undecided.
    fs.mkdirSync(path.dirname(PROVIDERS_ABS(root)), { recursive: true });
    fs.writeFileSync(PROVIDERS_ABS(root), 'gitlab: [unclosed\n');

    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);

    // Warned, undecided — never classified by heuristic over broken bytes.
    const envelope = parseStdoutJson(t.io);
    expect(envelope.platform).toEqual({ mode: 'undecided' });
    expect(
      (envelope.warnings ?? []).some((w: { code: string }) => w.code === 'platform_providers_invalid')
    ).toBe(true);
    // The invalid bytes survive verbatim: not overwritten, not repaired.
    expect(read(PROVIDERS_ABS(root))).toBe('gitlab: [unclosed\n');
  });

  it('a gitlab-shaped origin does not silently overwrite invalid providers bytes (#308 symmetry)', async () => {
    fs.mkdirSync(path.dirname(PROVIDERS_ABS(root)), { recursive: true });
    fs.writeFileSync(PROVIDERS_ABS(root), 'gitlab: [unclosed\n');

    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/adopted.git' }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.platform).toEqual({ mode: 'undecided' });
    expect(
      (envelope.warnings ?? []).some((w: { code: string }) => w.code === 'platform_providers_invalid')
    ).toBe(true);
    expect(read(PROVIDERS_ABS(root))).toBe('gitlab: [unclosed\n');
  });

  it('preserves and reports a workflow file SpecGit cannot prove it owns', async () => {
    // Ownership preservation was pinned BEFORE the safe-delete behavior
    // shipped: a file at the managed workflow path without SpecGit markers
    // is user content — never guessed at, never deleted.
    fs.mkdirSync(path.dirname(WORKFLOW_ABS(root)), { recursive: true });
    fs.writeFileSync(
      WORKFLOW_ABS(root),
      'name: My own acceptance\non: [pull_request]\njobs:\n  mine:\n    runs-on: ubuntu-latest\n'
    );

    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/adopted.git' }),
    });
    const code = await runCliWith(
      [
        'node', 'specgit', 'init',
        '--required-check', 'Test',
        '--force',
        '--gitlab-host', 'git.ycgame.com',
        '--json', '--no-protect',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    // Preserved byte-identically and surfaced, never silently dropped.
    expect(read(WORKFLOW_ABS(root))).toBe(
      'name: My own acceptance\non: [pull_request]\njobs:\n  mine:\n    runs-on: ubuntu-latest\n'
    );
    const envelope = parseStdoutJson(t.io);
    expect(envelope.reconciled?.removed ?? []).toEqual([]);
    expect(envelope.reconciled?.preserved ?? []).toEqual([HARNESS_WORKFLOW_PATH]);
    expect(
      (envelope.warnings ?? []).some((w: { code: string }) => w.code === 'unowned_asset_preserved')
    ).toBe(true);
  });

  it('a mid-phase failure after earlier init-owned mutations restores the pre-run tree', async () => {
    fs.writeFileSync(AGENTS_ABS(root), '# user notes\n');
    fs.chmodSync(AGENTS_ABS(root), 0o600);
    const before = treeState(root);

    // The policy write fails AFTER the harness writes already landed — the
    // pre-#305 writer left the harness modifications behind (mixed state).
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false, policy: samplePolicy() });
    t.recordPort.writePolicy = vi.fn(async (): Promise<void> => {
      throw new Error('simulated disk failure');
    });

    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors?.[0]?.code).toBe('policy_write_failed');
    // Bytes AND modes round-trip; nothing this run created stays behind.
    expect(treeState(root)).toEqual(before);
    // The directories this run created are removed too, not left empty.
    expect(fs.existsSync(path.join(root, '.github'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.opencode'))).toBe(false);
  });

  it('a failed GitLab refresh also restores the providers declaration it persisted', async () => {
    // persistGitlabHost runs before the harness phase by design (platform
    // resolution re-reads the declaration); a later failure must still
    // round-trip the file — including the user's comments in it.
    fs.mkdirSync(path.dirname(PROVIDERS_ABS(root)), { recursive: true });
    const seededProviders = '# team config\ngitlab:\n  host: git.ycgame.com\n  insecure_ssl: false\n';
    fs.writeFileSync(PROVIDERS_ABS(root), seededProviders);

    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/adopted.git' }),
    });
    t.recordPort.writePolicy = vi.fn(async (): Promise<void> => {
      throw new Error('simulated disk failure');
    });
    const code = await runCliWith(
      [
        'node', 'specgit', 'init',
        '--required-check', 'Test',
        '--force',
        '--gitlab-host', 'git.ycgame.com',
        '--json', '--no-protect',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    expect(read(PROVIDERS_ABS(root))).toBe(seededProviders);
  });

  it('a failed declared-GitLab init restores the complete tree including created directories', async () => {
    // No spec_git/ at all: persistGitlabHost creates it mid-run. A later
    // failure must remove the directory it created too — an empty
    // spec_git/ left behind is not a round-tripped tree.
    const before = treeState(root);
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/adopted.git' }),
    });
    t.recordPort.writePolicy = vi.fn(async (): Promise<void> => {
      throw new Error('simulated disk failure');
    });
    const code = await runCliWith(
      [
        'node', 'specgit', 'init',
        '--required-check', 'Test',
        '--force',
        '--gitlab-host', 'git.ycgame.com',
        '--json', '--no-protect',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors?.[0]?.code).toBe('policy_write_failed');
    expect(treeState(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'spec_git'))).toBe(false);
  });

  it('an unestablishable providers snapshot fails closed as an exit-3 diagnostic', async () => {
    // The pre-run state of spec_git/providers.yaml cannot be read (here:
    // not a file at all). The run must fail through the outcome path with
    // a dedicated diagnostic — never escape as an unstructured crash —
    // and must not mutate anything while at it.
    fs.mkdirSync(PROVIDERS_ABS(root), { recursive: true });
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/adopted.git' }),
    });
    const code = await runCliWith(
      [
        'node', 'specgit', 'init',
        '--required-check', 'Test',
        '--force',
        '--gitlab-host', 'git.ycgame.com',
        '--json', '--no-protect',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors?.[0]?.code).toBe('providers_snapshot_failed');
    // Fail closed before any mutation: the seeded tree is as it started.
    expect(fs.statSync(PROVIDERS_ABS(root)).isDirectory()).toBe(true);
    expect(fs.existsSync(AGENTS_ABS(root))).toBe(false);
  });

  it('an incomplete providers restore is surfaced as an additional error diagnostic', async () => {
    fs.mkdirSync(path.dirname(PROVIDERS_ABS(root)), { recursive: true });
    fs.writeFileSync(
      PROVIDERS_ABS(root),
      '# team config\ngitlab:\n  host: git.ycgame.com\n  insecure_ssl: false\n'
    );
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy(),
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/adopted.git' }),
    });
    // The failing policy write also wrecks the providers file into a
    // non-file: the compensating restore cannot succeed, and the envelope
    // must say so instead of swallowing the compensation failure.
    t.recordPort.writePolicy = vi.fn(async (): Promise<void> => {
      fs.rmSync(PROVIDERS_ABS(root));
      fs.mkdirSync(PROVIDERS_ABS(root));
      throw new Error('simulated disk failure');
    });
    const code = await runCliWith(
      [
        'node', 'specgit', 'init',
        '--required-check', 'Test',
        '--force',
        '--gitlab-host', 'git.ycgame.com',
        '--json', '--no-protect',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect((envelope.errors ?? []).map((error: { code: string }) => error.code)).toEqual([
      'policy_write_failed',
      'providers_restore_failed',
    ]);
  });

  // ---- #310: required-check selection on upgrade — explicit replaces, ----
  // ---- an existing policy upgrades by preservation, only fresh init  ----
  // ---- detects.                                                      ----

  it('a no-argument --force preserves the existing policy checks and order, whatever detection would say (#310)', async () => {
    // The canonical dogfood incident: local workflows would detect a
    // different, partly ambiguous set; the upgrade must keep the working
    // policy's exact checks (and language) and still rebuild the
    // versioned harness assets.
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'ci.yml'),
      'name: CI\non: [pull_request]\njobs:\n' +
        '  test_matrix:\n' +
        '    name: Test (${{ matrix.label }})\n' +
        '    runs-on: ubuntu-latest\n' +
        '  lint:\n' +
        '    name: Lint & Type Check\n' +
        '    runs-on: ubuntu-latest\n'
    );
    fs.writeFileSync(AGENTS_ABS(root), `# Project notes\n${BLOCK_START_MARKER}\nSTALE GUIDANCE\n${BLOCK_END_MARKER}\n`);

    const four = ['Test (linux-bash)', 'Test (macos-bash)', 'Test (windows-pwsh)', 'Lint & Type Check'];
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy({ required_checks: four, language: 'zh' }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--force', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    // Exact checks, exact order, and the policy language — all preserved.
    expect(t.recordPort.policyWrites).toEqual([
      { root, policy: { version: 1, required_checks: four, language: 'zh' } },
    ]);
    // The versioned harness assets are still rebuilt: the stale managed
    // block converges to the current generation (in the policy language).
    expect(read(AGENTS_ABS(root))).toBe(`# Project notes\n${managedPromptBlock('zh')}\n`);
    const envelope = parseStdoutJson(t.io);
    // Selection provenance is visible: preserved, not detected — no
    // detection report is claimed for a run that ran none.
    expect(envelope.detected).toBeUndefined();
    const warning = (envelope.warnings ?? []).find(
      (w: { code: string }) => w.code === 'checks_preserved'
    );
    expect(warning).toBeDefined();
    expect(warning.fix).toContain('--required-check');
  });

  it('explicit repeated --required-check replaces the existing list deterministically (#310)', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy({ required_checks: ['Old', 'Older'] }),
    });
    const code = await runCliWith(
      [
        'node', 'specgit', 'init', '--force', '--json', '--no-protect',
        '--required-check', 'Test (linux-bash)',
        '--required-check', 'Lint & Type Check',
        '--required-check', 'Test (macos-bash)',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    // Given order, exact strings, the old list entirely replaced.
    expect(t.recordPort.policyWrites).toEqual([
      { root, policy: { version: 1, required_checks: ['Test (linux-bash)', 'Lint & Type Check', 'Test (macos-bash)'] } },
    ]);
    const envelope = parseStdoutJson(t.io);
    expect(
      (envelope.warnings ?? []).some((w: { code: string }) => w.code === 'checks_preserved')
    ).toBe(false);
  });

  it('--no-detect with an existing policy still upgrades by preservation (#310)', async () => {
    // --no-detect refuses GUESSING; a preserved policy is not a guess. The
    // strict path keeps demanding explicit names only when there is
    // nothing to preserve.
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy({ required_checks: ['Keep me'] }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--force', '--no-detect', '--json', '--no-protect'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.policyWrites).toEqual([
      { root, policy: { version: 1, required_checks: ['Keep me'] } },
    ]);
  });

  it('a converged rerun is idempotent: byte-identical tree, empty reconciliation lists', async () => {
    const first = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false });
    await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json', '--no-protect'],
      first.ctx
    );
    const converged = treeState(root);

    const second = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy: samplePolicy({ required_checks: ['Test'] }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json', '--no-protect'],
      second.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(treeState(root)).toEqual(converged);

    const envelope = parseStdoutJson(second.io);
    expect(envelope.reconciled?.created ?? []).toEqual([]);
    expect(envelope.reconciled?.updated ?? []).toEqual([]);
    expect(envelope.reconciled?.removed ?? []).toEqual([]);
    expect(envelope.reconciled?.preserved ?? []).toEqual([]);
    expect(envelope.ignore).toEqual({
      path: '.gitignore',
      entries: ['/.specgit.yaml', '/spec_git/'],
      created: false,
    });
  });
});
