import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { SPEC_GIT_DIR, POLICY_FILENAME } from '../../src/cli/types.js';
import {
  BLOCK_END_MARKER,
  BLOCK_START_MARKER,
  HARNESS_WORKFLOW_PATH,
  harnessWorkflowYaml,
  managedPromptBlock,
} from '../../src/cli/harness-assets.js';
import { makeCtx, makeGitFacts, makeGhProvider, parseStdoutJson, samplePolicy, stdoutText } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const WORKFLOW_ABS = (root: string) => path.join(root, ...HARNESS_WORKFLOW_PATH.split('/'));
const AGENTS_ABS = (root: string) => path.join(root, 'AGENTS.md');
const CLAUDE_ABS = (root: string) => path.join(root, 'CLAUDE.md');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('specgit init', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-init-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('creates spec_git/policy.yaml with the declared required checks', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(
      [
        'node', 'specgit', 'init',
        '--required-check', 'Test',
        '--required-check', 'All checks passed',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.policyWrites).toHaveLength(1);
    expect(t.recordPort.policyWrites[0]).toEqual({
      root,
      policy: { version: 1, required_checks: ['Test', 'All checks passed'] },
    });
    expect(t.recordPort.recordWrites).toHaveLength(0);
  });

  it('prints a human summary with the spec_git path and the harness artifacts', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(stdoutText(t.io)).toContain(SPEC_GIT_DIR);
    expect(stdoutText(t.io)).toContain(POLICY_FILENAME);
    expect(stdoutText(t.io)).toContain(HARNESS_WORKFLOW_PATH);
    expect(stdoutText(t.io)).toContain('AGENTS.md');
  });

  it('emits a JSON envelope in --json mode', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.command).toBe('init');
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['Test'] });
  });

  it('probes protection after writing the policy and warns without a TTY (no changes)', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.ghProvider.calls).toContain('getBranchProtection:LeXwDeX/SpecGit:main');
    expect(t.ghProvider.calls).toContain('getRepoAutomerge:LeXwDeX/SpecGit');
    expect(t.ghProvider.calls).not.toContain('enableBranchProtection:LeXwDeX/SpecGit:main:SpecGit Acceptance');
    const envelope = parseStdoutJson(t.io);
    expect(envelope.protection).toMatchObject({
      branch: 'main',
      protected: false,
      automerge: false,
      action: 'warned',
    });
    expect(JSON.stringify(envelope.protection)).toContain('gh api');
  });

  it('--protect enables protection and auto-merge from scripts', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--protect', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.ghProvider.calls).toContain('enableBranchProtection:LeXwDeX/SpecGit:main:SpecGit Acceptance');
    expect(t.ghProvider.calls).toContain('enableRepoAutomerge:LeXwDeX/SpecGit');
    const envelope = parseStdoutJson(t.io);
    expect(envelope.protection).toMatchObject({
      protected: true,
      requiredChecks: ['SpecGit Acceptance'],
      automerge: true,
      action: 'protected',
    });
  });

  it('--no-protect skips the probe entirely', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--no-protect', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.ghProvider.calls).not.toContain('getBranchProtection:LeXwDeX/SpecGit:main');
    const envelope = parseStdoutJson(t.io);
    expect(envelope.protection).toBeUndefined();
  });

  it('reports already-protected without re-enabling', async () => {
    const gh = makeGhProvider({
      branchProtection: { ok: true, value: { protected: true, requiredChecks: ['SpecGit Acceptance'] } },
      repoAutomerge: { ok: true, value: { enabled: true } },
    });
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false, gh });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(gh.calls).not.toContain('enableBranchProtection:LeXwDeX/SpecGit:main:SpecGit Acceptance');
    const envelope = parseStdoutJson(t.io);
    expect(envelope.protection).toMatchObject({ action: 'already-protected' });
  });

  it('fail-open: provider failure during probing leaves init succeeding as unavailable', async () => {
    const gh = makeGhProvider({
      branchProtection: { ok: false, code: 'gh_transport', message: 'HTTP 403: resource not accessible' },
    });
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false, gh });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--protect', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.protection).toMatchObject({ action: 'unavailable' });
  });

  it('--gitlab-host declares the platform and writes spec_git/providers.yaml', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/specgit.git' }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--gitlab-host', 'git.ycgame.com', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.platform).toEqual({ mode: 'gitlab', gitlabHost: 'git.ycgame.com' });
    expect(fs.readFileSync(path.join(root, 'spec_git', 'providers.yaml'), 'utf-8')).toContain(
      'git.ycgame.com'
    );
  });

  it('--gitlab-host validates the host against the origin (bare hostname, must match)', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/specgit.git' }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--gitlab-host', 'https://evil.com/', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('gitlab_host_invalid');
  });

  it('--gitlab-host on a github.com origin is rejected as nonsensical', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({}),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--gitlab-host', 'git.example.com', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('gitlab_host_invalid');
    expect(fs.existsSync(path.join(root, 'spec_git', 'providers.yaml'))).toBe(false);
  });

  it('github.com origin defaults to github mode without asking', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: true,
      facts: makeGitFacts({}),
    });
    // --no-protect keeps this test on the platform path only (protection
    // would ask its own TTY question).
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--no-protect', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.platform).toEqual({ mode: 'github' });
    expect(fs.existsSync(path.join(root, 'spec_git', 'providers.yaml'))).toBe(false);
  });

  it('non-github origin without a declaration warns: platform undecided', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/specgit.git' }),
    });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.platform).toEqual({ mode: 'undecided' });
    expect(envelope.warnings?.some((w: { code: string }) => w.code === 'platform_undecided')).toBe(true);
  });


  it('with no --required-check and no workflows, falls back to the aggregate check', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['All checks passed'] });
  });

  it('with no --required-check, auto-detects job names from .github/workflows', async () => {
    const workflowsDir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'ci.yml'),
      'name: CI\non: [pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n  test:\n    name: Test (linux)\n    runs-on: ubuntu-latest\n'
    );
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['build', 'Test (linux)'] });
    expect(envelope.detected.sources).toEqual(['.github/workflows/ci.yml']);
    expect(envelope.detected.fallback).toBe(false);
  });

  it('detects gitlab-ci job keys when no GitHub workflows exist', async () => {    fs.writeFileSync(
      path.join(root, '.gitlab-ci.yml'),
      'stages:\n  - build\n  - test\ninclude:\n  - local: /templates.yml\nbuild-job:\n  script: echo build\ntest-job:\n  script: echo test\n'
    );
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['build-job', 'test-job'] });
    expect(envelope.detected.sources).toEqual(['.gitlab-ci.yml']);
  });

  it('skips matrix placeholder job names and falls back to the job id', async () => {
    const workflowsDir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'ci.yml'),
      'name: CI\non: [pull_request]\njobs:\n' +
        '  unit:\n' +
        '    name: Unit Tests (${{ matrix.settings.name }})\n' +
        '    runs-on: ubuntu-latest\n' +
        '  lint:\n' +
        '    name: Lint\n' +
        '    runs-on: ubuntu-latest\n'
    );
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    // The placeholder name never appears in real check-runs; the job id is
    // the stable, checkable identity.
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['unit', 'Lint'] });
  });

  it('ignores workflow_dispatch-only workflows', async () => {
    const workflowsDir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'manual.yml'),
      'name: Manual\non: workflow_dispatch\njobs:\n  run:\n    runs-on: ubuntu-latest\n'
    );
    fs.writeFileSync(
      path.join(workflowsDir, 'ci.yml'),
      'name: CI\non: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n'
    );
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    // Dispatch-only workflows never run on a PR head, so their jobs cannot
    // appear as check runs there.
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['test'] });
    expect(envelope.detected.sources).toEqual(['.github/workflows/ci.yml']);
  });

  it('reports the detected platform from the origin URL', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false });
    await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    // makeCtx's default facts carry a github.com origin; platform detection
    // reads it through ctx.git.facts.
    const envelope = parseStdoutJson(t.io);
    expect(envelope.detected.platform).toBe('github');
    expect(typeof envelope.detected.clis.gh).toBe('boolean');
    expect(typeof envelope.detected.clis.glab).toBe('boolean');
  });

  it('--no-detect without --required-check exits 2 (strict legacy path)', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--no-detect', '--json'], t.ctx);
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('required_check_required');
    expect(t.recordPort.policyWrites).toHaveLength(0);
  });

  it('--force rebuilds an existing policy', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      policy: { version: 1, required_checks: ['Old'] },
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'New', '--force', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.policyWrites).toEqual([
      { policy: { version: 1, required_checks: ['New'] }, root },
    ]);
  });

  it('generates the guard hooks and the git pre-push hook', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'T', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(fs.existsSync(path.join(root, '.opencode', 'hooks.json'))).toBe(true);
    const guard = path.join(root, '.opencode', 'hooks', 'specgit-merge-guard.sh');
    expect(fs.existsSync(guard)).toBe(true);
    // Windows filesystems do not carry POSIX exec bits; git-for-windows
    // executes hooks regardless. Assert the bit only where it exists.
    if (process.platform !== 'win32') {
      expect(fs.statSync(guard).mode & 0o111).not.toBe(0);
    }
    // No .git directory in this fixture → no git hook, but no failure either.
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('does not overwrite an existing policy', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      policy: { version: 1, required_checks: ['Existing'] },
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'New', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('policy_exists');
    expect(t.recordPort.policyWrites).toHaveLength(0);
  });

  it('fails usage when a required check name is empty, writing nothing', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', ' ', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('required_check_invalid');
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it('fails closed (exit 3) outside a git repository, writing nothing', async () => {
    const t = makeCtx({
      root: { ok: false, code: 'not_a_git_repo', message: 'Not a git repository.' },
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.errors[0].code).toBe('not_a_git_repo');
    expect(fs.readdirSync(root)).toHaveLength(0);
  });
});

