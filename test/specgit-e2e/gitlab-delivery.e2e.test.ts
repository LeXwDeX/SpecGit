/**
 * Issue #117 — the GitLab variant of the external-adoption e2e.
 *
 * The SAME delivery story as the GitHub e2e, on a declared nested-group
 * self-managed GitLab origin, entirely offline:
 *
 *  1. the installed CLI's `init --gitlab-host` declares the platform in
 *     spec_git/providers.yaml, detects the required check from the
 *     adopting repo's own .gitlab-ci.yml, and writes NO GitHub Actions
 *     workflow (wrong-platform output; gitlab_harness_pending warns);
 *  2. `specgit issue` bootstraps through the fake glab seam — issue
 *     creation, draft MR creation with the `Draft: ` title prefix, the
 *     deterministic scaffold body, a real branch push into the bare
 *     remote;
 *  3. `specgit finish` derives the verdict from GitLab-shaped evidence
 *     (recorded payload shapes from test/specgit-e2e/fixtures/gitlab,
 *     pinned to the local delivery state) and ACCEPTS with exit 0, all
 *     eleven gates green, the closing refs parsed with the GitLab
 *     dialect;
 *  4. gh is unreachable by construction (PATH carries git and the fake
 *     glab only): a routing regression fails closed instead of ever
 *     touching a GitHub account.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { renderPrScaffold } from '../../src/github/pr-scaffold.js';
import { createFakeGlab } from '../specgit/helpers/fake-glab.js';
import {
  GITLAB_CHECK,
  GITLAB_HOST,
  GITLAB_ORIGIN_URL,
  gitAndGlabOnlyPath,
  makeGitlabExternalRepo,
  npmInstallPacked,
  packSpecgit,
  rmDir,
  runInstalledSpecgit,
} from './external-repo-fixture.js';
import { gitOnlyPathDir } from './helpers.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'gitlab'
);

/** Clone a recorded payload shape and pin the local delivery state onto it. */
function payload(rel: string, overrides: Record<string, unknown>): string {
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, ...rel.split('/')), 'utf-8')) as Record<
    string,
    unknown
  >;
  return JSON.stringify({ ...base, ...overrides });
}

interface FakeGlabCall {
  args: string;
  stdin?: string;
}

function readCalls(logPath: string): FakeGlabCall[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeGlabCall);
}

