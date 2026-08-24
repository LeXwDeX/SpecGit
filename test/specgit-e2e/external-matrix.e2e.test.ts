/**
 * Issue #67 — external adoption matrix, PR-level layer (packed artifact).
 *
 * Unrelated npm repositories adopt the `npm pack` candidate via file://
 * and drive the full SpecGit story from the INSTALLED bin — nothing
 * leans on this repository's workspace, pnpm layout, or branch names.
 * GitHub facts flow through the fake gh seam (`SPECGIT_GH` + PATH);
 * git facts are real local git against a bare remote standing in for
 * origin (url.insteadOf rewrite). The live layer — the registry-
 * published package inside a real external repository's green Actions
 * run — is post-publish, tracked on the issue, and smoked opt-in in
 * install-smoke.e2e.test.ts.
 *
 * Fixture × command matrix (runs on every CI test_matrix entry —
 * linux-bash, macos-bash, windows-pwsh, Node 20.19.0 — because vitest
 * includes this file unconditionally):
 *
 * | fixture              | default branch | own CI  | commands exercised from the installed bin              |
 * |----------------------|----------------|---------|--------------------------------------------------------|
 * | unrelated npm repo   | master         | none    | doctor(3)→init→doctor(0)→issue(resume)→pr repair→finish(0) |
 * | unrelated npm repo   | main           | App CI  | init(detect)→bind→finish(1 rejected)→finish(0 accepted)    |
 * | linked worktree      | master         | none    | init→issue→finish(0, worktree context)                     |
 *
 * The 2/3 exit legs of the 0/1/2/3 matrix run in
 * install-smoke.e2e.test.ts against the same installed artifact.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { git } from './helpers.js';
import {
  EXT_CHECK,
  EXT_OWNER,
  EXT_REPO,
  externalNpmCache,
  makeExternalWorktree,
  makePushableExternalRepo,
  npmInstallPacked,
  packSpecgit,
  remoteDefaultBranch,
  rmDir,
  runInstalledSpecgit,
} from './external-repo-fixture.js';
import { createFakeGh, emptyTimelineRule, readFakeGhCalls, type FakeGhRule } from './helpers.js';

/** The documented harness workflow location — asserted as a product surface, not imported from src. */
const HARNESS_WORKFLOW_PATH = '.github/workflows/specgit-accept.yml';

const cleanup: string[] = [];

afterAll(() => {
  for (const dir of cleanup) rmDir(dir);
});

/** The envelope contract: exactly one JSON document on stdout — a whole-string parse proves it. */
function parseInstalledJson(result: { stdout: string }): Record<string, any> {
  const text = result.stdout.trim();
  if (text.length === 0) {
    throw new Error('expected exactly one JSON document on stdout, got empty output');
  }
  return JSON.parse(text) as Record<string, any>;
}

function ghVersionRules() {
  return [
    { match: '^--version$', stdout: 'gh version 2.60.0-external-matrix\n' },
    { match: '^auth status', stdout: 'Logged in to github.com as external-matrix\n' },
  ];
}

