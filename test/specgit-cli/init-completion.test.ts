import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { inspectGeneratedAssets } from '../../src/cli/asset-drift.js';
import { completionWorkflowYaml, COMPLETION_WORKFLOW_PATH, GITLAB_COMPLETION_WORKFLOW_PATH } from '../../src/cli/completion-workflow.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { parseRepoRef } from '../../src/gitfacts/origin.js';
import { makeCtx, makeGitFacts } from './helpers.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

describe('source completion scheduling', () => {
  it('only admits PR CI and explicit acceptance signals before assigning a runner', () => {
    const workflow = parse(completionWorkflowYaml({ defaultBranch: 'main', version: '1.15.1', selfHosted: true }));
    const allows = new Function('github', `return (${workflow.jobs.identify.if});`);
    const signal = (name: string, event: string) => ({ ref: 'refs/heads/main', event_name: 'workflow_run', event: { workflow_run: { name, event } } });
    expect(allows(signal('CI', 'pull_request'))).toBe(true);
    for (const event of ['workflow_dispatch', 'push', 'merge_group']) expect(allows(signal('CI', event))).toBe(false);
    expect(allows(signal('SpecGit Acceptance', 'pull_request'))).toBe(true);
    expect(allows(signal('Unrelated', 'pull_request'))).toBe(false);
    expect(allows({ ref: 'refs/heads/other', event_name: 'workflow_dispatch' })).toBe(false);
    expect(allows({ ref: 'refs/heads/main', event_name: 'workflow_dispatch' })).toBe(true);
    expect(workflow.jobs.complete.needs).toBe('identify');
    const external = parse(completionWorkflowYaml({ defaultBranch: 'main', version: '1.15.1', selfHosted: false }));
    expect(external.jobs.complete.permissions.actions).toBe('read');
    expect(external.jobs.complete.steps.find((step: { name?: string }) => step.name === 'Complete the bound delivery').run).not.toContain('--single-pass');
  });
});

