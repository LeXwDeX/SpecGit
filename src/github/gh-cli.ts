import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { RepoRef } from '../gitfacts/origin.js';
import type { CheckRunInfo, GitHubProvider, IssueFact, PrFact } from './port.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const CHECK_RUN_PAGE_SIZE = 100;
const MAX_CHECK_RUN_PAGES = 10;
const MAX_EMBEDDED_TEXT = 400;

export interface SpawnOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => Promise<{ stdout: string; stderr: string }>;

const defaultSpawn: SpawnFn = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    env: options.env,
    cwd: options.cwd,
    encoding: 'utf-8',
  });
  return { stdout, stderr };
};

/**
 * API-sourced text can carry ANSI cursor controls or hostile bytes; anything
 * embedded in a diagnostic is stripped and truncated before it reaches a
 * terminal.
 */
export function sanitizeApiText(text: string, maxLength: number = MAX_EMBEDDED_TEXT): string {
  const stripped = text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b./g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const flat = stripped.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

function isSpawnNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

interface GhFailure {
  error: unknown;
}

export interface GhCliGitHubProviderOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  ghCommand?: string;
  spawnImpl?: SpawnFn;
}

type CallKind = 'issue' | 'pr' | 'checks';

/**
 * The only real GitHub transport: the `gh` CLI. Detection → auth → invoke;
 * array execFile args only, hard timeout, response size cap, JSON-only
 * responses, no silent fallback. All failures are evidence — none of them
 * pass acceptance.
 */
export class GhCliGitHubProvider implements GitHubProvider {
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly ghCommand: string;
  private readonly spawn: SpawnFn;

  constructor(options: GhCliGitHubProviderOptions = {}) {
    this.env = options.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.ghCommand = options.ghCommand ?? 'gh';
    this.spawn = options.spawnImpl ?? defaultSpawn;
  }

  async preflight(): Promise<Evidence<{ authenticated: boolean }>> {
    const version = await this.runGh(['--version']);
    if (!version.ok) {
      if (version.code === 'gh_missing') {
        return version;
      }
      return fail('gh_transport', `GitHub CLI failed to run: ${sanitizeApiText(version.message)}`);
    }

    const auth = await this.runGh(['auth', 'status']);
    if (!auth.ok) {
      if (auth.code === 'gh_missing') {
        return auth;
      }
      // gh documents `auth status` exit code 1 as an authentication problem;
      // every other failure (timeout, size cap, unexpected exit) is transport.
      if (auth.exitCode === 1) {
        return fail(
          'gh_unauthenticated',
          'GitHub CLI is not authenticated.',
          'Run "gh auth login" to authenticate.'
        );
      }
      return fail('gh_transport', `GitHub CLI auth check failed: ${sanitizeApiText(auth.message)}`);
    }

    return ok({ authenticated: true });
  }

  async getIssue(repo: RepoRef, n: number): Promise<Evidence<IssueFact>> {
    const result = await this.runApi(`repos/${repo.owner}/${repo.repo}/issues/${n}`, 'issue');
    if (!result.ok) {
      return result;
    }

    const parsed = result.value as {
      number?: unknown;
      state?: unknown;
      pull_request?: unknown;
    };
    if (typeof parsed.number !== 'number' || (parsed.state !== 'open' && parsed.state !== 'closed')) {
      return fail('gh_transport', 'GitHub returned an unexpected issue payload.');
    }

    return ok({ number: parsed.number, state: parsed.state, pullRequest: parsed.pull_request != null });
  }

  async getPr(repo: RepoRef, pr: number | string): Promise<Evidence<PrFact>> {
    const ref = String(pr);
    if (!/^\d+$/.test(ref)) {
      return fail(
        'pr_not_found',
        `Cannot resolve pull request reference "${sanitizeApiText(ref)}".`,
        'Bind the PR by number or a full github.com pull request URL.'
      );
    }

    const result = await this.runApi(`repos/${repo.owner}/${repo.repo}/pulls/${ref}`, 'pr');
    if (!result.ok) {
      return result;
    }

    const parsed = result.value as {
      number?: unknown;
      state?: unknown;
      merged_at?: unknown;
      head?: { ref?: unknown; sha?: unknown };
      base?: { ref?: unknown };
      body?: unknown;
    };
    if (typeof parsed.number !== 'number' || (parsed.state !== 'open' && parsed.state !== 'closed')) {
      return fail('gh_transport', 'GitHub returned an unexpected pull request payload.');
    }

    const state: PrFact['state'] =
      parsed.merged_at != null ? 'merged' : parsed.state === 'closed' ? 'closed' : 'open';

    return ok({
      number: parsed.number,
      state,
      headBranch: typeof parsed.head?.ref === 'string' ? parsed.head.ref : '',
      headSha: typeof parsed.head?.sha === 'string' ? parsed.head.sha : '',
      baseBranch: typeof parsed.base?.ref === 'string' ? parsed.base.ref : '',
      body: typeof parsed.body === 'string' ? parsed.body : '',
    });
  }