describe('specgit init harness generation', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-init-harness-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('generates the acceptance workflow and the AGENTS.md managed block; no CLAUDE.md when absent', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);

    const workflow = read(WORKFLOW_ABS(root));
    expect(workflow).toContain('name: SpecGit Acceptance');
    expect(workflow).toContain('pull_request');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('node bin/specgit.js finish --json');
    expect(workflow).not.toContain('\r');

    const agents = read(AGENTS_ABS(root));
    expect(agents).toBe(`${managedPromptBlock()}\n`);
    expect(agents).toContain(BLOCK_START_MARKER);
    expect(agents).toContain(BLOCK_END_MARKER);
    expect(agents).not.toContain('\r');

    expect(fs.existsSync(CLAUDE_ABS(root))).toBe(false);
  });

  it('template stays in sync with this repo own workflow file (anti-drift lock)', async () => {
    // The generated template IS this repository's acceptance workflow:
    // when the repo file evolves (dispatch trigger, WAIT_SHA fallback…),
    // the template source must follow, or a re-init silently regresses it.
    // Normalize line endings: the working tree may carry CRLF on Windows.
    const readNormalized = (p: string) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
    const repoWorkflow = readNormalized(
      path.join(__dirname, '..', '..', '.github', 'workflows', 'specgit-accept.yml')
    );
    expect(harnessWorkflowYaml().replace(/\r\n/g, '\n')).toBe(repoWorkflow);
  });

  it('wait-for-siblings script retries transient API failures', async () => {
    const workflow = harnessWorkflowYaml();
    // Retry markers: bounded attempts with exponential backoff on 5xx/429.
    expect(workflow).toContain('MAX_ATTEMPTS');
    expect(workflow).toContain('retryAfter');
    expect(workflow).toContain('backoff');
    // The dispatch trigger and the SHA fallback are part of the synced evolution.
    expect(workflow).toContain('workflow_dispatch');
    expect(workflow).toContain('github.event.pull_request.head.sha || github.sha');
  });

  it('covers the human story, repair, diagnostics, granularity, and iron rules in the block', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);

    const block = managedPromptBlock();
    expect(block).toContain('specgit issue');
    expect(block).toContain('specgit finish');
    expect(block).toContain('specgit pr');
    expect(block).toContain('specgit status');
    expect(block).toContain('specgit doctor');
    expect(block.toLowerCase()).toContain('one issue = one independently verifiable why');
    expect(block).toContain('never request merge');
    expect(block.toLowerCase()).toContain('never weaken');
    expect(block).toContain('--json');
    expect(block.startsWith(BLOCK_START_MARKER)).toBe(true);
    expect(block.endsWith(BLOCK_END_MARKER)).toBe(true);
  });

  it('guides agents to search for similar open issues before creating one', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);

    const agents = read(AGENTS_ABS(root));
    const block = managedPromptBlock();
    expect(block).toContain('### Before creating an issue, check for duplicates');
    // The search step must name the actual gh command agents should run.
    expect(block).toContain('gh issue list');
    // Similar candidates must be read, not just listed.
    expect(block).toContain('gh issue view');
    // The human decides whether a duplicate is still worth creating.
    expect(block.toLowerCase()).toContain('ask the requester');
    expect(agents).toContain('### Before creating an issue, check for duplicates');
  });

  it('second init is idempotent: artifacts are rewritten byte-identical, policy still protected', async () => {
    const first = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], first.ctx);
    const workflowAfterFirst = read(WORKFLOW_ABS(root));
    const agentsAfterFirst = read(AGENTS_ABS(root));

    fs.appendFileSync(WORKFLOW_ABS(root), '# drifted local edit\n');
    const second = makeCtx({ root: { ok: true, value: root }, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      second.ctx
    );

    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(second.io);
    expect(envelope.errors[0].code).toBe('policy_exists');

    expect(read(WORKFLOW_ABS(root))).toBe(workflowAfterFirst);
    const agentsAfterSecond = read(AGENTS_ABS(root));
    expect(agentsAfterSecond).toBe(agentsAfterFirst);
    expect(countOccurrences(agentsAfterSecond, BLOCK_START_MARKER)).toBe(1);
    expect(countOccurrences(agentsAfterSecond, BLOCK_END_MARKER)).toBe(1);
  });

  it('injects the block into an existing AGENTS.md without touching surrounding content', async () => {
    const original = '# Project notes\n\nKeep this header.\n\nTail content stays.\n';
    fs.writeFileSync(AGENTS_ABS(root), original);

    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);

    const updated = read(AGENTS_ABS(root));
    expect(updated).toBe(`${original}\n${managedPromptBlock()}\n`);
    expect(updated).toContain('Keep this header.');
    expect(updated).toContain('Tail content stays.');
    expect(updated.startsWith('# Project notes')).toBe(true);
  });

  it('injects the block into an existing CLAUDE.md without creating AGENTS.md copies of it', async () => {
    fs.writeFileSync(AGENTS_ABS(root), '# Agents\n');
    fs.writeFileSync(CLAUDE_ABS(root), '# Claude\n');

    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);

    const claude = read(CLAUDE_ABS(root));
    expect(claude).toBe(`# Claude\n\n${managedPromptBlock()}\n`);
    const agents = read(AGENTS_ABS(root));
    expect(agents).toBe(`# Agents\n\n${managedPromptBlock()}\n`);
  });

  it('re-init replaces only the content between the markers (round-trip)', async () => {
    const first = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], first.ctx);

    const canonical = read(AGENTS_ABS(root));
    const startIndex = canonical.indexOf(BLOCK_START_MARKER);
    const endIndex = canonical.indexOf(BLOCK_END_MARKER);
    const prefix = canonical.slice(0, startIndex);
    const suffix = '\nEdited after the block.\n';
    fs.writeFileSync(
      AGENTS_ABS(root),
      `${prefix}${BLOCK_START_MARKER}\nSTALE CONTENT\n${BLOCK_END_MARKER}${suffix}`
    );

    const second = makeCtx({ root: { ok: true, value: root }, policy: samplePolicy() });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], second.ctx);

    expect(read(AGENTS_ABS(root))).toBe(`${prefix}${managedPromptBlock()}${suffix}`);
  });
});
