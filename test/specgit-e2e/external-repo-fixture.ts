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

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { git, rmDir } from './helpers.js';

export { rmDir };

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * npm's `bin/npm-cli.js` resolved against the running Node runtime —
 * the #88 finding 4 (88-4) quoting hardening: invoking npm as
 * `node npm-cli.js …` passes arguments as argv, so no Windows shell
 * (cmd.exe, pwsh, or anything else) ever re-parses or re-quotes them.
 *
 * Candidate layouts, in order:
 * 1. `<node dir>/node_modules/npm/…` — Windows installers, setup-node,
 *    nvm-windows, volta;
 * 2. `<node dir>/../lib/node_modules/npm/…` — POSIX tarball/source,
 *    nvm, system installs;
 * 3. an `npm` found on PATH that IS npm-cli.js after symlink
 *    resolution (POSIX layouts symlink the JS entry directly — e.g.
 *    Homebrew, where npm lives in a separate prefix from the node keg).
 *
 * `undefined` means no layout matched; the caller falls back to the
 * legacy shell spawn.
 */
export function resolveNpmCli(): string | undefined {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  for (const name of names) {
    const found = findOnPath(name);
    if (!found) continue;
    try {
      const real = fs.realpathSync(found);
      if (path.basename(real) === 'npm-cli.js') return real;
    } catch {
      // Unresolvable symlink — try the next candidate.
    }
  }
  return undefined;
}

function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((ext) => ext.toLowerCase())
      : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name.endsWith(ext.toUpperCase()) ? name : `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The spawn plan `runNpm` executes. */
export interface NpmInvocation {
  command: string;
  args: string[];
  shell: boolean;
  /** True when the hardened shell-free path (npm-cli.js via Node) is in use. */
  resolved: boolean;
}

/** The legacy Windows quoting, pinned verbatim: only whitespace is
 *  wrapped in plain double quotes (cmd.exe dialect). Kept solely as
 *  the fallback when `resolveNpmCli` finds no npm-cli.js. */
export function quoteForWindowsShell(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Build npm's spawn plan. Prefers the shell-free path (arguments as
 * argv, `shell: false` on every platform); falls back to the legacy
 * `npm`/`npm.cmd` spawn, shell-enabled on win32 with
 * `quoteForWindowsShell`, when npm-cli.js cannot be resolved. Pass
 * `npmCli: null` to force the legacy branch (tests).
 */
export function npmInvocation(
  args: string[],
  npmCli: string | null | undefined = resolveNpmCli()
): NpmInvocation {
  if (npmCli) {
    return { command: process.execPath, args: [npmCli, ...args], shell: false, resolved: true };
  }
  const isWindows = process.platform === 'win32';
  return {
    command: isWindows ? 'npm.cmd' : 'npm',
    args: isWindows ? args.map(quoteForWindowsShell) : args,
    shell: isWindows,
    resolved: false,
  };
}

/**
 * Run npm — shell-free wherever npm-cli.js resolves (#88 finding 4):
 * arguments travel as argv, immune to per-shell quoting dialects
 * whether the fixture runs under the CI pwsh wrapper or is copied by
 * hand into any other Windows shell. The legacy shell spawn survives
 * only as the unresolvable-layout fallback.
 *
 * Async on purpose: npm installs run 15-35s on hosted Windows runners,
 * and a synchronous spawnSync blocks the vitest worker's event loop for
 * the whole install. The worker then stops draining its IPC channel,
 * the vitest main process stalls on a full named pipe, and worker RPC
 * calls ("onTaskUpdate", fixed 60s birpc timeout in vitest 3.2.6) fail
 * as unhandled errors that redden an otherwise green run. Keeping the
 * event loop alive is part of the fixture's contract with the runner.
 */
export function runNpm(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const plan = npmInvocation(args);
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd,
      shell: plan.shell,
      env: env === undefined ? process.env : { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`npm ${args.join(' ')} failed (exit ${code}): ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
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

let packedPromise: Promise<PackedSpecgit> | undefined;

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
 * ships those bytes untouched. The memoized promise keeps concurrent
 * first calls from double-packing now that the helper is async.
 */
