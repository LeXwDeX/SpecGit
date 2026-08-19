/**
 * Issue #63 fixture support: an UNRELATED npm repository that adopts the
 * packed SpecGit CLI.
 *
 * The fixture deliberately has nothing in common with the SpecGit repo:
 * a plain npm `package.json` (no pnpm, no lockfile, no workspace, no bin),
 * a `master` default branch resolved through a real `origin/HEAD` ref, and
 * its own CI workflow whose job name the harness must wait for. Installing
 * the `npm pack` artifact via file:// is the PR-level evidence layer; the
 * post-publish layer (a real external repository's green Actions run) is
 * tracked on the issue.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { git, rmDir } from './helpers.js';

export { rmDir };

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const EXT_OWNER = 'acme';
export const EXT_REPO = 'unrelated-app';
export const EXT_ORIGIN_URL = `https://github.com/${EXT_OWNER}/${EXT_REPO}.git`;
/** The adopting repository's own check; detection must find it verbatim. */
export const EXT_CHECK = 'Build';

export interface PackedSpecgit {
  tarballPath: string;
  version: string;
}

let packed: PackedSpecgit | undefined;

/**
 * `npm pack` the repository once per test file.
 *
 * `--ignore-scripts` is the dist-race fix (plan N7): `npm pack` would
 * otherwise run `prepare` (a full `build.js` that wipes and rebuilds
 * `dist/`) while parallel e2e workers are mid-run against
 * `dist/cli/index.js`. The suite's global setup builds exactly once
 * before any worker starts; the pack then ships those bytes untouched.
 */
export function packSpecgit(): PackedSpecgit {
  if (packed) return packed;
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js'))) {
    throw new Error('dist/cli/index.js is missing — run `pnpm run build` before packing.');
  }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-external-pack-'));
  const out = execFileSync(
    'npm',
    ['pack', '--json', '--silent', '--ignore-scripts', `--pack-destination=${dest}`],
    { cwd: PROJECT_ROOT, encoding: 'utf-8' }
  );
  const entries = JSON.parse(out) as Array<{
    filename?: string;
  }>;
  const filename = entries.at(-1)?.filename;
  if (!filename) throw new Error('npm pack returned no tarball');
  const version = (
    JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8')) as {
      version: string;
    }
  ).version;
  packed = { tarballPath: path.join(dest, filename), version };
  return packed;
}

export interface ExternalRepoFixture {
  dir: string;
  headSha: string;
}

export function makeExternalRepo(prefix: string): ExternalRepoFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, 'init', '-b', 'master');
  git(dir, 'config', 'user.name', 'External Fixture');
  git(dir, 'config', 'user.email', 'external@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', EXT_ORIGIN_URL);

  // A normal npm project: no specgit dependency, no lockfile, no workspace,
  // no repository-local bin — nothing the harness may lean on.
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      { name: EXT_REPO, version: '0.1.0', private: true, engines: { node: '>=20.19' } },
      null,
      2
    )}\n`
  );
  const workflowsDir = path.join(dir, '.github', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, 'app-ci.yml'),
    [
      'name: App CI',
      'on: [pull_request]',
      'jobs:',
      '  build:',
      '    name: Build',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo building the unrelated app',
      '',
    ].join('\n')
  );

  git(dir, 'add', 'package.json', '.github');
  git(dir, '-c', 'core.hooksPath=external-fixture-no-hooks', 'commit', '-m', 'unrelated app baseline');
  const headSha = git(dir, 'rev-parse', 'HEAD').trim();

  // A genuine non-main default branch: origin/HEAD -> origin/master, exactly
  // what `git rev-parse --abbrev-ref origin/HEAD` (the LocalGitAdapter's
  // probe) resolves in a real clone.
  git(dir, 'update-ref', 'refs/remotes/origin/master', headSha);
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');

  return { dir, headSha };
}

/** The default branch exactly as the CLI's git adapter derives it. */
export function remoteDefaultBranch(dir: string): string {
  return git(dir, 'rev-parse', '--abbrev-ref', 'origin/HEAD').trim().replace(/^origin\//, '');
}

/** file:// adoption install of the packed CLI; `--no-save` keeps the adopting tree clean. */
export function npmInstallPacked(tarballPath: string, cwd: string): void {
  execFileSync(
    'npm',
    ['install', tarballPath, '--no-save', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd, encoding: 'utf-8' }
  );
}

export interface InstalledCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI the way the installed package exposes it (its own bin), from the fixture root. */
export function runInstalledSpecgit(
  dir: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): InstalledCliResult {
  const bin = path.join(dir, 'node_modules', 'specgit', 'bin', 'specgit.js');
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf-8',
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}
