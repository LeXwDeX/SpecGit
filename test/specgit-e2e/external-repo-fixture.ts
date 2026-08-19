/**
 * External-adoption fixture support (#63, extended by #67): UNRELATED
 * npm repositories that adopt the packed SpecGit CLI.
 *
 * The fixtures deliberately have nothing in common with the SpecGit repo:
 * a plain npm `package.json` (no pnpm, no lockfile, no workspace, no bin),
 * configurable default branches (`master` and `main` both run in the #67
 * matrix) resolved through a real `origin/HEAD` ref, optional own CI
 * (or none at all), a linked-worktree variant, and a pushable bare
 * remote standing in for the GitHub origin. Installing the `npm pack`
 * artifact via file:// is the PR-level evidence layer; the post-publish
 * layer (a real external repository's green Actions run against the
 * registry package) is tracked on the issue.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { git, rmDir } from './helpers.js';

export { rmDir };

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Run npm synchronously, Windows-capable: npm is npm.cmd there and .cmd
 * spawnables require a shell (same approach as the repo's run-cli helper).
 * With a shell, args join with spaces — quote any arg containing one.
 */
function runNpmSync(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const isWindows = process.platform === 'win32';
  const finalArgs = isWindows ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  const res = spawnSync(isWindows ? 'npm.cmd' : 'npm', finalArgs, {
    cwd,
    encoding: 'utf-8',
    shell: isWindows,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed (exit ${res.status}): ${res.stderr}`);
  }
  return res.stdout ?? '';
}

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
 * `npm pack` the repository once per test file, hermetically (plan N7
 * dist-race fix).
 *
 * The pack runs from a staged copy of exactly what the package ships
 * (`files` entries + manifest + README/LICENSE) whose package.json
 * carries NO lifecycle scripts: `npm pack` cannot run `prepare` there,
 * so it can never wipe `dist/` while parallel e2e workers are mid-run
 * against `dist/cli/index.js`. This holds for every npm version,
 * including the ones where `--ignore-scripts` still runs `prepare`
 * (a long-standing npm quirk observed on CI runners). The suite's
 * global setup builds exactly once before any worker starts; the pack
 * ships those bytes untouched.
 */
export function packSpecgit(): PackedSpecgit {
  if (packed) return packed;
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js'))) {
    throw new Error('dist/cli/index.js is missing — run `pnpm run build` before packing.');
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-pack-stage-'));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8')
  ) as { version: string; scripts?: Record<string, string> };
  const { scripts: _scripts, ...scriptless } = manifest;
  fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(scriptless, null, 2)}\n`);
  for (const entry of ['dist', 'bin', 'schemas']) {
    fs.cpSync(path.join(PROJECT_ROOT, entry), path.join(staging, entry), { recursive: true });
  }
  for (const doc of ['README.md', 'LICENSE']) {
    const source = path.join(PROJECT_ROOT, doc);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(staging, doc));
    }
  }

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'specgit-external-pack-'));
  try {
    const out = runNpmSync(
      ['pack', '--json', '--silent', '--ignore-scripts', `--pack-destination=${dest}`],
      staging
    );
    // Belt and braces: tolerate any banner lines before npm's JSON array.
    const lines = out.split('\n');
    const jsonStart = lines.findIndex((line) => line.trimStart().startsWith('['));
    if (jsonStart === -1) throw new Error('npm pack returned no JSON array');
    const entries = JSON.parse(lines.slice(jsonStart).join('\n')) as Array<{
      filename?: string;
    }>;
    const filename = entries.at(-1)?.filename;
    if (!filename) throw new Error('npm pack returned no tarball');
    packed = { tarballPath: path.join(dest, filename), version: manifest.version };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return packed;
}

export interface ExternalRepoFixture {
  dir: string;
  headSha: string;
}

/**
 * Fixture shape dial (#67): the default branch proves the harness
 * assumes nothing about branch names (`master` and `main` both run in
 * the matrix), and `ci: 'none'` builds a repository with no CI of its
 * own at all — the zero-required-checks adoption path.
 */
export interface ExternalRepoOptions {
  defaultBranch?: string;
  ci?: 'app' | 'none';
}