describe('completion scope preserves the original request', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-completion-scope-'); });
  afterEach(() => { rmDir(root); });

  function classifyRequest(options: { merged?: boolean; files?: unknown[]; after?: Record<string, unknown>; count?: number; pages?: unknown[] } = {}) {
    const repo = initRepo(root);
    const base = git(repo.root, ['rev-parse', 'HEAD'], repo.env).trim();
    git(repo.root, ['checkout', '-b', 'product-change'], repo.env);
    const head = commitFile(repo.root, 'src/product.ts', 'export const product = true;\n', repo.env);
    git(repo.root, ['checkout', 'main'], repo.env);
    if (options.merged !== false) git(repo.root, ['merge', '--no-ff', 'product-change', '-m', 'Merge product change'], repo.env);
    const files = options.files ?? [{ filename: 'src/product.ts', status: 'added' }];
    const before = { number: 437, head: { sha: head }, base: { sha: base }, changed_files: options.count ?? files.length };
    const responses = { before, after: { ...before, ...options.after }, pages: options.pages ?? [files] };
    const fixture = path.join(root, 'github-responses.json');
    fs.writeFileSync(fixture, JSON.stringify(responses));
    fs.mkdirSync(path.join(root, 'specgit-runtime/scripts'), { recursive: true });
    for (const file of ['ci-change-scope.mjs', 'ci-changesets.mjs']) {
      fs.copyFileSync(path.resolve('scripts', file), path.join(root, 'specgit-runtime/scripts', file));
    }
    const workflow = parse(completionWorkflowYaml({ defaultBranch: 'main', version: '1.12.0', selfHosted: true }));
    const step = workflow.jobs.complete.steps.find((item: { id?: string }) => item.id === 'scope');
    const script = step.run.replace("import { execFileSync } from 'node:child_process';", `
      import { readFileSync as readFixture } from 'node:fs';
      const fixture = JSON.parse(readFixture(process.env.SPECGIT_SCOPE_FIXTURE, 'utf8'));
      let reads = 0;
      const execFileSync = (command, args) => {
        if (command !== 'gh' || args[0] !== 'api') throw new Error('Unexpected external command');
        const endpoint = args[1];
        if (endpoint === 'repos/owner/repo/pulls/437') return JSON.stringify(reads++ === 0 ? fixture.before : fixture.after);
        const match = /^repos\\/owner\\/repo\\/pulls\\/437\\/files\\?per_page=100&page=(\\d+)$/.exec(endpoint);
        if (!match) throw new Error('Unexpected API endpoint: ' + endpoint);
        return JSON.stringify(fixture.pages[Number(match[1]) - 1] ?? []);
      };
    `);
    const output = path.join(root, 'scope-output');
    // Execute the same script file boundary as Actions. On Windows, passing
    // source through bash -c makes MSYS consume pairs of regex backslashes.
    const scriptFile = path.join(root, 'scope-step.sh');
    fs.writeFileSync(scriptFile, script, 'utf8');
    const run = spawnSync('bash', ['-e', scriptFile.split(path.sep).join('/')], { cwd: repo.root, encoding: 'utf8', env: {
      ...process.env, ...repo.env, REQUEST_PR: '437', REQUEST_HEAD: head,
      GITHUB_REPOSITORY: 'owner/repo', GITHUB_OUTPUT: output, SPECGIT_SCOPE_FIXTURE: fixture,
    } });
    return { ...run, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' };
  }

  it('retains product scope after the request head is already merged into the trusted checkout', () => {
    const result = classifyRequest();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('build=true\n');
  });

  it('classifies an open product request from the same authenticated evidence', () => {
    const result = classifyRequest({ merged: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('build=true\n');
  });

  it.each([
    ['configuration', [{ filename: 'spec_git/policy.yaml', status: 'modified' }], false],
    ['deleted documentation', [{ filename: 'docs/obsolete.md', status: 'removed' }], false],
    ['deleted local state', [{ filename: '.local/cache.json', status: 'removed' }], false],
    ['deleted source', [{ filename: 'src/obsolete.ts', status: 'removed' }], true],
    ['source renamed into documentation', [{ filename: 'docs/example.md', previous_filename: 'src/product.ts', status: 'renamed' }], true],
  ])('preserves %s scope after merge', (_name, files, build) => {
    const result = classifyRequest({ files });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(`build=${build}\n`);
  });

  it('reads the page containing the final product file before deciding scope', () => {
    const docs = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md`, status: 'modified' }));
    const result = classifyRequest({ count: 101, pages: [docs, [{ filename: 'src/product.ts', status: 'modified' }]] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('build=true\n');
  });

  it('accepts exactly the documented file limit only with matching complete evidence', () => {
    const pages = Array.from({ length: 30 }, (_, page) => Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${page}-${i}.md`, status: 'modified' })));
    const result = classifyRequest({ count: 3000, pages });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('build=false\n');
  });

  it.each([
    ['head moved', { after: { head: { sha: 'b'.repeat(40) } } }],
    ['base moved', { after: { base: { sha: 'c'.repeat(40) } } }],
    ['request changed', { after: { number: 438 } }],
    ['count changed', { after: { changed_files: 2 } }],
    ['truncated files', { count: 2 }],
    ['API limit exceeded', { count: 3001 }],
    ['invalid count', { count: -1 }],
    ['non-array page', { pages: [{ files: [] }] }],
    ['duplicate files', { files: [{ filename: 'docs/a.md', status: 'modified' }, { filename: 'docs/a.md', status: 'modified' }] }],
    ['missing previous path', { files: [{ filename: 'docs/a.md', status: 'renamed' }] }],
    ['unknown status', { files: [{ filename: 'docs/a.md', status: 'unknown' }] }],
    ['unsafe path', { files: [{ filename: '../docs/a.md', status: 'modified' }] }],
    ['backslash path', { files: [{ filename: 'src\\product.ts', status: 'modified' }] }],
    ['control character path', { files: [{ filename: 'docs/control\u0001.md', status: 'modified' }] }],
    ['missing file', { files: [null] }],
    ['local state added', { files: [{ filename: '.local/cache.json', status: 'added' }] }],
  ])('fails before emitting a classification when %s', (_name, options) => {
    const result = classifyRequest(options);
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.output).toBe('');
  });
});