/** Each fake gh gets its OWN directory: the recorder appends to a per-dir log. */
function makeGh(prefix: string, rules: FakeGhRule[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return createFakeGh(dir, rules);
}

function makeXdg(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

describe('e2e external matrix (#67): master + npm + no CI', () => {
  it(
    'doctor→init→doctor→issue(resume)→pr repair→finish, all from the packed artifact',
    { timeout: 240_000 },
    async () => {
      const { tarballPath, version } = await packSpecgit();
      const cache = externalNpmCache('specgit-ext-matrix-cache-');
      const fixture = makePushableExternalRepo('specgit-ext-noci-', { ci: 'none' });
      cleanup.push(fixture.dir, fixture.bareDir, cache);
      await npmInstallPacked(tarballPath, fixture.dir, cache);

      const xdg = makeXdg('specgit-ext-noci-xdg-');
      const env = (gh: ReturnType<typeof createFakeGh>) => gh.env({ XDG_CONFIG_HOME: xdg });

      // A repository with no CI of its own: doctor fails closed on the
      // missing policy before init, with the full probe table.
      const preGh = makeGh('specgit-ext-noci-gh-', ghVersionRules());
      const doctorBefore = runInstalledSpecgit(fixture.dir, ['doctor', '--json'], env(preGh));
      expect(doctorBefore.status, doctorBefore.stderr).toBe(3);
      const doctorBeforeEnvelope = parseInstalledJson(doctorBefore);
      expect(doctorBeforeEnvelope.status).toBe('unknown');
      const probesBefore = doctorBeforeEnvelope.probes as Array<{ name: string; ok: boolean }>;
      expect(probesBefore.find((probe) => probe.name === 'policy')?.ok).toBe(false);
      expect(probesBefore.find((probe) => probe.name === 'gh_present')?.ok).toBe(true);

      // init names zero required checks (#63 semantics) and selects the
      // portable external template for an adopting repository.
      const init = runInstalledSpecgit(fixture.dir, ['init', '--no-protect', '--json'], env(preGh));
      expect(init.status, init.stderr).toBe(0);
      const initEnvelope = parseInstalledJson(init);
      expect(initEnvelope.policy).toEqual({ version: 1, required_checks: [] });
      expect(initEnvelope.harness).toEqual({ template: 'external' });

      // The default branch is genuinely non-main; the generated workflow
      // parameterizes it and pins the installed version.
      expect(remoteDefaultBranch(fixture.dir)).toBe('master');
      const workflowPath = path.join(fixture.dir, ...HARNESS_WORKFLOW_PATH.split('/'));
      const workflow = fs.readFileSync(workflowPath, 'utf-8');
      expect(workflow).toContain(`specgit@${version}`);
      expect(workflow).toContain('master');

      // After init every doctor probe is green.
      const doctorAfter = runInstalledSpecgit(fixture.dir, ['doctor', '--json'], env(preGh));
      expect(doctorAfter.status, doctorAfter.stderr).toBe(0);
      const probesAfter = parseInstalledJson(doctorAfter).probes as Array<{ ok: boolean }>;
      expect(probesAfter.every((probe) => probe.ok)).toBe(true);

      // Bootstrap, broken between steps: issues, branch, and the partial
      // record land; PR creation fails — exit 3, fail-closed.
      const ghBroken = makeGh('specgit-ext-noci-ghbroken-', [
        { match: '^api search/issues', stdout: JSON.stringify({ items: [] }) },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/issues `,
          stdout: `{"number":%SEQ%,"html_url":"https://github.com/${EXT_OWNER}/${EXT_REPO}/issues/%SEQ%"}`,
          seq: { start: 11 },
        },
        { match: '^pr list ', stdout: '[]' },
        { match: '^pr create --draft ', exit: 1 },
      ]);
      const bootstrapTitle = 'feat: external adoption';
      const broken = runInstalledSpecgit(
        fixture.dir,
        ['issue', bootstrapTitle, '--json'],
        env(ghBroken)
      );
      expect(broken.status).toBe(3);
      expect(parseInstalledJson(broken).errors[0].code).toBe('gh_transport');
      const partial = fs.readFileSync(path.join(fixture.dir, '.specgit.yaml'), 'utf-8');
      expect(partial).toContain('- 11');
      expect(partial).not.toMatch(/^pr:/m);
      const deliveryBranch = 'feat/11-external-adoption';
      expect(git(fixture.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(deliveryBranch);

      // PR repair: the remote already has the PR for this head branch;
      // `specgit pr` discovers it and rebinds the record.
      const ghRepair = makeGh('specgit-ext-noci-ghrepair-', [
        {
          match: '^pr list ',
          stdout: JSON.stringify([
            {
              number: 9,
              title: bootstrapTitle,
              url: `https://github.com/${EXT_OWNER}/${EXT_REPO}/pull/9`,
            },
          ]),
        },
      ]);
      const repair = runInstalledSpecgit(fixture.dir, ['pr', '--json'], env(ghRepair));
      expect(repair.status, repair.stderr).toBe(0);
      const repairEnvelope = parseInstalledJson(repair);
      expect(repairEnvelope.state).toBe('bound');
      expect(repairEnvelope.record.pr).toBe(9);
      expect(
        readFakeGhCalls(ghRepair.logPath).some((args) => args.includes(`--head ${deliveryBranch}`))
      ).toBe(true);

      // Resume: the same command against the completed record binds
      // without creating anything. The mergedness probe (#75) is part of
      // resuming a PR-bound record, so the fake gh answers for PR #9:
      // live (open, unmerged) → the resume converges, creating nothing.
      const ghResume = makeGh('specgit-ext-noci-ghresume-', [
        { match: '^api search/issues', stdout: JSON.stringify({ items: [] }) },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/pulls/9$`,
          stdout: JSON.stringify({
            number: 9,
            state: 'open',
            merged_at: null,
            draft: false,
            head: { ref: deliveryBranch, sha: 'a'.repeat(40) },
            base: { ref: 'master' },
            body: 'Closes #11\n',
          }),
        },
        emptyTimelineRule(EXT_OWNER, EXT_REPO),
      ]);
      const resume = runInstalledSpecgit(
        fixture.dir,
        ['issue', bootstrapTitle, '--json'],
        env(ghResume)
      );
      expect(resume.status, resume.stderr).toBe(0);
      const resumeEnvelope = parseInstalledJson(resume);
      expect(resumeEnvelope.state).toBe('bound');
      expect(resumeEnvelope.record).toMatchObject({ issues: [11], pr: 9 });
      const resumeCalls = readFakeGhCalls(ghResume.logPath);
      expect(
        resumeCalls.filter((args) => args.startsWith(`api repos/${EXT_OWNER}/${EXT_REPO}/issues `)),
        `resume gh calls: ${JSON.stringify(resumeCalls)}`
      ).toHaveLength(0);
      expect(resumeCalls.filter((args) => args.startsWith('pr create'))).toHaveLength(0);

      // Finish: merged PR, closed issue → accepted with exit 0.
      const sha = git(fixture.dir, 'rev-parse', 'HEAD').trim();
      const ghMerged = makeGh('specgit-ext-noci-ghmerged-', [
        ...ghVersionRules(),
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/issues/11$`,
          stdout: JSON.stringify({ number: 11, state: 'closed' }),
        },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/pulls/9$`,
          stdout: JSON.stringify({
            number: 9,
            state: 'open',
            merged_at: '2026-01-02T03:04:05Z',
            draft: false,
            head: { ref: deliveryBranch, sha },
            base: { ref: 'master' },
            body: 'Closes #11',
          }),
        },
        emptyTimelineRule(EXT_OWNER, EXT_REPO),
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/commits/[0-9a-f]+/check-runs`,
          stdout: JSON.stringify({ total_count: 0, check_runs: [] }),
        },
      ]);
      const finish = runInstalledSpecgit(fixture.dir, ['finish', '--json'], env(ghMerged));
      expect(finish.status, finish.stderr).toBe(0);
      const finishEnvelope = parseInstalledJson(finish);
      expect(finishEnvelope.verdict.classification).toBe('accepted');
      expect(finishEnvelope.verdict.evidence.branch).toBe(deliveryBranch);

      // The bootstrap pushed the delivery branch: the bare origin
      // carries it at the local head.
      expect(
        git(fixture.bareDir, 'rev-parse', '--verify', `refs/heads/${deliveryBranch}`).trim()
      ).toBe(sha);

      // The adoption install never touched the adopting manifest.
      const adoptingPkg = JSON.parse(
        fs.readFileSync(path.join(fixture.dir, 'package.json'), 'utf-8')
      ) as { dependencies?: unknown };
      expect(adoptingPkg.dependencies).toBeUndefined();
    }
  );
});

