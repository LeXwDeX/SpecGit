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
import { externalAcceptanceWorkflowYaml } from '../../src/cli/external-harness.js';
import { makeCtx, makeGitFacts, makeGhProvider, parseStdoutJson, samplePolicy, stdoutText } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const WORKFLOW_ABS = (root: string) => path.join(root, ...HARNESS_WORKFLOW_PATH.split('/'));
const AGENTS_ABS = (root: string) => path.join(root, 'AGENTS.md');
const CLAUDE_ABS = (root: string) => path.join(root, 'CLAUDE.md');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
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
    // The fix guidance must be non-weakening: it may not teach a command
    // that clears reviews, restrictions, or admin enforcement.
    const fix = String(envelope.protection.fix ?? '');
    expect(fix).not.toContain('gh api');
    expect(fix).not.toContain('"required_pull_request_reviews":null');
    expect(fix).not.toContain('"restrictions":null');
    expect(fix).not.toContain('"enforce_admins":false');
    expect(fix).toContain('SpecGit Acceptance');
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

  // #117: a GitHub Actions workflow is wrong-platform output for a
  // GitLab repository — init on gitlab mode writes every platform-neutral
  // harness asset (managed blocks, hooks) but NOT the workflow, reports
  // the pending GitLab harness honestly, and points at .gitlab-ci.yml.
  it('--gitlab-host skips the GitHub Actions workflow and warns gitlab_harness_pending (#117)', async () => {
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
    expect(fs.existsSync(WORKFLOW_ABS(root))).toBe(false);
    expect(envelope.harness).toEqual({ template: 'gitlab-pending' });
    const warning = (envelope.warnings ?? []).find(
      (w: { code: string }) => w.code === 'gitlab_harness_pending'
    );
    expect(warning).toBeDefined();
    expect(warning.message).toContain('.gitlab-ci.yml');
    // Platform-neutral harness assets still land: the managed prompt
    // block in AGENTS.md.
    expect(read(AGENTS_ABS(root))).toContain(BLOCK_START_MARKER);
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

  // #78 + 88-2: the origin-host seam captures host and port structurally,
  // so explicit-port origins platform-resolve and host:port declarations
  // validate against the origin's effective port.
  it('an ssh origin with the default port classifies github without a declaration (#78 seam)', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'ssh://git@github.com:22/LeXwDeX/SpecGit.git' }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--no-protect', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.platform).toEqual({ mode: 'github' });
    expect(envelope.warnings?.some((w: { code: string }) => w.code === 'platform_undecided')).toBeFalsy();
    expect(fs.existsSync(path.join(root, 'spec_git', 'providers.yaml'))).toBe(false);
  });

  it('--gitlab-host host:port declares the platform and persists the port (#78 declaration grammar)', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'https://git.corp.example:8443/o/r.git' }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--gitlab-host', 'git.corp.example:8443', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.platform).toEqual({ mode: 'gitlab', gitlabHost: 'git.corp.example:8443' });
    const providers = fs.readFileSync(path.join(root, 'spec_git', 'providers.yaml'), 'utf-8');
    expect(providers).toContain('git.corp.example');
    expect(providers).toMatch(/port: ['"]?8443/);
  });

  it('--gitlab-host validates the declared port against the origin port (both directions)', async () => {
    // Port declared, portless origin: the declaration must name the port
    // the origin actually uses.
    const portless = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'https://git.corp.example/o/r.git' }),
    });
    const withPort = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--gitlab-host', 'git.corp.example:8443', '--json'],
      portless.ctx
    );
    expect(withPort).toBe(EXIT_USAGE);
    expect(parseStdoutJson(portless.io).errors[0].code).toBe('gitlab_host_invalid');
    expect(fs.existsSync(path.join(root, 'spec_git', 'providers.yaml'))).toBe(false);

    // Portless declaration, non-default port on the origin: the fix must
    // teach the host:port grammar.
    const ported = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'https://git.corp.example:8443/o/r.git' }),
    });
    const withoutPort = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--gitlab-host', 'git.corp.example', '--json'],
      ported.ctx
    );
    expect(withoutPort).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(ported.io);
    expect(envelope.errors[0].code).toBe('gitlab_host_invalid');
    expect(envelope.errors[0].fix ?? envelope.errors[0].message).toContain('git.corp.example:8443');
  });

  it('--gitlab-host rejects a malformed port in the declaration', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'https://git.corp.example:8443/o/r.git' }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--gitlab-host', 'git.corp.example:84x3', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('gitlab_host_invalid');
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


  it('with no --required-check and no CI anywhere, writes an empty checks policy (#63)', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    // A fallback NAME is a name the generated harness can never produce
    // as a check-run: it would deadlock the wait step and make the
    // verdict unsatisfiable. Zero checks + branch protection on the
    // acceptance job is the only satisfiable no-CI policy.
    expect(envelope.policy).toEqual({ version: 1, required_checks: [] });
    expect(envelope.detected.fallback).toBe(true);
    // The wait step in the generated workflow completes immediately with
    // zero required checks: the empty policy is one the harness itself
    // can satisfy (missing.length === 0 on the first poll).
    const workflow = read(WORKFLOW_ABS(root));
    expect(workflow).toContain('const required = policy.required_checks ?? [];');
    expect(workflow).toContain('missing.length === 0');
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
    // #121: dispatch-only is one shape of "never reports on a PR head" —
    // reported, not silently dropped.
    expect(envelope.detected.nonPrWorkflows).toEqual(['.github/workflows/manual.yml']);
  });

  it('classifies by PR trigger: push-filtered and schedule workflows never become required checks (#121)', async () => {
    const workflowsDir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    // Push-triggered deploy with a branch filter: runs on main pushes
    // only, never on a PR head — the stillborn-policy shape from #121.
    fs.writeFileSync(
      path.join(workflowsDir, 'deploy.yml'),
      'name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n'
    );
    // Scheduled nightly: tied to cron, never to a PR.
    fs.writeFileSync(
      path.join(workflowsDir, 'nightly.yml'),
      'name: Nightly\non:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  nightly:\n    runs-on: ubuntu-latest\n'
    );
    // PR-triggered CI (a push trigger alongside pull_request is fine: the
    // PR trigger is what makes the jobs observable at a PR head).
    fs.writeFileSync(
      path.join(workflowsDir, 'verify.yml'),
      'name: Verify\non: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n'
    );
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    // Only the PR-triggered workflow's jobs are required-check candidates.
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['build'] });
    expect(envelope.detected.sources).toEqual(['.github/workflows/verify.yml']);
    // The never-on-PR workflows are reported, not silently dropped.
    expect(envelope.detected.nonPrWorkflows).toEqual([
      '.github/workflows/deploy.yml',
      '.github/workflows/nightly.yml',
    ]);
    // init warns: those jobs can never report on a PR head, and the fix
    // names the legitimate repair path for a wrong-at-birth policy.
    const warning = (envelope.warnings ?? []).find(
      (w: { code: string }) => w.code === 'checks_not_pr_visible'
    );
    expect(warning).toBeDefined();
    expect(warning.message).toContain('.github/workflows/deploy.yml');
    expect(warning.message).toContain('.github/workflows/nightly.yml');
    expect(warning.fix).toContain('--required-check');
    expect(warning.fix).toContain('--force');
  });

  it('pull_request_target and trigger-less workflows qualify; no warning when nothing is skipped (#121)', async () => {
    const workflowsDir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    // pull_request_target runs for PR events too: its check runs report on
    // the PR head, so its jobs stay required-check candidates.
    fs.writeFileSync(
      path.join(workflowsDir, 'guard.yml'),
      'name: Guard\non: pull_request_target\njobs:\n  guard:\n    runs-on: ubuntu-latest\n'
    );
    // No `on:` at all: GitHub's default triggers are push AND
    // pull_request, so the workflow does run on PR heads.
    fs.writeFileSync(
      path.join(workflowsDir, 'default.yml'),
      'name: Default\njobs:\n  checks:\n    runs-on: ubuntu-latest\n'
    );
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['checks', 'guard'] });
    expect(envelope.detected.sources).toEqual(['.github/workflows/default.yml', '.github/workflows/guard.yml']);
    expect(envelope.detected.nonPrWorkflows).toEqual([]);
    expect(
      (envelope.warnings ?? []).some((w: { code: string }) => w.code === 'checks_not_pr_visible')
    ).toBe(false);
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
    // The rejection happens before any harness write: the tree is untouched.
    expect(fs.readdirSync(root)).toHaveLength(0);
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
    // Self-detection (#63): the root package name `specgit` keeps this
    // repository shape on the local-build template.
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'specgit', version: '0.0.0' }, null, 2)}\n`);
    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(parseStdoutJson(t.io).harness).toEqual({ template: 'self' });

    const workflow = read(WORKFLOW_ABS(root));
    expect(workflow).toBe(harnessWorkflowYaml());
    expect(workflow).toContain('name: SpecGit Acceptance');
    expect(workflow).toContain('pull_request');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('node bin/specgit.js finish --json');
    expect(workflow).not.toContain('\r');

    const agents = read(AGENTS_ABS(root));
    expect(agents).toBe(`${managedPromptBlock()}\n`);
    expect(agents).toContain(BLOCK_START_MARKER);
    expect(agents).toContain(BLOCK_END_MARKER);
    expect(agents).not.toContain('\r');

    expect(fs.existsSync(CLAUDE_ABS(root))).toBe(false);
  });

  it('adopting repositories get the portable external workflow (#63 wiring)', async () => {
    // No specgit package at the root: an adopting repository. The remote
    // default branch (here genuinely non-main) and the CLI version pin
    // the template; nothing about the adopting stack is assumed.
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'unrelated-app', version: '1.0.0' }, null, 2)}\n`);
    const t = makeCtx({
      root: { ok: true, value: root },
      gitWrites: { remoteDefaultBranch: () => ({ ok: true, value: 'master' }) },
    });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Build', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.harness).toEqual({ template: 'external' });

    const workflow = read(WORKFLOW_ABS(root));
    expect(workflow).toBe(externalAcceptanceWorkflowYaml({ defaultBranch: 'master', version: '0.0.0-test' }));
    expect(workflow).toContain('branches: [master]');
    expect(workflow).toContain(`npm install --no-save --no-audit --no-fund specgit@0.0.0-test`);
    expect(workflow).toContain('npx --no-install specgit finish --json');
    // The adopting project's toolchain is never invoked.
    expect(workflow).not.toContain('pnpm');
    expect(workflow).not.toContain('bin/specgit.js');
  });

  it('an unresolvable remote default branch falls back to main with a warning', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      gitWrites: {
        remoteDefaultBranch: () => ({ ok: false, code: 'git_probe_failed', message: 'no origin/HEAD' }),
      },
    });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Build', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.harness).toEqual({ template: 'external' });
    expect(envelope.warnings?.some((w: { code: string }) => w.code === 'default_branch_unresolved')).toBe(true);
    expect(read(WORKFLOW_ABS(root))).toContain('branches: [main]');
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

  it('re-init with an existing policy rejects before writing: drift stays, no probes', async () => {
    const first = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], first.ctx);
    const workflowAfterFirst = read(WORKFLOW_ABS(root));
    const agentsAfterFirst = read(AGENTS_ABS(root));

    // Inject drift into every managed artifact.
    fs.appendFileSync(WORKFLOW_ABS(root), '# drifted local edit\n');
    fs.appendFileSync(AGENTS_ABS(root), '# drifted tail\n');

    const second = makeCtx({ root: { ok: true, value: root }, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      second.ctx
    );

    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(second.io);
    expect(envelope.errors[0].code).toBe('policy_exists');

    // policy_exists happens before filesystem AND remote mutation: the
    // drift is left exactly as it was and no gh probe runs.
    expect(read(WORKFLOW_ABS(root))).toBe(`${workflowAfterFirst}# drifted local edit\n`);
    expect(read(AGENTS_ABS(root))).toBe(`${agentsAfterFirst}# drifted tail\n`);
    expect(second.ghProvider.calls).toHaveLength(0);
    expect(second.recordPort.policyWrites).toHaveLength(0);
  });

  it('--force is the refresh path: drifted harness is repaired, policy rebuilt', async () => {
    const first = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], first.ctx);
    const workflowAfterFirst = read(WORKFLOW_ABS(root));
    const agentsAfterFirst = read(AGENTS_ABS(root));
    const markerTail = agentsAfterFirst.slice(
      agentsAfterFirst.indexOf(BLOCK_END_MARKER) + BLOCK_END_MARKER.length
    );

    fs.appendFileSync(WORKFLOW_ABS(root), '# drifted local edit\n');

    const second = makeCtx({ root: { ok: true, value: root }, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--force', '--json'],
      second.ctx
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(read(WORKFLOW_ABS(root))).toBe(workflowAfterFirst);
    expect(read(AGENTS_ABS(root))).toBe(`${agentsAfterFirst.slice(0, agentsAfterFirst.indexOf(BLOCK_END_MARKER) + BLOCK_END_MARKER.length)}${markerTail}`);
    expect(second.recordPort.policyWrites).toEqual([
      { root, policy: { version: 1, required_checks: ['Test'] } },
    ]);
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

  it('re-init with --force replaces only the content between the markers (round-trip)', async () => {
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
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test', '--force'], second.ctx);

    expect(read(AGENTS_ABS(root))).toBe(`${prefix}${managedPromptBlock()}${suffix}`);
  });
});