describe('completion runtime dependency installation', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-runtime-install-'); });
  afterEach(() => { rmDir(root); });

  function selectRuntime(options: {
    selfHosted: boolean; product: boolean; failure?: 'install' | 'build';
    protocol?: number; singlePass?: boolean | 'missing';
  }) {
    const source = path.join(root, 'specgit-runtime');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '2.0.0', type: 'module', private: true }));
    const workflow = parse(completionWorkflowYaml({ defaultBranch: 'main', version: '1.15.1', selfHosted: options.selfHosted }));
    const step = workflow.jobs.complete.steps.find((item: { id?: string }) => item.id === 'runtime');
    const commands = path.join(root, 'commands.jsonl');
    const output = path.join(root, 'output');
    const script = step.run.replace(/^node --input-type=module <<'NODE'\n/, '').replace(/\nNODE\s*$/, '')
      .replace("import { execFileSync } from 'node:child_process';", `
        import * as fixtureFs from 'node:fs';
        import * as fixturePath from 'node:path';
        const writeRuntime = (directory) => {
          fixtureFs.mkdirSync(fixturePath.join(directory, 'dist/automation'), { recursive: true });
          fixtureFs.writeFileSync(fixturePath.join(directory, 'package.json'), '{"type":"module"}');
          fixtureFs.writeFileSync(fixturePath.join(directory, 'dist/automation/remote-delivery.js'),
            'export const REMOTE_DELIVERY_PROTOCOL = ' + process.env.FIXTURE_PROTOCOL + ';');
          if (process.env.FIXTURE_SINGLE_PASS !== 'missing') fixtureFs.writeFileSync(
            fixturePath.join(directory, 'dist/automation/remote-entry.js'),
            'export const REMOTE_ENTRY_SINGLE_PASS = ' + process.env.FIXTURE_SINGLE_PASS + ';');
        };
        const execFileSync = (command, args, options) => {
          fixtureFs.appendFileSync(process.env.FIXTURE_COMMANDS, JSON.stringify({ command, args, cwd: options.cwd }) + '\\n');
          if (command === 'npm' || (command === 'pnpm' && args[0] === 'install')) {
            if (process.env.FIXTURE_FAILURE === 'install') throw new Error('Fixture install failed');
            if (command === 'npm') writeRuntime(fixturePath.join(args[args.indexOf('--prefix') + 1], 'node_modules/specgit'));
          } else if (command === process.execPath && args.length === 1 && args[0] === 'build.js') {
            if (process.env.FIXTURE_FAILURE === 'build') throw new Error('Fixture build failed');
            writeRuntime(options.cwd);
          } else throw new Error('Unexpected command');
        };
      `);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: {
      ...process.env, PRODUCT_CHANGE: String(options.product), FIXTURE_FAILURE: options.failure ?? '',
      FIXTURE_PROTOCOL: String(options.protocol ?? 2), FIXTURE_SINGLE_PASS: String(options.singlePass ?? true), FIXTURE_COMMANDS: commands,
      GITHUB_WORKSPACE: root, RUNNER_TEMP: path.join(root, 'runner'), GITHUB_OUTPUT: output,
    } });
    const calls = fs.readFileSync(commands, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { command: string; args: string[]; cwd?: string });
    return { ...result, source, calls, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' };
  }

  describe.each([false, true])('product change = %s', (product) => {
    it.each([
      ['compatible registry runtime', undefined, 2, true],
      ['registry unavailable', 'install', 2, false],
      ['incompatible registry protocol', undefined, 1, false],
    ] as const)('legacy adopter: %s never compiles adopter source', (_name, failure, protocol, success) => {
      const result = selectRuntime({ selfHosted: false, product, failure, protocol, singlePass: 'missing' });
      expect(result.status, result.stderr).toBe(success ? 0 : 1);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toEqual({ command: 'npm', args: [
        'install', '--prefix', path.join(root, 'runner') + '/specgit-runtime', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', 'specgit@1.15.1',
      ] });
      if (success) expect(result.output).toBe('directory=' + path.join(root, 'runner') + '/specgit-runtime/node_modules/specgit\n');
      else expect(result.output).toBe('');
    });

    it.each([
      ['compatible source', undefined, 2, true, true],
      ['dependency install failure', 'install', 2, true, false],
      ['source build failure', 'build', 2, true, false],
      ['incompatible source protocol', undefined, 1, true, false],
      ['missing single-pass support', undefined, 2, false, false],
      ['missing entry module', undefined, 2, 'missing', false],
    ] as const)('selfHosted: %s cannot fall back to a public package', (_name, failure, protocol, singlePass, success) => {
      const result = selectRuntime({ selfHosted: true, product, failure, protocol, singlePass });
      expect(result.status, result.stderr).toBe(success ? 0 : 1);
      expect(result.calls[0].command).toBe('pnpm');
      expect(result.calls[0].args).toEqual(['install', '--frozen-lockfile', '--ignore-scripts']);
      expect(result.calls).toHaveLength(failure === 'install' ? 1 : 2);
      for (const call of result.calls) expect(path.normalize(call.cwd ?? '')).toBe(result.source);
      if (failure !== 'install') expect(result.calls[1]).toMatchObject({ command: process.execPath, args: ['build.js'] });
      expect(result.calls.some((call) => call.command === 'npm')).toBe(false);
      if (success) expect(result.output).toBe('directory=' + root + '/specgit-runtime\n');
      else expect(result.output).toBe('');
    });
  });
});

