import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { cliProjectRoot, runCLI } from '../helpers/run-cli.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';
import { createFakeGh } from '../specgit/helpers/fake-gh.js';
import { createFakeGlab } from '../specgit/helpers/fake-glab.js';
import { greenGhRules, OWNER, REPO } from './helpers.js';

describe.each(['github', 'gitlab'] as const)('adopter verification on %s', (platform) => {
  it('runs binding-only planning and acceptance without business commands or adopter dependencies', { timeout: 90_000 }, async () => {
    const temp = makeTempDir('specgit-verification-adopter-');
    try {
      const { root, env } = initRepo(temp);
      const origin = `https://${platform}.com/${OWNER}/${REPO}.git`;
      const bare = path.join(temp, 'origin.git');
      git(root, ['init', '--bare', bare], env);
      git(root, ['remote', 'add', 'origin', origin], env);
      git(root, ['config', `url.${bare}.insteadOf`, origin], env);
      if (platform === 'gitlab') commitFile(root, 'spec_git/providers.yaml', 'gitlab:\n  host: gitlab.com\n', env);
      commitFile(root, 'spec_git/policy.yaml', 'version: 1\nrequired_checks: []\nverification:\n  product_checks: [build, test, deploy]\n  rules: []\n', env);
      // Project-owned wiring consumes the machine plan; the library does not execute these commands.
      commitFile(root, '.ci/business.cjs', `const fs = require('node:fs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (plan.exit !== 0 || !plan.verification) process.exit(3);
for (const name of ['build', 'test', 'deploy']) {
  if (plan.verification.requiredChecks.includes(name)) fs.appendFileSync(process.argv[3], name + '\\n');
}
`, env);
      git(root, ['push', 'origin', 'main'], env);
      git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], env);
      git(root, ['checkout', '-b', 'feature'], env);
      let head = commitFile(root, '.specgit.yaml', 'version: 1\ndelivery: work\ncontext: {kind: branch, branch: feature}\nissues: [7]\npr: 9\n', env);
      const providerEnv = () => {
        if (platform === 'github') return createFakeGh(path.join(temp, 'forge'), greenGhRules({
          sha: head, branch: 'feature', pr: 9, issues: [7], body: 'Closes #7', checks: [{ name: 'SpecGit Acceptance' }],
        })).env(env);
        const project = encodeURIComponent(`${OWNER}/${REPO}`);
        return createFakeGlab(path.join(temp, 'forge'), [
          { match: '^--version$', stdout: 'glab version 1.113.0\n' },
          { match: '^auth status', stdout: 'Logged in\n' },
          { match: `projects/${project}$`, stdout: JSON.stringify({ path_with_namespace: `${OWNER}/${REPO}`, ci_config_path: null }) },
          { match: '/metadata$', stdout: JSON.stringify({ version: '18.3.0', revision: 'test', enterprise: false }) },
          { match: `projects/${project}/issues/7$`, stdout: JSON.stringify({ iid: 7, state: 'opened' }) },
          { match: '/related_merge_requests\\?', stdout: '[]' },
          { match: '/merge_requests/9/notes\\?', stdout: '[]' },
          { match: '/merge_requests/9$', stdout: JSON.stringify({ iid: 9, state: 'opened', draft: false,
            source_branch: 'feature', target_branch: 'main', sha: head, description: 'Closes #7',
            head_pipeline: { id: 100, project_id: 101, sha: head } }) },
          { match: '/pipelines/100/jobs\\?', stdout: JSON.stringify([{ id: 1, name: 'SpecGit Acceptance', status: 'success', allow_failure: false, started_at: '2026-01-01T00:00:00Z' }]) },
        ]).env(env);
      };
      const started = performance.now();
      const planned = await runCLI(['finish', '--plan-checks', '--json'], { cwd: root, env: providerEnv() });
      expect(planned.exitCode, planned.stdout + planned.stderr).toBe(0);
      const decision = JSON.parse(planned.stdout);
      expect(decision.verification.requiredChecks).toEqual([]);
      expect(decision.verification.paths).toMatchObject([{ path: '.specgit.yaml', kind: 'record' }]);
      const waiterPolicy = path.join(temp, 'wait-policy.yaml');
      const prepareWaiter = () => execFileSync(process.execPath,
        [path.join(cliProjectRoot, 'dist/automation/workflow-policy.js')], {
          cwd: root,
          env: { ...process.env, ...providerEnv(), SPECGIT_WAIT_POLICY: waiterPolicy },
          encoding: 'utf8', timeout: 30_000,
        });
      const authoritativePolicy = fs.readFileSync(path.join(root, 'spec_git/policy.yaml'), 'utf8');
      expect(JSON.parse(prepareWaiter()).verification.requiredChecks).toEqual([]);
      expect(YAML.parse(fs.readFileSync(waiterPolicy, 'utf8')).required_checks).toEqual([]);
      expect(fs.readFileSync(path.join(root, 'spec_git/policy.yaml'), 'utf8')).toBe(authoritativePolicy);
      const planPath = path.join(temp, 'plan.json'), callsPath = path.join(temp, 'business-calls');
      fs.writeFileSync(planPath, planned.stdout);
      execFileSync(process.execPath, [path.join(root, '.ci/business.cjs'), planPath, callsPath]);
      expect(fs.existsSync(callsPath)).toBe(false);
      const finished = await runCLI(['finish', '--json'], { cwd: root, env: providerEnv() });
      expect(finished.exitCode, finished.stdout + finished.stderr).toBe(0);
      expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
      const elapsedMs = performance.now() - started;
      console.log(`${platform} binding-only plan + acceptance: ${Math.round(elapsedMs)} ms; business commands=0; adopter dependencies=0`);
      expect(elapsedMs).toBeLessThan(30_000);

      head = commitFile(root, 'app.js', 'export const value = 1;\n', env);
      const mixed = await runCLI(['finish', '--plan-checks', '--json'], { cwd: root, env: providerEnv() });
      expect(mixed.exitCode, mixed.stdout + mixed.stderr).toBe(0);
      expect(JSON.parse(mixed.stdout).verification.requiredChecks).toEqual(['build', 'test', 'deploy']);
      expect(JSON.parse(prepareWaiter()).verification.requiredChecks).toEqual(['build', 'test', 'deploy']);
      expect(YAML.parse(fs.readFileSync(waiterPolicy, 'utf8')).required_checks).toEqual(['build', 'test', 'deploy']);
      expect(fs.readFileSync(path.join(root, 'spec_git/policy.yaml'), 'utf8')).toBe(authoritativePolicy);
      fs.writeFileSync(planPath, mixed.stdout);
      execFileSync(process.execPath, [path.join(root, '.ci/business.cjs'), planPath, callsPath]);
      expect(fs.readFileSync(callsPath, 'utf8')).toBe('build\ntest\ndeploy\n');
      const missing = await runCLI(['finish', '--json'], { cwd: root, env: providerEnv() });
      expect(missing.exitCode, missing.stdout + missing.stderr).toBe(1);
      expect(JSON.parse(missing.stdout).errors.map((error: { code: string }) => error.code)).toContain('checks_missing');
    } finally { rmDir(temp); }
  });
});
