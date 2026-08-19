/**
 * Issue #63 — external fixture evidence (PR-level layer).
 *
 * The packed SpecGit package is installed (file:// tarball standing in for
 * the registry) into an UNRELATED npm repository on a `master` default
 * branch. The story proven end to end with deterministic providers:
 *
 *  1. the installed CLI's `init` detects the adopting repo's own check,
 *  2. the generated harness workflow parameterizes `master`, pins the
 *     installed version, and assumes nothing about the adopting stack,
 *  3. the workflow's wait step executes verbatim (through the fake gh seam)
 *     and resolves its `yaml` import from the adopting repo's npm layout,
 *  4. the workflow's finish command executes verbatim and the verdict is
 *     accepted with exit 0.
 *
 * The post-publish layer — a real external repository's green Actions run
 * against the registry-published package — is tracked on the issue; it
 * cannot be produced before the release exists.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  externalAcceptanceWorkflowYaml,
} from '../../src/cli/external-harness.js';
import { ACCEPTANCE_CHECK_NAME, HARNESS_WORKFLOW_PATH } from '../../src/cli/harness-assets.js';
import { createFakeGh, type FakeGhRule } from '../specgit/helpers/fake-gh.js';
import {
  EXT_CHECK,
  EXT_ORIGIN_URL,
  EXT_OWNER,
  EXT_REPO,
  makeExternalRepo,
  npmInstallPacked,
  packSpecgit,
  remoteDefaultBranch,
  rmDir,
  runInstalledSpecgit,
} from './external-repo-fixture.js';

interface WorkflowStep {
  name?: string;
  run?: string;
}

function heredocScript(run: string): string {
  const match = /<<'EOF'\n([\s\S]*)\nEOF/.exec(run);
  if (!match) throw new Error('wait step does not carry a quoted heredoc script');
  return match[1];
}

describe('e2e external repository adoption (#63)', () => {
  const cleanup: string[] = [];

  afterAll(() => {
    for (const dir of cleanup) rmDir(dir);
  });

  it(
    'adopts the packed CLI in an unrelated npm repo and reaches an accepted verdict',
    { timeout: 240_000 },
    async () => {
      const { tarballPath, version } = packSpecgit();
      const fixture = makeExternalRepo('specgit-external-repo-');
      cleanup.push(fixture.dir);

      npmInstallPacked(tarballPath, fixture.dir);
      // The adoption install must not dirty the adopting repository.
      const adoptingPkg = JSON.parse(
        fs.readFileSync(path.join(fixture.dir, 'package.json'), 'utf-8')
      ) as { dependencies?: unknown; devDependencies?: unknown };
      expect(adoptingPkg.dependencies).toBeUndefined();
      expect(adoptingPkg.devDependencies).toBeUndefined();
      const installedPkg = JSON.parse(
        fs.readFileSync(path.join(fixture.dir, 'node_modules', 'specgit', 'package.json'), 'utf-8')
      ) as { version: string };
      expect(installedPkg.version).toBe(version);

      const gh = createFakeGh(fixture.dir, [
        { match: '^--version$', stdout: 'gh version 2.60.0-external-fixture\n' },
        { match: '^auth status', stdout: 'Logged in to github.com as external-fixture\n' },
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
            head: { ref: 'master', sha: fixture.headSha },
            base: { ref: 'master' },
            body: 'Closes #7',
          }),
        },
        {
          match: `^api repos/${EXT_OWNER}/${EXT_REPO}/commits/[0-9a-f]+/check-runs`,
          stdout: JSON.stringify({
            total_count: 2,
            check_runs: [
              { name: EXT_CHECK, status: 'completed', conclusion: 'success' },
              { name: ACCEPTANCE_CHECK_NAME, status: 'completed', conclusion: 'success' },
            ],
          }),
        },
      ] satisfies FakeGhRule[]);
      const env = gh.env({
        GH_TOKEN: 'external-fixture-token',
        XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-external-xdg-')),
      });

      // 1. init via the installed CLI: required checks come from the
      //    adopting repository's own workflow, verbatim.
      const init = runInstalledSpecgit(fixture.dir, ['init', '--no-protect', '--json'], env);
      expect(init.status, init.stderr).toBe(0);
      const initEnvelope = JSON.parse(init.stdout);
      expect(initEnvelope.status).toBe('ok');
      expect(initEnvelope.policy).toEqual({ version: 1, required_checks: [EXT_CHECK] });
      // The wired template selection (#63): an adopting repository gets
      // the portable external template, not the SpecGit-local one.
      expect(initEnvelope.harness).toEqual({ template: 'external' });

      // 2. the default branch is genuinely non-main, and the workflow
      //    init WROTE parameterizes it and pins the installed version.
      const defaultBranch = remoteDefaultBranch(fixture.dir);
      expect(defaultBranch).toBe('master');
      const workflowPath = path.join(fixture.dir, ...HARNESS_WORKFLOW_PATH.split('/'));
      const workflow = fs.readFileSync(workflowPath, 'utf-8');
      expect(workflow).toBe(externalAcceptanceWorkflowYaml({ defaultBranch, version }));
      const parsed = parse(workflow) as {
        on: { pull_request: { branches: string[] } };
        jobs: Record<string, { steps: WorkflowStep[] }>;
      };
      expect(parsed.on.pull_request.branches).toEqual(['master']);
      expect(workflow).toContain(`npm install --no-save --no-audit --no-fund specgit@${version}`);

      const steps = parsed.jobs['specgit-acceptance'].steps;

      // 3. execute the generated wait step verbatim: the script runs from
      //    the adopting repo root, resolves `yaml` from the npm layout the
      //    install step created, and reads checks through the gh seam.
      const waitStep = steps.find((step) => step.name === 'Wait for sibling checks');
      expect(waitStep?.run).toBeDefined();
      const wait = spawnSync(process.execPath, ['--input-type=module'], {
        cwd: fixture.dir,
        input: heredocScript(waitStep!.run!),
        encoding: 'utf-8',
        env: {
          ...env,
          WAIT_REPO: `${EXT_OWNER}/${EXT_REPO}`,
          WAIT_SHA: fixture.headSha,
        },
      });
      expect(wait.status, wait.stderr).toBe(0);
      expect(wait.stdout).toContain('All required checks are in a terminal state.');

      // 4. execute the generated finish command verbatim — the installed
      //    bin, not a SpecGit-repo path.
      const bind = runInstalledSpecgit(
        fixture.dir,
        ['bind', '--delivery', 'external-adoption', '--issue', '7', '--pr', '9', '--json'],
        env
      );
      expect(bind.status, bind.stderr).toBe(0);

      const finishStep = steps.find((step) => step.name === 'specgit finish');
      expect(finishStep?.run).toBe('npx --no-install specgit finish --json');
      const finish = spawnSync(finishStep!.run!, {
        cwd: fixture.dir,
        shell: true,
        encoding: 'utf-8',
        env,
      });
      expect(finish.status, finish.stderr).toBe(0);
      const envelope = JSON.parse(finish.stdout);
      expect(envelope.status).toBe('ok');
      expect(envelope.verdict.classification).toBe('accepted');
      expect(envelope.verdict.evidence.branch).toBe('master');
      expect(fs.existsSync(path.join(fixture.dir, '.specgit.yaml'))).toBe(true);
    }
  );
});