describe('configured completion installation', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-init-completion-'); });
  afterEach(() => { rmDir(root); });
  const options = { requiredCheck: ['test'], protect: false, automation: 'yes', mergeTarget: 'Dev' };
  it.each([null, '.gitlab-ci.yml', 'ci/custom.yml'])('proves GitLab ci_config_path %j before writing on a fresh custom host', async (configuration) => {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'test:\n  script: echo test\n');
    const t = makeCtx({ root: ok(root), facts: makeGitFacts({ originUrl: 'https://git.example.com:8443/owner/repo.git' }) });
    const getCiConfigPath = vi.fn(async () => {
      expect(fs.readdirSync(root)).toEqual(['.gitlab-ci.yml']);
      return ok(configuration);
    });
    Object.assign(t.ghProvider, { getCiConfigPath });
    t.ctx.withGitlabHost = vi.fn((gitlabHost) => ({
      parseRepoRef: (origin: string) => parseRepoRef(origin, { gitlabHost }), gh: t.ghProvider,
    }));
    const outcome = await runInit({ ...options, gitlabHost: 'git.example.com:8443' }, t.ctx);
    expect(outcome.exit).toBe(configuration === 'ci/custom.yml' ? 2 : 0);
    expect(getCiConfigPath).toHaveBeenCalledOnce();
    expect(t.ctx.withGitlabHost).toHaveBeenCalledWith('git.example.com:8443');
    if (outcome.exit !== 0) {
      expect(outcome.errors?.[0]?.code).toBe('gitlab_ci_config_unsupported');
      expect(fs.readdirSync(root)).toEqual(['.gitlab-ci.yml']);
      expect(t.recordPort.policyWrites).toEqual([]);
    }
  });
  it.each(['github', 'gitlab'] as const)('installs %s completion only with configured authorization and refreshes by the same desired state', async (platform) => {
    if (platform === 'gitlab') fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo business\n');
    const facts = makeGitFacts({ originUrl: platform === 'github' ? 'git@github.com:owner/repo.git' : 'git@gitlab.com:owner/repo.git' });
    const t = makeCtx({ root: ok(root), facts, gitWrites: { remoteDefaultBranch: () => ok('trunk') },
      parseRepoRef: (url) => parseRepoRef(url, { gitlabHost: 'gitlab.com' }),
    });
    const getCiConfigPath = vi.fn(async () => ok(null));
    Object.assign(t.ghProvider, { getCiConfigPath });
    const result = await runInit(options, t.ctx);
    expect(result.exit).toBe(0);
    const location = platform === 'github' ? COMPLETION_WORKFLOW_PATH : GITLAB_COMPLETION_WORKFLOW_PATH;
    expect(result.reconciled?.created).toContain(location);
    const bytes = fs.readFileSync(path.join(root, location), 'utf8');
    expect(bytes).toContain('trunk');
    expect(bytes).toContain(`specgit@${t.ctx.version}`);
    expect(bytes).toContain('remote-entry.js');
    const report = await inspectGeneratedAssets({ root, ctx: t.ctx, facts, policy: ok(result.policy!) });
    expect(getCiConfigPath).toHaveBeenCalledTimes(platform === 'gitlab' ? 1 : 0);
    expect(report.surfaces.find((surface) => surface.surface === 'init')?.assets)
      .toContainEqual({ path: location, state: 'current' });
    const refresh = makeCtx({ root: ok(root), facts, policy: result.policy!, gitWrites: { remoteDefaultBranch: () => ok('trunk') } });
    const disabled = await runInit({ force: true, protect: false, automation: 'no' }, refresh.ctx);
    expect(disabled.exit).toBe(0);
    expect(disabled.reconciled?.removed).toContain(location);
    expect(fs.existsSync(path.join(root, location))).toBe(false);
  });

  it('rejects an unproven default branch before writes even when the merge target is explicit', async () => {
    const t = makeCtx({ root: ok(root), gitWrites: {
      remoteDefaultBranch: () => fail('git_default_branch_unknown', 'No origin HEAD'),
    } });
    const result = await runInit(options, t.ctx);
    expect(result.exit).toBe(3);
    expect(result.errors?.[0]?.code).toBe('automation_default_branch_unknown');
    expect(fs.readdirSync(root)).toEqual([]);
    expect(t.recordPort.policyWrites).toEqual([]);
  });

  it('preserves an unowned completion workflow and refuses an authorized collision before writes', async () => {
    const target = path.join(root, COMPLETION_WORKFLOW_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'name: User completion\n');
    const t = makeCtx({ root: ok(root) });
    const refused = await runInit(options, t.ctx);
    expect(refused.exit).toBe(3);
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('name: User completion\n');
    const disabled = await runInit({ ...options, automation: 'no' }, t.ctx);
    expect(disabled.exit).toBe(0);
    expect(disabled.reconciled?.preserved).toContain(COMPLETION_WORKFLOW_PATH);
    expect(fs.readFileSync(target, 'utf8')).toBe('name: User completion\n');
  });
});