describe('e2e GitLab delivery on a nested-group origin (#117)', () => {
  const cleanup: string[] = [];

  afterAll(() => {
    for (const dir of cleanup) rmDir(dir);
  });

  it(
    'adopts the packed CLI on a declared GitLab origin and reaches an accepted verdict through glab',
    { timeout: 300_000 },
    async () => {
      const { tarballPath } = await packSpecgit();
      const fixture = makeGitlabExternalRepo('specgit-gitlab-e2e-');
      cleanup.push(fixture.dir, fixture.bareDir);
      await npmInstallPacked(tarballPath, fixture.dir);

      // The sandbox: git and the fake glab on PATH, nothing else — no
      // gh exists for a routing bug to reach.
      const gitOnly = gitOnlyPathDir(fixture.dir);
      const project = 'specgit-evidence%2Fprobe%2Fapp';
      const api = (endpoint: string) =>
        `^api --hostname ${GITLAB_HOST} ${endpoint}`;

      // ---- Phase 1: init declares the platform and detects .gitlab-ci.yml.
      // repoDir makes the double enforce GitLab's real constraint (#270):
      // MR creation for a branch never pushed to the bare remote is a 400,
      // so this bootstrap doubles as the push-before-MR ordering guard.
      const bootstrapGlab = createFakeGlab(fixture.dir, [
        { match: '^--version$', stdout: 'glab version 1.113.0-fake\n' },
        { match: `^auth status --hostname ${GITLAB_HOST}$`, stdout: 'Logged in\n' },
        { match: api('/metadata$'), stdout: payload('nested/metadata.json', {}) },
        {
          match: api(`projects/${project}/issues\\?state=opened&per_page=100&page=1$`),
          stdout: '[]',
        },
        {
          match: `^api --hostname ${GITLAB_HOST} -X POST projects/${project}/issues`,
          stdout: payload('probe-project/tp_issue.json', { iid: 7, state: 'opened' }),
        },
        {
          match: api(
            `projects/${project}/merge_requests\\?state=opened&source_branch=[^&]*&per_page=30$`
          ),
          stdout: '[]',
        },
        {
          match: `^api --hostname ${GITLAB_HOST} -X POST projects/${project}/merge_requests`,
          stdout: payload('probe-project/tp_mr.json', {
            iid: 9,
            state: 'opened',
            draft: true,
            work_in_progress: true,
            source_branch: 'feat/7-gitlab-delivery-story',
          }),
        },
      ], { repoDir: fixture.bareDir });
      cleanup.push(bootstrapGlab.binDir);
      const sandboxEnv = (extra?: NodeJS.ProcessEnv) =>
        bootstrapGlab.env({
          ...(extra ?? {}),
          PATH: gitAndGlabOnlyPath(gitOnly, bootstrapGlab.binDir),
          Path: gitAndGlabOnlyPath(gitOnly, bootstrapGlab.binDir),
        });

      const init = runInstalledSpecgit(
        fixture.dir,
        ['init', '--gitlab-host', GITLAB_HOST, '--no-protect', '--json'],
        sandboxEnv()
      );
      expect(init.status, init.stderr).toBe(0);
      const initEnvelope = JSON.parse(init.stdout);
      expect(initEnvelope.platform).toEqual({ mode: 'gitlab', gitlabHost: GITLAB_HOST });
      expect(initEnvelope.policy).toEqual({ version: 1, required_checks: [GITLAB_CHECK] });
      expect(initEnvelope.detected.sources).toEqual(['.gitlab-ci.yml']);
      expect(initEnvelope.harness).toEqual({ template: 'gitlab-pending' });
      expect(
        initEnvelope.warnings.some((w: { code: string }) => w.code === 'gitlab_harness_pending')
      ).toBe(true);
      expect(fs.existsSync(path.join(fixture.dir, '.github', 'workflows', 'specgit-accept.yml'))).toBe(
        false
      );
      expect(fs.readFileSync(path.join(fixture.dir, 'spec_git', 'providers.yaml'), 'utf-8')).toContain(
        'git.ycgame.com'
      );

      // ---- Phase 2: the one-command bootstrap creates the issue and the
      // draft MR through glab and pushes the branch.
      const issue = runInstalledSpecgit(
        fixture.dir,
        ['issue', 'feat: gitlab delivery story', '--json'],
        sandboxEnv()
      );
      expect(issue.status, issue.stderr).toBe(0);
      const issueEnvelope = JSON.parse(issue.stdout);
      expect(issueEnvelope.record).toMatchObject({
        issues: [7],
        pr: 9,
        context: { kind: 'branch', branch: 'feat/7-gitlab-delivery-story' },
      });

      // The MR create call: REST POST with the Draft: title prefix
      // (ledger row 18) and the deterministic scaffold as description.
      const createMr = readCalls(bootstrapGlab.logPath).find(
        (call) => call.args.includes('-X POST') && call.args.includes('merge_requests')
      );
      expect(createMr).toBeDefined();
      const createArgs = createMr!.args;
      expect(createArgs).toContain('-f title=Draft: feat: gitlab delivery story');
      expect(createArgs).toContain(`-f source_branch=feat/7-gitlab-delivery-story`);
      expect(createArgs).toContain('-f target_branch=main');
      const description = /-f description=([\s\S]*)$/.exec(createArgs);
      expect(description?.[1]).toBe(renderPrScaffold([7]));

      // ---- Phase 3: the human marks the MR ready out of band; finish
      // accepts from GitLab-shaped evidence pinned to the branch tip.
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture.dir,
        encoding: 'utf-8',
      }).trim();
      const readyGlab = createFakeGlab(fixture.dir, [
        { match: '^--version$', stdout: 'glab version 1.113.0-fake\n' },
        { match: `^auth status --hostname ${GITLAB_HOST}$`, stdout: 'Logged in\n' },
        { match: api('/metadata$'), stdout: payload('nested/metadata.json', {}) },
        { match: api(`projects/${project}/issues/7$`), stdout: payload('probe-project/tp_issue.json', { iid: 7, state: 'opened' }) },
        {
          match: api(`projects/${project}/merge_requests/9$`),
          stdout: payload('probe-project/tp_mr.json', {
            iid: 9,
            state: 'opened',
            draft: false,
            work_in_progress: false,
            source_branch: 'feat/7-gitlab-delivery-story',
            sha: headSha,
            description: renderPrScaffold([7]),
          }),
        },
        {
          match: api(`projects/${project}/pipelines\\?sha=${headSha}&order_by=updated_at&sort=desc&per_page=11&page=1$`),
          stdout: `[${payload('probe-project/tp_pipeline2_detail.json', {
            sha: headSha,
            status: 'success',
          })}]`,
        },
        {
          match: api(`projects/${project}/pipelines/29616/jobs\\?per_page=100&page=1$`),
          stdout: `[${payload('probe-project/tp_job.json', {
            name: GITLAB_CHECK,
            status: 'success',
            started_at: '2026-08-21T05:00:00Z',
            allow_failure: false,
          })}]`,
        },
      ]);
      cleanup.push(readyGlab.binDir);
      const finishEnv = readyGlab.env({
        PATH: gitAndGlabOnlyPath(gitOnly, readyGlab.binDir),
        Path: gitAndGlabOnlyPath(gitOnly, readyGlab.binDir),
      });

      const finish = runInstalledSpecgit(fixture.dir, ['finish', '--json'], finishEnv);
      expect(finish.status, finish.stderr).toBe(0);
      const envelope = JSON.parse(finish.stdout);
      expect(envelope.status).toBe('ok');
      expect(envelope.verdict.classification).toBe('accepted');
      expect(envelope.verdict.evidence.repo).toBe('specgit-evidence/probe/app');
      expect(envelope.verdict.evidence.issues).toEqual([7]);
      expect(envelope.verdict.evidence.pr).toBe(9);
      expect(envelope.verdict.evidence.branch).toBe('feat/7-gitlab-delivery-story');
      const gates = envelope.verdict.gates as Array<{ id: string; status: string }>;
      expect(gates.map((gate) => gate.id)).toEqual([
        'record',
        'policy',
        'completeness',
        'context',
        'origin',
        'provider',
        'issues',
        'sequence',
        'pr',
        'closing',
        'checks',
      ]);
      for (const gate of gates) {
        expect(gate.status, `gate ${gate.id} should pass`).toBe('pass');
      }

      // The verdict came from glab alone: every recorded call in the
      // finish phase is the glab CLI (host-scoped api or its own
      // auth/version probes) — and no gh binary was ever reachable.
      const finishCalls = readCalls(readyGlab.logPath).map((call) => call.args);
      expect(finishCalls.length).toBeGreaterThan(0);
      for (const call of finishCalls) {
        expect(
          call.startsWith(`api --hostname ${GITLAB_HOST}`) ||
            call === '--version' ||
            call.startsWith('auth status')
        ).toBe(true);
      }
    }
  );
});
