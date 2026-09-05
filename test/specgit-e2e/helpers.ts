import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCLI, type RunCLIResult } from '../helpers/run-cli.js';
import { createFakeGh, readFakeGhCalls, readFakeGhStdin, type FakeGhRule } from '../specgit/helpers/fake-gh.js';

export { createFakeGh, readFakeGhCalls, readFakeGhStdin };

/**
 * The stdin payloads that are draft-PR bodies (#330): every bootstrap
 * also streams tag-apply JSON through `--input -` per bound issue, so
 * body assertions select on the scaffold's opening closing-reference
 * instead of trusting list position.
 */
export function prScaffoldBodies(logPath: string): string[] {
  return readFakeGhStdin(logPath).filter((body) => body.startsWith('Closes #'));
}
export type { FakeGhRule, RunCLIResult };

export const OWNER = 'LeXwDeX';
export const REPO = 'example-app';
export const REPO_URL = `https://github.com/${OWNER}/${REPO}.git`;
export const REQUIRED_CHECK = 'All checks passed';

const FIXED_DATE = '2026-01-02T03:04:05+00:00';
const GIT_IDENTITY = {
  name: 'SpecGit E2E',
  email: 'e2e@specgit.local',
};

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'specgit-e2e-no-global-gitconfig'),
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
    GIT_OPTIONAL_LOCKS: '0',
  };
}

export function git(repoDir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
    env: gitEnv(),
  });
}

export interface RepoFixture {
  dir: string;
  branch: string;
  sha: string;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function makeRepo(branch: string, deliveryFile = 'feature.txt', withRemote = true): RepoFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `specgit-e2e-${safeName(branch)}-`));
  git(dir, 'init', '-b', branch);
  git(dir, 'config', 'user.name', GIT_IDENTITY.name);
  git(dir, 'config', 'user.email', GIT_IDENTITY.email);
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', REPO_URL);
  fs.writeFileSync(path.join(dir, deliveryFile), `${branch}\n`);
  git(dir, 'add', deliveryFile);
  git(
    dir,
    '-c',
    'core.hooksPath=spec-git-e2e-no-hooks',
    'commit',
    '-m',
    `deliver ${branch}`
  );
  if (withRemote) {
    const bare = path.join(dir, '.git', 'specgit-e2e-origin.git');
    git(dir, 'init', '--bare', bare);
    git(dir, 'config', `url.${bare}.insteadOf`, REPO_URL);
    git(dir, 'push', 'origin', 'HEAD:refs/heads/main');
    git(dir, '--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    // A push does not populate the local origin/HEAD. Ask the real bare
    // remote for its advertised default, as a clone would do.
    git(dir, 'remote', 'set-head', 'origin', '-a');
  }
  // #299: bind now force-carries the record as a commit — HEAD moves
  // after fixture creation, so `sha` must always read live.
  const fixture = { dir, branch } as RepoFixture;
  Object.defineProperty(fixture, 'sha', {
    get: () => git(dir, 'rev-parse', 'HEAD').trim(),
  });
  return fixture;
}

export interface WorktreeFixture {
  mainDir: string;
  worktreeDir: string;
  label: string;
  branch: string;
  sha: string;
}