export function packSpecgit(): Promise<PackedSpecgit> {
  if (packedPromise) return packedPromise;
  packedPromise = (async () => {
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
      const out = await runNpm(
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
      return { tarballPath: path.join(dest, filename), version: manifest.version };
    } catch (error) {
      packedPromise = undefined;
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  })();
  return packedPromise;
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
 *
 * `prTemplate: true` (#87) additionally commits the adopting
 * repository's OWN pull-request templates at every location GitHub
 * discovers them (`.github/`, repo root, `docs/`). The decoy content
 * carries a `Closes #123` placeholder — the exact trap a scaffold
 * mimic could fall into — so any test can prove the SpecGit scaffold
 * is generated without reading, echoing, or mutating these files.
 */
export interface ExternalRepoOptions {
  defaultBranch?: string;
  ci?: 'app' | 'none';
  prTemplate?: boolean;
}

/** Byte-stable decoy body for the adopting repo's PR templates (#87). */
export const EXT_PR_TEMPLATE = [
  '## Adopting repo PR template',
  '',
  'This line must never leak into a specgit-created PR body.',
  '',
  'Closes #123',
  '',
].join('\n');

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

  if (options.prTemplate) {
    for (const rel of ['.github/PULL_REQUEST_TEMPLATE.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/PULL_REQUEST_TEMPLATE.md']) {
      const target = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, EXT_PR_TEMPLATE);
      git(dir, 'add', rel);
    }
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

// ---------------------------------------------------------------------------
// GitLab variant (#117): the same adoption shape on a nested-group
// self-managed origin. The recorded evidence payloads
// (test/specgit-e2e/fixtures/gitlab/, GitLab 19.2.4 CE on
// git.ycgame.com) drive the offline fake-glab rule tables — the e2e
// clones those payload SHAPES and pins the local delivery state (shas,
// branches, iids) onto them, exactly like the #114 contract tests.
// ---------------------------------------------------------------------------

/** The recorded instance host (public delivery record; ledger row 6). */
export const GITLAB_HOST = 'git.ycgame.com';
/** Synthetic nested-group project path (depth 3 — the #95 reproducer shape). */
export const GITLAB_GROUP_PATH = 'specgit-evidence/probe';
export const GITLAB_PROJECT = 'app';
export const GITLAB_ORIGIN_URL = `https://${GITLAB_HOST}/${GITLAB_GROUP_PATH}/${GITLAB_PROJECT}.git`;
/** The .gitlab-ci.yml job key init detects as the required check. */
export const GITLAB_CHECK = 'build-app';

const GITLAB_CI_YAML = [
  `${GITLAB_CHECK}:`,
  '  stage: build',
  '  script:',
  '    - echo building the unrelated app',
  '',
].join('\n');

export interface GitlabExternalRepoFixture {
  dir: string;
  /** Local bare remote standing in for the GitLab origin (insteadOf rewrite). */
  bareDir: string;
  headSha: string;
}

/**
 * An UNRELATED npm repository on a nested-group GitLab origin (declared
 * platform, real git transport through a local bare remote, its own
 * `.gitlab-ci.yml` job — nothing the harness may lean on but the CI file
 * init detects). Offline: no network call ever leaves the fake glab.
 */
export function makeGitlabExternalRepo(prefix: string): GitlabExternalRepoFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'External Fixture');
  git(dir, 'config', 'user.email', 'external@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', GITLAB_ORIGIN_URL);

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      { name: GITLAB_PROJECT, version: '0.1.0', private: true, engines: { node: '>=20.19' } },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), GITLAB_CI_YAML);

  git(dir, 'add', 'package.json', '.gitlab-ci.yml');
  git(dir, '-c', 'core.hooksPath=external-fixture-no-hooks', 'commit', '-m', 'unrelated app baseline');
  const headSha = git(dir, 'rev-parse', 'HEAD').trim();

  git(dir, 'update-ref', 'refs/remotes/origin/main', headSha);
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  const bareDir = `${fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}bare-`))}.git`;
  git(dir, 'init', '--bare', bareDir);
  git(dir, 'config', `url.${bareDir}.insteadOf`, GITLAB_ORIGIN_URL);

  return { dir, bareDir, headSha };
}

/**
 * A PATH containing git and the fake glab ONLY — no gh can ever be
 * reached (real or fake): a routing regression fails closed as
 * gh_missing instead of touching a real GitHub account.
 */
export function gitAndGlabOnlyPath(gitBinDir: string, glabBinDir: string): string {
  return `${glabBinDir}${path.delimiter}${gitBinDir}`;
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
export async function npmInstallPacked(tarballPath: string, cwd: string, cacheDir?: string): Promise<void> {
  await runNpm(
    ['install', tarballPath, '--no-save', '--no-audit', '--no-fund', '--loglevel=error'],
    cwd,
    cacheDir === undefined ? undefined : { npm_config_cache: cacheDir }
  );
}

/** Global install into an isolated prefix (never the host's global root). */
export async function npmInstallGlobal(
  tarballPath: string,
  prefix: string,
  cacheDir?: string
): Promise<void> {
  await runNpm(
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
