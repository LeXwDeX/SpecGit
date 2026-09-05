import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci-change-scope.mjs', import.meta.url));
const classify = (paths: string[]) => JSON.parse(execFileSync(process.execPath, [
  '--input-type=module', '-e',
  `import { classifyPaths } from ${JSON.stringify(new URL('../../scripts/ci-change-scope.mjs', import.meta.url).href)}; console.log(JSON.stringify(classifyPaths(JSON.parse(process.argv[1]))));`,
  JSON.stringify(paths),
], { encoding: 'utf8' })) as { build: boolean; metadata: boolean; nix: boolean; dependencies: boolean };

describe('CI change impact', () => {
  it.each([
    '.gitignore', '.specgit.yaml', 'spec_git/policy.yaml', 'spec_git/providers.yaml',
    'README.md', 'docs/cli.md', 'docs/路径含空格 test.md', 'AGENTS.md',
    '.agents/skills/specgit-finish/SKILL.md', '.opencode/command/specgit-issue.md',
    '.changeset/fresh-change.md', '.github/workflows/README.md',
    '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/ISSUE_TEMPLATE/bug_report.md',
    '.changeset/config.json', '.coderabbit.yaml', '.github/dependabot.yml',
  ])('keeps %s on the metadata route', (file) => {
    expect(classify([file])).toMatchObject({ build: false, metadata: true });
  });

  it.each([
    'src/cli/harness-content.ts', 'src/cli/agent-surface.ts', 'bin/specgit.js',
    'schemas/specgit/templates/specgit-policy.yaml', 'skills/specgit-issue/SKILL.md',
    'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'test/example.test.ts',
    '.github/workflows/ci.yml', '.github/workflows/specgit-accept.yml',
    '.github/workflows/specgit-complete.yml', '.github/workflows/release-prepare.yml',
    '.github/workflows/rc-verify.yml', '.github/workflows/security.yml',
    'scripts/ci-change-scope.mjs', 'new-runtime/file.xyz',
    '.local/state/gh/device-id', 'docs/executable.js', '.agents/unknown/script.sh',
    '.devcontainer/devcontainer.json', '.opencode/hooks.json',
  ])('requires complete verification for %s', (file) => {
    expect(classify([file])).toMatchObject({ build: true, metadata: false });
  });

  it('never lets an ignore rule or metadata file hide a mixed source change', () => {
    expect(classify(['.gitignore', 'docs/cli.md', 'src/index.ts']).build).toBe(true);
  });

  it('selects dependency and Nix checks from their actual inputs', () => {
    expect(classify(['pnpm-lock.yaml'])).toMatchObject({ dependencies: true, nix: true });
    expect(classify(['.github/dependabot.yml'])).toMatchObject({
      build: false, metadata: true, dependencies: true,
    });
    expect(classify(['src/index.ts'])).toMatchObject({ dependencies: false });
    expect(classify(['flake.nix'])).toMatchObject({ nix: true });
  });

  it('rejects paths outside the repository rather than granting an exemption', () => {
    expect(classify(['../README.md']).build).toBe(true);
    expect(classify(['docs/ambiguous\tname.md']).build).toBe(true);
  });
});