export function makeExternalRepo(prefix: string, options: ExternalRepoOptions = {}): ExternalRepoFixture {
  const defaultBranch = options.defaultBranch ?? 'master';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, 'init', '-b', defaultBranch);
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

  if (options.ci !== 'none') {
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
  } else {
    git(dir, 'add', 'package.json');
  }
  git(dir, '-c', 'core.hooksPath=external-fixture-no-hooks', 'commit', '-m', 'unrelated app baseline');
  const headSha = git(dir, 'rev-parse', 'HEAD').trim();

  // A genuine default branch ref: origin/HEAD -> origin/<defaultBranch>,
  // exactly what `git rev-parse --abbrev-ref origin/HEAD` (the
  // LocalGitAdapter's probe) resolves in a real clone.
  git(dir, 'update-ref', `refs/remotes/origin/${defaultBranch}`, headSha);
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${defaultBranch}`);

  return { dir, headSha };
}

export interface PushableExternalRepo extends ExternalRepoFixture {
  /** Local bare remote standing in for the GitHub origin (insteadOf rewrite). */
  bareDir: string;
}

/**
 * An external repo whose `origin` still parses to the GitHub URL while
 * every push lands in a local bare remote: real git transport, no
 * network — the bootstrap's `git push` has somewhere real to go.
 */
export function makePushableExternalRepo(
  prefix: string,
  options: ExternalRepoOptions = {}
): PushableExternalRepo {
  const repo = makeExternalRepo(prefix, options);
  const bareDir = `${fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}bare-`))}.git`;
  git(repo.dir, 'init', '--bare', bareDir);
  git(repo.dir, 'config', `url.${bareDir}.insteadOf`, EXT_ORIGIN_URL);
  return { ...repo, bareDir };
}

export interface ExternalWorktreeFixture {
  mainDir: string;
  bareDir: string;
  worktreeDir: string;
  label: string;
  headSha: string;
}

/**
 * A linked-worktree adoption (#67): the unrelated app checked out as a
 * linked worktree of its main repository — the shape a contributor
 * uses to deliver from a worktree. The worktree sits on its own base
 * branch (`specgit issue` requires a branch checkout, never a detached
 * HEAD). The label is the basename the CLI records, computed from the
 * real (symlink-resolved) path like the product does.
 */
export function makeExternalWorktree(
  prefix: string,
  options: ExternalRepoOptions = {}
): ExternalWorktreeFixture {
  const repo = makePushableExternalRepo(prefix, { ci: 'none', ...options });
  const worktreeRaw = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}wt-`));
  git(repo.dir, 'worktree', 'add', worktreeRaw, '-b', 'wt-base');
  const worktreeDir = fs.realpathSync(worktreeRaw);
  return {
    mainDir: repo.dir,
    bareDir: repo.bareDir,
    worktreeDir,
    label: path.basename(worktreeDir),
    headSha: repo.headSha,
  };
}

/** The default branch exactly as the CLI's git adapter derives it. */
export function remoteDefaultBranch(dir: string): string {
  return git(dir, 'rev-parse', '--abbrev-ref', 'origin/HEAD').trim().replace(/^origin\//, '');
}

/**
 * An isolated npm cache for a test file's installs (#67): keeps the
 * fixture installs out of the host user's cache while letting the
 * file's sequential installs share one warm cache.
 */
export function externalNpmCache(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** file:// adoption install of the packed CLI; `--no-save` keeps the adopting tree clean. */
export function npmInstallPacked(tarballPath: string, cwd: string, cacheDir?: string): void {
  runNpmSync(
    ['install', tarballPath, '--no-save', '--no-audit', '--no-fund', '--loglevel=error'],
    cwd,
    cacheDir === undefined ? undefined : { npm_config_cache: cacheDir }
  );
}

/** Global install into an isolated prefix (never the host's global root). */
export function npmInstallGlobal(tarballPath: string, prefix: string, cacheDir?: string): void {
  runNpmSync(
    ['install', '-g', `--prefix=${prefix}`, tarballPath, '--no-audit', '--no-fund', '--loglevel=error'],
    prefix,
    cacheDir === undefined ? undefined : { npm_config_cache: cacheDir }
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
  return runInstalledSpecgitFrom(dir, dir, args, env);
}

/**
 * Run the installed CLI from an arbitrary cwd while the install lives
 * elsewhere (e.g. proving fail-closed behavior outside any git
 * repository with the adopted package's bin).
 */
export function runInstalledSpecgitFrom(
  cwd: string,
  installDir: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): InstalledCliResult {
  const bin = path.join(installDir, 'node_modules', 'specgit', 'bin', 'specgit.js');
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf-8',
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}