describe('e2e external matrix (#67): main + existing CI', () => {
  it(
    'init detects the adopting repo check; finish verdicts follow real CI evidence (1 rejected, then 0 accepted)',
    { timeout: 240_000 },
    async () => {
      const { tarballPath, version } = await packSpecgit();
      const cache = externalNpmCache('specgit-ext-matrix-cache-');
      const fixture = makePushableExternalRepo('specgit-ext-mainci-', {
        defaultBranch: 'main',
        ci: 'app',
      });
      cleanup.push(fixture.dir, fixture.bareDir, cache);
      await npmInstallPacked(tarballPath, fixture.dir, cache);
      expect(remoteDefaultBranch(fixture.dir)).toBe('main');

      const deliveryBranch = 'feat/7-main-ci-adoption';
      git(fixture.dir, 'checkout', '-b', deliveryBranch);

      // init auto-detects the adopting repository's own check — no gh
      // involvement (--no-protect).
      const init = runInstalledSpecgit(fixture.dir, ['init', '--no-protect', '--json']);
      expect(init.status, init.stderr).toBe(0);
      const initEnvelope = parseInstalledJson(init);
      expect(initEnvelope.policy).toEqual({ version: 1, required_checks: [EXT_CHECK] });
      expect(initEnvelope.harness).toEqual({ template: 'external' });
      const workflowPath = path.join(fixture.dir, ...HARNESS_WORKFLOW_PATH.split('/'));
      const workflow = fs.readFileSync(workflowPath, 'utf-8');
      expect(workflow).toContain(`specgit@${version}`);
      expect(workflow).toContain('main');

      const bind = runInstalledSpecgit(
        fixture.dir,
        ['bind', '--delivery', 'main-ci-adoption', '--issue', '7', '--pr', '9', '--json']
      );
      expect(bind.status, bind.stderr).toBe(0);

      const xdg = makeXdg('specgit-ext-mainci-xdg-');
      const env = (gh: ReturnType<typeof createFakeGh>) => gh.env({ XDG_CONFIG_HOME: xdg });
      const sha = git(fixture.dir, 'rev-parse', 'HEAD').trim();

      // Red CI on an open PR: rejected with complete evidence, exit 1.
      const ghRed = makeGh('specgit-ext-mainci-ghred-', [
        ...ghVersionRules(),
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/issues/7$`,
          stdout: JSON.stringify({ number: 7, state: 'open' }),
        },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/pulls/9$`,
          stdout: JSON.stringify({
            number: 9,
            state: 'open',
            merged_at: null,
            draft: false,
            head: { ref: deliveryBranch, sha },
            base: { ref: 'main' },
            body: 'Closes #7',
          }),
        },
        emptyTimelineRule(EXT_OWNER, EXT_REPO),
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/commits/[0-9a-f]+/check-runs`,
          stdout: JSON.stringify({
            total_count: 1,
            check_runs: [{ name: EXT_CHECK, status: 'completed', conclusion: 'failure' }],
          }),
        },
      ]);
      const rejected = runInstalledSpecgit(fixture.dir, ['finish', '--json'], env(ghRed));
      expect(rejected.status).toBe(1);
      const rejectedEnvelope = parseInstalledJson(rejected);
      expect(rejectedEnvelope.verdict.classification).toBe('rejected');
      expect(
        (rejectedEnvelope.errors as Array<{ code: string }>).map((error) => error.code)
      ).toContain('checks_failed');
      expect(rejectedEnvelope.verdict.evidence.pr).toBe(9);

      // Healed world: green checks, merged PR, closed issue → exit 0.
      const ghGreen = makeGh('specgit-ext-mainci-ghgreen-', [
        ...ghVersionRules(),
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/issues/7$`,
          stdout: JSON.stringify({ number: 7, state: 'closed' }),
        },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/pulls/9$`,
          stdout: JSON.stringify({
            number: 9,
            state: 'open',
            merged_at: '2026-01-02T03:04:05Z',
            draft: false,
            head: { ref: deliveryBranch, sha },
            base: { ref: 'main' },
            body: 'Closes #7',
          }),
        },
        emptyTimelineRule(EXT_OWNER, EXT_REPO),
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/commits/[0-9a-f]+/check-runs`,
          stdout: JSON.stringify({
            total_count: 1,
            check_runs: [{ name: EXT_CHECK, status: 'completed', conclusion: 'success' }],
          }),
        },
      ]);
      const accepted = runInstalledSpecgit(fixture.dir, ['finish', '--json'], env(ghGreen));
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(parseInstalledJson(accepted).verdict.classification).toBe('accepted');
    }
  );
});