export function makeWorktree(branch: string): WorktreeFixture {
  const main = makeRepo('main');
  const suffix = randomUUID().slice(0, 8);
  const worktreeDir = path.join(os.tmpdir(), `specgit-e2e-wt-${safeName(branch)}-${suffix}`);
  git(main.dir, 'worktree', 'add', worktreeDir, '-b', branch);
  const fixture = {
    mainDir: main.dir,
    worktreeDir: fs.realpathSync(worktreeDir),
    label: path.basename(worktreeDir),
    branch,
  } as WorktreeFixture;
  Object.defineProperty(fixture, 'sha', {
    get: () => git(main.dir, 'rev-parse', branch).trim(),
  });
  return fixture;
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface PrShape {
  number: number;
  branch: string;
  sha: string;
  body: string;
  state?: 'open' | 'closed';
  mergedAt?: string | null;
  draft?: boolean;
}

export function prJson(pr: PrShape): string {
  return JSON.stringify({
    number: pr.number,
    state: pr.state ?? 'open',
    merged_at: pr.mergedAt ?? null,
    draft: pr.draft ?? false,
    head: { ref: pr.branch, sha: pr.sha },
    base: { ref: 'main' },
    body: pr.body,
  });
}

export function issueJson(issue: number, state: 'open' | 'closed' = 'open'): string {
  return JSON.stringify({ number: issue, state, body: `Delivery requirement #${issue}.` });
}

export interface CheckShape {
  name: string;
  status?: string;
  conclusion?: string | null;
}

export function checkRunsJson(checks: CheckShape[]): string {
  return JSON.stringify({
    total_count: checks.length,
    check_runs: checks.map((check) => ({
      name: check.name,
      status: check.status ?? 'completed',
      conclusion: check.conclusion ?? 'success',
    })),
  });
}

export function emptyTimelineRule(owner = OWNER, repo = REPO): FakeGhRule {
  return {
    match: `^api repos/${owner}/${repo}/issues/[0-9]+/timeline`,
    stdout: '[]',
  };
}

/**
 * Builds the standard fake-`gh` rule table for a delivery that should pass
 * every evidence gate: authenticated CLI, every issue present, one PR whose
 * head matches the local HEAD and whose body closes every issue, and green
 * checks at the PR head.
 */
export function greenGhRules(options: {
  sha: string;
  branch: string;
  pr: number;
  issues: number[];
  body: string;
  checks?: CheckShape[];
}): FakeGhRule[] {
  const rules: FakeGhRule[] = [
    { match: '^--version$', stdout: 'gh version 2.60.0-specgit-e2e\n' },
    { match: '^auth status', stdout: `Logged in to github.com as specgit-e2e\n`, exit: 0 },
  ];

  for (const issue of options.issues) {
    rules.push({
      match: `^api repos/${OWNER}/${REPO}/issues/${issue}$`,
      stdout: issueJson(issue),
    });
  }

  rules.push({
    match: `^api repos/${OWNER}/${REPO}/pulls/${options.pr}$`,
    stdout: prJson({
      number: options.pr,
      branch: options.branch,
      sha: options.sha,
      body: options.body,
    }),
  });

  rules.push(emptyTimelineRule());

  rules.push({
    match: `^api repos/${OWNER}/${REPO}/commits/[0-9a-f]+/check-runs`,
    stdout: checkRunsJson(options.checks ?? [{ name: REQUIRED_CHECK }]),
  });

  return rules;
}

export function specgit(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<RunCLIResult> {
  return runCLI(args, { cwd: options.cwd, env: options.env });
}

export function parseEnvelope(result: RunCLIResult): Record<string, any> {
  const text = result.stdout.trim();
  if (text.length === 0) {
    throw new Error('Expected one JSON document on stdout, got empty output');
  }
  // The envelope contract is exactly one JSON document on stdout. A
  // whole-string parse proves single-document-ness: trailing garbage or a
  // second document makes JSON.parse throw.
  return JSON.parse(text) as Record<string, any>;
}

export async function initPolicy(cwd: string, env?: NodeJS.ProcessEnv): Promise<RunCLIResult> {
  // --no-protect: these scenarios pin the acceptance api-call surface; the
  // protection probe would add unrelated gh api calls against the fakes.
  const result = await specgit(
    ['init', '--required-check', REQUIRED_CHECK, '--no-protect', '--json'],
    { cwd, env }
  );
  if (result.exitCode !== 0) {
    throw new Error(`init failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  }
  return result;
}

export async function bindDelivery(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<RunCLIResult> {
  const result = await specgit(['bind', ...args, '--json'], { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(`bind failed (exit ${result.exitCode}): ${result.stdout}\n${result.stderr}`);
  }
  return result;
}

/**
 * A PATH that contains git and nothing else: proves the fail-closed behavior
 * when `gh` is absent. The host git binary is linked (or copied) into a
 * dedicated bin directory so no host `gh` can shadow the scenario.
 */
export function gitOnlyPathDir(tempDir: string): string {
  const gitBinary = findGitBinary();
  const binDir = path.join(tempDir, 'git-only-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const link = path.join(binDir, path.basename(gitBinary));
  try {
    fs.symlinkSync(gitBinary, link);
  } catch {
    fs.copyFileSync(gitBinary, link);
  }
  return binDir;
}

function findGitBinary(): string {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((ext) => ext.toLowerCase())
      : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `git${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  throw new Error('e2e precondition failed: no git binary found on PATH');
}

/**
 * Fabricated legacy-product artifacts: a fully-checked task list, a proposal,
 * spec files, and an openspec/ tree claiming the delivery is complete. None
 * of these files may influence acceptance.
 */
export function pileArtifacts(repoDir: string): void {
  const files: Record<string, string> = {
    'tasks.md': [
      '# Tasks',
      '',
      '- [x] 1.1 Implement the feature',
      '- [x] 1.2 Write tests',
      '- [x] 1.3 Ship it',
    ].join('\n'),
    'proposal.md': '## Why\nBecause we said so.\n\n## What\nEverything is done.\n',
    'design.md': '## Design\nFully designed and delivered.\n',
    'specs/feature/spec.md': '# Feature Spec\n\nRequirement: done.\n',
    'openspec/changes/ship-feature/proposal.md': '## Why\nDone.\n',
    'openspec/changes/ship-feature/tasks.md': '- [x] 1. everything\n',
    'openspec/changes/ship-feature/specs/feature/spec.md': 'Requirement: done.\n',
    'spec_git/notes.md': 'Delivery notes: the team considers this accepted.\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(repoDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