  async getCheckRuns(repo: RepoRef, sha: string): Promise<Evidence<CheckRunInfo[]>> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      return fail('gh_transport', 'Cannot query check runs without a valid commit SHA.');
    }

    const runs: CheckRunInfo[] = [];
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
      const endpoint =
        `repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs` +
        `?per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`;
      const result = await this.runApi(endpoint, 'checks');
      if (!result.ok) {
        return result;
      }

      const parsed = result.value as { check_runs?: unknown };
      if (!Array.isArray(parsed.check_runs)) {
        return fail('gh_transport', 'GitHub returned an unexpected check-runs payload.');
      }

      for (const run of parsed.check_runs) {
        const item = run as { name?: unknown; status?: unknown; conclusion?: unknown };
        runs.push({
          name: typeof item.name === 'string' ? item.name : '',
          status: typeof item.status === 'string' ? item.status : '',
          conclusion: typeof item.conclusion === 'string' ? item.conclusion : null,
        });
      }

      if (parsed.check_runs.length < CHECK_RUN_PAGE_SIZE) {
        break;
      }
    }

    return ok(runs);
  }

  private async runApi(endpoint: string, kind: CallKind): Promise<Evidence<unknown>> {
    const result = await this.runGh(['api', endpoint]);
    if (!result.ok) {
      if (result.code === 'gh_missing') {
        return result;
      }
      if (result.code === 'not_found') {
        if (kind === 'issue') {
          return fail('issue_not_found', 'GitHub reports this issue does not exist.');
        }
        if (kind === 'pr') {
          return fail('pr_not_found', 'GitHub reports this pull request does not exist.');
        }
      }
      if (result.code === 'not_found') {
        return fail('gh_transport', `GitHub lookup failed for ${sanitizeApiText(endpoint)}.`);
      }
      return fail('gh_transport', result.message, result.fix);
    }

    try {
      return ok(JSON.parse(result.value.stdout));
    } catch {
      return fail('gh_transport', 'GitHub returned a response that is not valid JSON.');
    }
  }

  private async runGh(args: string[]): Promise<
    | { ok: true; value: { stdout: string; stderr: string } }
    | (GhFailure & { ok: false; code: string; message: string; fix?: string; exitCode?: number })
  > {
    try {
      const { stdout, stderr } = await this.spawn(this.ghCommand, args, {
        timeoutMs: this.timeoutMs,
        maxBuffer: this.maxBuffer,
        env: this.env,
      });
      return { ok: true, value: { stdout, stderr: stderr ?? '' } };
    } catch (error) {
      if (isSpawnNotFoundError(error)) {
        return {
          ok: false,
          code: 'gh_missing',
          message: 'GitHub CLI (gh) is not installed or not on PATH.',
          fix: 'Install gh from https://cli.github.com/ and run "gh auth login".',
          error,
        };
      }

      const err = error as {
        killed?: boolean;
        signal?: NodeJS.Signals;
        code?: unknown;
        stderr?: unknown;
        message?: unknown;
      };

      if (err.killed || err.signal === 'SIGTERM') {
        return {
          ok: false,
          code: 'gh_transport',
          message: `GitHub CLI timed out after ${this.timeoutMs} ms.`,
          fix: 'Check your network connection and try again.',
          error,
        };
      }

      if (err.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER') {
        return {
          ok: false,
          code: 'gh_transport',
          message: 'GitHub CLI returned more output than the response size cap allows.',
          error,
        };
      }

      const stderr = typeof err.stderr === 'string' ? err.stderr : '';
      const exitCode = typeof err.code === 'number' ? err.code : undefined;
      if (/HTTP 404|Not Found/i.test(stderr)) {
        return {
          ok: false,
          code: 'not_found',
          message: sanitizeApiText(stderr || 'Not found.'),
          exitCode,
          error,
        };
      }

      const detail = sanitizeApiText(stderr || (typeof err.message === 'string' ? err.message : String(error)));
      return {
        ok: false,
        code: 'gh_transport',
        message: detail ? `GitHub CLI failed: ${detail}` : 'GitHub CLI failed.',
        exitCode,
        error,
      };
    }
  }
}
