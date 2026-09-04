/**
 * Issue #67 — install-path smoke for the packed candidate artifact, plus
 * the 2/3 legs of the 0/1/2/3 exit matrix from the installed bin (the
 * 0/1 legs live in external-matrix.e2e.test.ts against the same
 * artifact).
 *
 * Boundaries, explicitly:
 *  - file:// tarball install, `npx --no-install`, and the global-prefix
 *    install are deterministic PR-level layers and always run;
 *  - the registry-published package smoke is opt-in
 *    (`SPECGIT_E2E_PUBLISHED=1`, version overridable via
 *    SPECGIT_E2E_PUBLISHED_VERSION) — the always-on live layer is the
 *    post-publish external Actions run tracked on the issue.
 *
 * Every scenario avoids this repository's workspace: installs target
 * throwaway temp directories with an isolated npm cache
 * (`npm_config_cache`), never a pnpm store, never this checkout.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { gitOnlyPathDir } from './helpers.js';
import {
  externalNpmCache,
  makeExternalRepo,
  npmInstallGlobal,
  npmInstallPacked,
  packSpecgit,
  rmDir,
  runInstalledSpecgit,
  runInstalledSpecgitFrom,
} from './external-repo-fixture.js';

const cleanup: string[] = [];

afterAll(() => {
  for (const dir of cleanup) rmDir(dir);
});

function parseInstalledJson(result: { stdout: string }): Record<string, any> {
  const text = result.stdout.trim();
  if (text.length === 0) {
    throw new Error('expected exactly one JSON document on stdout, got empty output');
  }
  return JSON.parse(text) as Record<string, any>;
}

function tarList(tarballPath: string): string[] {
  const res = spawnSync('tar', ['-tf', tarballPath], { encoding: 'utf-8' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`tar -tf failed (exit ${res.status}): ${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((entry) => entry.replace(/^\.\//, ''));
}

const PUBLISHED_GATE = process.env.SPECGIT_E2E_PUBLISHED === '1';
const PUBLISHED_VERSION = process.env.SPECGIT_E2E_PUBLISHED_VERSION ?? '0.7.2';

describe('install smoke (#67): the packed tarball is clean', () => {
  it('ships the package surface and nothing from the development tree', async () => {
    const { tarballPath } = await packSpecgit();
    const entries = tarList(tarballPath);
    const has = (entry: string) => entries.includes(`package/${entry}`);
    const hasPrefix = (prefix: string) => entries.some((entry) => entry.startsWith(`package/${prefix}`));

    expect(has('package.json')).toBe(true);
    expect(has('bin/specgit.js')).toBe(true);
    expect(has('dist/cli/index.js')).toBe(true);
    expect(has('dist/index.js')).toBe(true);
    for (const filename of ['actions-ownership.mjs', 'actions-ownership.d.mts']) {
      const entry = `dist/harness-runtime/${filename}`;
      expect(has(entry), entry).toBe(true);
      const packed = spawnSync('tar', ['-xOf', tarballPath, `package/${entry}`], { encoding: 'utf8' });
      expect(packed.status, packed.stderr).toBe(0);
      expect(packed.stdout).toBe(fs.readFileSync(new URL(`../../src/harness-runtime/${filename}`, import.meta.url), 'utf8'));
    }
    expect(hasPrefix('schemas/')).toBe(true);

    expect(hasPrefix('src/')).toBe(false);
    expect(hasPrefix('test/')).toBe(false);
    expect(hasPrefix('.github/')).toBe(false);
    expect(has('pnpm-lock.yaml')).toBe(false);
    expect(has('pnpm-workspace.yaml')).toBe(false);
  });
});

describe('install smoke (#67): npx resolves the local install', () => {
  it(
    '`npx --no-install specgit --version` runs the adopted package',
    { timeout: 240_000 },
    async () => {
      const { tarballPath, version } = await packSpecgit();
      const cache = externalNpmCache('specgit-smoke-cache-');
      const fixture = makeExternalRepo('specgit-smoke-npx-', { ci: 'none' });
      cleanup.push(fixture.dir, cache);
      await npmInstallPacked(tarballPath, fixture.dir, cache);

      const res = spawnSync('npx --no-install specgit --version', {
        cwd: fixture.dir,
        shell: true,
        encoding: 'utf-8',
        env: { ...process.env, npm_config_cache: cache },
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe(version);
    }
  );
});

describe('install smoke (#67): global install', () => {
  it(
    'npm install -g into an isolated prefix; the PATH shim runs the CLI anywhere',
    { timeout: 240_000 },
    async () => {
      const { tarballPath, version } = await packSpecgit();
      const cache = externalNpmCache('specgit-smoke-cache-');
      const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-smoke-global-'));
      cleanup.push(prefix, cache);
      await npmInstallGlobal(tarballPath, prefix, cache);

      // npm places global shims in <prefix>/bin on POSIX and in the
      // prefix root on Windows — put both on PATH.
      const shimDirs =
        process.platform === 'win32' ? [prefix] : [path.join(prefix, 'bin'), prefix];
      const env = {
        ...process.env,
        PATH: `${shimDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ''}`,
        npm_config_cache: cache,
      };

      const versionRun = spawnSync('specgit --version', {
        cwd: os.tmpdir(),
        shell: true,
        encoding: 'utf-8',
        env,
      });
      expect(versionRun.status, versionRun.stderr).toBe(0);
      expect(versionRun.stdout.trim()).toBe(version);

      const helpRun = spawnSync('specgit --help', {
        cwd: os.tmpdir(),
        shell: true,
        encoding: 'utf-8',
        env,
      });
      expect(helpRun.status, helpRun.stderr).toBe(0);
      expect(helpRun.stdout).toMatch(/Usage: specgit/);
      expect(helpRun.stdout).toMatch(/\bissue\b/);
    }
  );
});

(PUBLISHED_GATE ? describe : describe.skip)(
  'install smoke (#67): registry-published package (opt-in, post-publish handover)',
  () => {
    it(
      `\`npx --yes specgit@${PUBLISHED_VERSION} --version\` runs the published package`,
      { timeout: 240_000 },
      () => {
        const res = spawnSync(`npx --yes specgit@${PUBLISHED_VERSION} --version`, {
          cwd: os.tmpdir(),
          shell: true,
          encoding: 'utf-8',
        });
        expect(res.status, res.stderr).toBe(0);
        expect(res.stdout.trim()).toBe(PUBLISHED_VERSION);
      }
    );
  }
);

describe('exit contract from the installed bin (#67): 2 and 3', () => {
  it(
    'exit 2: an unknown command is a usage error carrying exactly one JSON document',
    { timeout: 240_000 },
    async () => {
      const { tarballPath } = await packSpecgit();
      const cache = externalNpmCache('specgit-smoke-cache-');
      const fixture = makeExternalRepo('specgit-smoke-exit-', { ci: 'none' });
      cleanup.push(fixture.dir, cache);
      await npmInstallPacked(tarballPath, fixture.dir, cache);

      const usage = runInstalledSpecgit(fixture.dir, ['definitely-not-a-command', '--json']);
      expect(usage.status).toBe(2);
      const envelope = parseInstalledJson(usage);
      expect(envelope.status).toBe('error');
      expect(envelope.command).toBe('specgit');
    }
  );

  it(
    'exit 3: outside a git repository the installed CLI fails closed with clean stderr',
    { timeout: 60_000 },
    async () => {
      const { tarballPath } = await packSpecgit();
      const cache = externalNpmCache('specgit-smoke-cache-');
      const fixture = makeExternalRepo('specgit-smoke-exit2-', { ci: 'none' });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-smoke-nogit-'));
      cleanup.push(fixture.dir, outside, cache);
      await npmInstallPacked(tarballPath, fixture.dir, cache);

      const result = runInstalledSpecgitFrom(outside, fixture.dir, ['status', '--json']);
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(3);
      const envelope = parseInstalledJson(result);
      expect(envelope.status).toBe('unknown');
      expect((envelope.errors as Array<{ code: string }>).map((error) => error.code)).toContain(
        'not_a_git_repo'
      );
      expect(result.stderr.trim()).toBe('');
    }
  );

  it(
    'exit 3: finish with no gh on PATH fails closed (gh_missing)',
    { timeout: 240_000 },
    async () => {
      const { tarballPath } = await packSpecgit();
      const cache = externalNpmCache('specgit-smoke-cache-');
      const fixture = makeExternalRepo('specgit-smoke-exit3-', { ci: 'none' });
      cleanup.push(fixture.dir, cache);
      await npmInstallPacked(tarballPath, fixture.dir, cache);

      const init = runInstalledSpecgit(fixture.dir, ['init', '--no-protect', '--json']);
      expect(init.status, init.stderr).toBe(0);
      const bind = runInstalledSpecgit(
        fixture.dir,
        ['bind', '--delivery', 'no-gh-here', '--issue', '5', '--pr', '5', '--json']
      );
      expect(bind.status, bind.stderr).toBe(0);

      const gitOnly = gitOnlyPathDir(fixture.dir);
      const result = runInstalledSpecgit(fixture.dir, ['finish', '--json'], {
        PATH: gitOnly,
        Path: gitOnly,
      });
      expect(result.status).toBe(3);
      const envelope = parseInstalledJson(result);
      expect(envelope.status).toBe('unknown');
      expect((envelope.errors as Array<{ code: string }>).map((error) => error.code)).toContain(
        'gh_missing'
      );
    }
  );
});