describe('specgit init validate-before-write', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-init-order-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('rejects a mismatched --gitlab-host before any filesystem write', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      facts: makeGitFacts({ originUrl: 'git@git.ycgame.com:suntao/specgit.git' }),
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--gitlab-host', 'evil.example.com', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('gitlab_host_invalid');
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it('fails usage on an unwritable root before any write', async () => {
    if (process.platform === 'win32') return; // chmod is advisory on Windows
    const t = makeCtx({ root: { ok: true, value: root } });
    fs.chmodSync(root, 0o500);
    let code: number | undefined;
    try {
      code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test', '--json'], t.ctx);
    } finally {
      fs.chmodSync(root, 0o700);
    }
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('root_not_writable');
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it('a mid-sequence harness write failure rolls back to the pre-init tree (exit 3)', async () => {
    // `.opencode` as a regular file: the workflow and prompt writes succeed,
    // then mkdir('.opencode') fails — everything must roll back.
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# existing notes\n');
    fs.writeFileSync(path.join(root, '.opencode'), 'not a directory');

    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test', '--json'], t.ctx);

    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('harness_write_failed');
    expect(read(path.join(root, 'AGENTS.md'))).toBe('# existing notes\n');
    expect(fs.existsSync(path.join(root, '.github'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.opencode'), 'utf-8')).toBe('not a directory');
    expect(t.recordPort.policyWrites).toHaveLength(0);
  });
});

describe('specgit init hook merging', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-init-hooks-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('merges existing hooks.json and git pre-push instead of overwriting', async () => {
    const gitHooks = path.join(root, 'git-hooks');
    fs.mkdirSync(gitHooks, { recursive: true });
    fs.mkdirSync(path.join(root, '.opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.opencode', 'hooks.json'),
      '{\n  "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "greet.sh" }] }],\n  "custom": { "kept": true }\n}\n'
    );
    fs.writeFileSync(path.join(gitHooks, 'pre-push'), '#!/bin/sh\n./scripts/verify.sh || exit 1\n');

    const t = makeCtx({
      root: { ok: true, value: root },
      gitWrites: { hooksPath: () => ({ ok: true, value: gitHooks }) },
    });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);

    const hooksJson = JSON.parse(read(path.join(root, '.opencode', 'hooks.json'))) as {
      SessionStart: unknown[];
      custom: unknown;
      PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    };
    expect(hooksJson.SessionStart).toHaveLength(1);
    expect(hooksJson.custom).toEqual({ kept: true });
    const bash = hooksJson.PreToolUse.find((entry) => entry.matcher === 'Bash');
    expect(bash?.hooks).toHaveLength(1);

    const prePush = read(path.join(gitHooks, 'pre-push'));
    expect(prePush).toContain('./scripts/verify.sh');
    expect(prePush.indexOf('./scripts/verify.sh')).toBeLessThan(prePush.indexOf('# >>> specgit:start >>>'));

    const envelope = parseStdoutJson(t.io);
    expect(envelope.warnings ?? []).toEqual([]);
  });

  it('leaves an unmergeable hooks.json untouched and surfaces a warning', async () => {
    fs.mkdirSync(path.join(root, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(root, '.opencode', 'hooks.json'), '{ broken');

    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);

    expect(read(path.join(root, '.opencode', 'hooks.json'))).toBe('{ broken');
    expect(fs.existsSync(path.join(root, '.opencode', 'hooks', 'specgit-merge-guard.sh'))).toBe(true);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.warnings?.some((w: { code: string }) => w.code === 'hooks_json_unmerged')).toBe(true);
  });
});