describe('e2e external matrix (#67): linked worktree delivery', () => {
  it(
    'adopts through a linked worktree: init→issue→finish with worktree context',
    { timeout: 240_000 },
    async () => {
      const { tarballPath } = await packSpecgit();
      const cache = externalNpmCache('specgit-ext-matrix-cache-');
      const wt = makeExternalWorktree('specgit-ext-wt-');
      cleanup.push(wt.mainDir, wt.worktreeDir, wt.bareDir, cache);
      await npmInstallPacked(tarballPath, wt.worktreeDir, cache);

      const init = runInstalledSpecgit(wt.worktreeDir, ['init', '--no-protect', '--json']);
      expect(init.status, init.stderr).toBe(0);
      expect(parseInstalledJson(init).harness).toEqual({ template: 'external' });

      const xdg = makeXdg('specgit-ext-wt-xdg-');
      const env = (gh: ReturnType<typeof createFakeGh>) => gh.env({ XDG_CONFIG_HOME: xdg });

      const ghBootstrap = makeGh('specgit-ext-wt-ghboot-', [
        { match: '^api search/issues', stdout: JSON.stringify({ items: [] }) },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/issues `,
          stdout: `{"number":%SEQ%,"html_url":"https://github.com/${EXT_OWNER}/${EXT_REPO}/issues/%SEQ%"}`,
          seq: { start: 11 },
        },
        { match: '^pr list ', stdout: '[]' },
        {
          match: '^pr create --draft ',
          stdout: `https://github.com/${EXT_OWNER}/${EXT_REPO}/pull/9\n`,
        },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/issues/[0-9]+/comments `,
          stdout: `{"html_url":"https://github.com/${EXT_OWNER}/${EXT_REPO}/issues/x#issuecomment-1"}`,
        },
      ]);
      const bootstrap = runInstalledSpecgit(
        wt.worktreeDir,
        ['issue', 'feat: worktree adoption', '--json'],
        env(ghBootstrap)
      );
      expect(bootstrap.status, `${bootstrap.stderr}\n${bootstrap.stdout}`).toBe(0);
      const bootstrapEnvelope = parseInstalledJson(bootstrap);
      expect(bootstrapEnvelope.state).toBe('bound');
      expect(bootstrapEnvelope.record).toMatchObject({
        context: { kind: 'worktree', label: wt.label },
        issues: [11],
        pr: 9,
      });
      const deliveryBranch = 'feat/11-worktree-adoption';
      expect(bootstrapEnvelope.record.context).toMatchObject({ branch: deliveryBranch });

      // The main checkout stays untouched: the delivery lives in the
      // worktree alone.
      expect(fs.existsSync(path.join(wt.mainDir, '.specgit.yaml'))).toBe(false);
      expect(fs.existsSync(path.join(wt.mainDir, 'spec_git'))).toBe(false);

      const sha = git(wt.worktreeDir, 'rev-parse', 'HEAD').trim();
      const ghMerged = makeGh('specgit-ext-wt-ghmerged-', [
        ...ghVersionRules(),
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/issues/11$`,
          stdout: JSON.stringify({ number: 11, state: 'closed' }),
        },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/pulls/9$`,
          stdout: JSON.stringify({
            number: 9,
            state: 'open',
            merged_at: '2026-01-02T03:04:05Z',
            draft: false,
            head: { ref: deliveryBranch, sha },
            base: { ref: 'master' },
            body: 'Closes #11',
          }),
        },
        emptyTimelineRule(EXT_OWNER, EXT_REPO),
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/commits/[0-9a-f]+/check-runs`,
          stdout: JSON.stringify({ total_count: 0, check_runs: [] }),
        },
      ]);
      const finish = runInstalledSpecgit(wt.worktreeDir, ['finish', '--json'], env(ghMerged));
      expect(finish.status, finish.stderr).toBe(0);
      const finishEnvelope = parseInstalledJson(finish);
      expect(finishEnvelope.verdict.classification).toBe('accepted');
      expect(finishEnvelope.verdict.evidence.context).toEqual({ kind: 'worktree' });
      expect(finishEnvelope.verdict.evidence.branch).toBe(deliveryBranch);

      expect(
        git(wt.bareDir, 'rev-parse', '--verify', `refs/heads/${deliveryBranch}`).trim()
      ).toBe(sha);
    }
  );
});