describe('complete Git diff classification', () => {
  function withRepo(run: (root: string, base: string, git: (...args: string[]) => string) => void) {
    const root = mkdtempSync(path.join(tmpdir(), 'specgit-ci-scope-'));
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    }).trim();
    try {
      git('init', '-q');
      git('config', 'user.name', 'CI scope test');
      git('config', 'user.email', 'ci@example.invalid');
      writeFileSync(path.join(root, 'package.json'), '{"name":"specgit","version":"1.12.0"}\n');
      mkdirSync(path.join(root, 'src'));
      writeFileSync(path.join(root, 'src', 'entry.ts'), 'export const value = 1;\n');
      git('add', '.'); git('commit', '-qm', 'baseline');
      run(root, git('rev-parse', 'HEAD'), git);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('proves metadata applicability without relying on tracked ignore patterns', () => withRepo((root, base, git) => {
    writeFileSync(path.join(root, '.gitignore'), 'src/\n');
    git('add', '.gitignore'); git('commit', '-qm', 'ignore only');
    const run = spawnSync(process.execPath, [script, '--base', base, '--head', 'HEAD', '--assert-metadata'], { cwd: root, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ build: false, metadata: true, release_intent: false });
    writeFileSync(path.join(root, 'src', 'entry.ts'), 'export const value = 2;\n');
    git('add', '-u'); git('commit', '-qm', 'tracked source despite ignore');
    const mixed = spawnSync(process.execPath, [script, '--base', base, '--head', 'HEAD', '--assert-metadata'], { cwd: root, encoding: 'utf8' });
    expect(mixed.status).toBe(1);
  }));

  it('includes the old source path when a source file is renamed into documentation', () => withRepo((root, base, git) => {
    mkdirSync(path.join(root, 'docs'));
    git('mv', 'src/entry.ts', 'docs/example.md'); git('commit', '-qm', 'rename');
    const result = JSON.parse(execFileSync(process.execPath, [script, '--base', base, '--head', 'HEAD'], { cwd: root, encoding: 'utf8' }));
    expect(result.build).toBe(true);
    expect(result.paths).toContain('src/entry.ts');
  }));

  it('requires product verification when a source file is deleted', () => withRepo((root, base, git) => {
    git('rm', '-q', 'src/entry.ts'); git('commit', '-qm', 'delete source');
    const result = JSON.parse(execFileSync(
      process.execPath,
      [script, '--base', base, '--head', 'HEAD'],
      { cwd: root, encoding: 'utf8' }
    ));
    expect(result).toMatchObject({ build: true, metadata: false });
    expect(result.paths).toContain('src/entry.ts');
  }));

  it('recognizes version changes as release intent and not ordinary metadata pushes', () => withRepo((root, base, git) => {
    writeFileSync(path.join(root, 'package.json'), '{"name":"specgit","version":"1.12.1"}\n');
    git('add', '.'); git('commit', '-qm', 'version');
    const result = JSON.parse(execFileSync(process.execPath, [script, '--base', base, '--head', 'HEAD'], { cwd: root, encoding: 'utf8' }));
    expect(result).toMatchObject({ build: true, release_intent: true });
  }));

  it('validates changeset frontmatter with the locked parser and no product build', () => withRepo((root, base, git) => {
    mkdirSync(path.join(root, '.changeset'));
    const note = path.join(root, '.changeset', 'fix.md');
    writeFileSync(note, '---\n"specgit": patch\n---\nFix delivery scope.\n');
    git('add', '.'); git('commit', '-qm', 'changeset');
    const good = spawnSync(process.execPath, [script, '--base', base, '--head', 'HEAD', '--assert-metadata'], { cwd: root, encoding: 'utf8' });
    expect(good.status, good.stderr).toBe(0);
    expect(JSON.parse(good.stdout)).toMatchObject({ build: false, release_intent: true });
    writeFileSync(note, readFileSync(note, 'utf8').replace('patch', 'unknown'));
    git('add', '.'); git('commit', '-qm', 'bad changeset');
    const bad = spawnSync(process.execPath, [script, '--base', base, '--head', 'HEAD'], { cwd: root, encoding: 'utf8' });
    expect(bad.status).toBe(1);
  }));

  it('fails closed when an explicit diff cannot be gathered', () => withRepo((root) => {
    const run = spawnSync(process.execPath, [script, '--base', 'missing-ref', '--head', 'HEAD'], { cwd: root, encoding: 'utf8' });
    expect(run.status).toBe(1);
  }));

  it('keeps an empty changeset as metadata without a release intent', () => withRepo((root, base, git) => {
    mkdirSync(path.join(root, '.changeset'));
    writeFileSync(path.join(root, '.changeset', 'docs.md'), '---\n---\nDocumentation only.\n');
    git('add', '.'); git('commit', '-qm', 'empty changeset');
    const result = spawnSync(process.execPath, [script, '--base', base, '--head', 'HEAD', '--assert-metadata'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ build: false, release_intent: false });
  }));

  it.each([
    ['specgit:patch', 1],
    ['"specgit": "patch"', 0],
    ["'specgit': 'minor' # release scope", 0],
  ])('matches release parser mapping semantics for %s', (mapping, exit) => withRepo((root, base, git) => {
    mkdirSync(path.join(root, '.changeset'));
    writeFileSync(path.join(root, '.changeset', 'fix.md'), `---\n${mapping}\n---\nFix scope.\n`);
    git('add', '.'); git('commit', '-qm', 'changeset mapping');
    const result = spawnSync(process.execPath, [script, '--base', base, '--head', 'HEAD', '--assert-metadata'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(exit);
  }));

  it('classifies the actual GitHub event ranges and rejects missing event evidence', () => withRepo((root, base, git) => {
    writeFileSync(path.join(root, 'README.md'), 'Metadata.\n');
    git('add', '.'); git('commit', '-qm', 'docs');
    const head = git('rev-parse', 'HEAD');
    const eventPath = path.join(root, 'event.json');
    const runEvent = (event: string, payload: unknown) => {
      writeFileSync(eventPath, JSON.stringify(payload));
      return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: {
        ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: '',
      } });
    };
    for (const [event, payload] of [
      ['push', { before: base, after: head }],
      ['pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }],
      ['merge_group', { merge_group: { base_sha: base, head_sha: head } }],
    ] as const) {
      const result = runEvent(event, payload);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ build: false, metadata: true });
    }
    for (const event of ['schedule', 'workflow_dispatch']) {
      const result = runEvent(event, {});
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ build: true, dependencies: true, release_intent: false });
    }
    expect(JSON.parse(runEvent('push', { before: '0'.repeat(40), after: head }).stdout).build).toBe(true);
    expect(runEvent('pull_request', { pull_request: { base: { sha: base } } }).status).toBe(1);
    git('checkout', '-qb', 'base-advanced', base);
    writeFileSync(path.join(root, 'src', 'entry.ts'), 'export const value = 2;\n');
    git('add', '-u'); git('commit', '-qm', 'base branch source change');
    const divergentBase = git('rev-parse', 'HEAD');
    const pr = runEvent('pull_request', { pull_request: { base: { sha: divergentBase }, head: { sha: head } } });
    expect(pr.status, pr.stderr).toBe(0);
    expect(JSON.parse(pr.stdout)).toMatchObject({ build: false, base });
  }));

  it('allows removal of tracked local state without compiling, but rejects new local state', () => withRepo((root, base, git) => {
    mkdirSync(path.join(root, '.local'));
    writeFileSync(path.join(root, '.local', 'state'), 'fixture');
    git('add', '.'); git('commit', '-qm', 'local state');
    const added = spawnSync(process.execPath, [script, '--base', base, '--head', 'HEAD'], { cwd: root, encoding: 'utf8' });
    expect(added.status).toBe(1);
    const dirtyBase = git('rev-parse', 'HEAD');
    git('rm', '-q', '.local/state'); git('commit', '-qm', 'remove local state');
    const removed = spawnSync(process.execPath, [script, '--base', dirtyBase, '--head', 'HEAD', '--assert-metadata'], { cwd: root, encoding: 'utf8' });
    expect(removed.status, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ build: false, release_intent: false });
  }));
});
