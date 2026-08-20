import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

import { fail, ok, type Evidence } from '../../kernel/evidence.js';
import type { RepoRef } from '../../gitfacts/origin.js';
import { buildProtectionUpdateBody } from './protection-merge.js';
import type {
  BranchProtectionFact,
  CheckRunInfo,
  GitHubProvider,
  IssueCreation,
  IssueFact,
  OpenIssueFact,
  PrCreation,
  PrFact,
  PrSummary,
  RepoAutomergeFact,
} from '../../github/port.js';

/** Map a classic-protection payload to the reported fact (contexts only, never fabricated). */
function protectionFactFromPayload(payload: unknown): BranchProtectionFact {
  const contexts = (payload as { required_status_checks?: { contexts?: unknown } })
    .required_status_checks?.contexts;
  return {
    protected: true,
    requiredChecks: Array.isArray(contexts)
      ? contexts.filter((name): name is string => typeof name === 'string')
      : [],
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** SPECGIT_GH_TIMEOUT_MS (milliseconds) raises the per-call budget. */
function readEnvTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env.SPECGIT_GH_TIMEOUT_MS;
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const CHECK_RUN_PAGE_SIZE = 100;
const MAX_CHECK_RUN_PAGES = 10;
const ISSUE_SEARCH_PAGE_SIZE = 100;
/** GitHub's search API never returns more than 1000 results (10×100). */
const MAX_ISSUE_SEARCH_PAGES = 10;
const MAX_EMBEDDED_TEXT = 400;

/** gh stderr markers that mean "not authenticated" rather than transport. */
const AUTH_FAILURE_PATTERN = /HTTP 40[13]|Bad credentials|gh auth login|not logged in|authentication required/i;

const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;

export interface SpawnOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Body piped to the child's stdin (used by `--body-file -`). */
  stdin?: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => Promise<{ stdout: string; stderr: string }>;

const NODE_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?node/;

const shebangCache = new Map<string, boolean>();

/**
 * A gh command that resolves to a Node script (#!…node shebang) cannot be
 * executed directly on Windows. Detect that case once per path and re-run it
 * through the current Node executable; native binaries are untouched.
 * Exported for tests that wrap the spawn seam and must mirror this behavior.
 */
export function resolveNodeScriptCommand(command: string): { command: string; scriptArgs: string[] } {
  if (command === 'gh' || command === '') return { command, scriptArgs: [] };
  let isNodeScript: boolean;
  const cached = shebangCache.get(command);
  if (cached === undefined) {
    isNodeScript = false;
    try {
      const fd = fs.openSync(command, 'r');
      try {
        const buf = Buffer.alloc(128);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        isNodeScript = NODE_SHEBANG.test(buf.subarray(0, read).toString('utf-8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      isNodeScript = false;
    }
    shebangCache.set(command, isNodeScript);
  } else {
    isNodeScript = cached;
  }
  return isNodeScript ? { command: process.execPath, scriptArgs: [command] } : { command, scriptArgs: [] };
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  new Promise((resolve, reject) => {
    const resolved = resolveNodeScriptCommand(command);
    const child = execFile(
      resolved.command,
      [...resolved.scriptArgs, ...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        env: options.env,
        cwd: options.cwd,
        encoding: 'utf-8',
      },
      (error, stdout, stderr) => {
        if (error) {
          // Mirror promisify(execFile): keep captured output on the error so
          // the failure taxonomy can read err.stderr.
          const withOutput = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
          withOutput.stdout = stdout;
          withOutput.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr: stderr ?? '' });
        }
      }
    );
    // A child that exits before draining stdin raises EPIPE here; the
    // failure is already reported through the callback. stdin is always a
    // pipe unless stdio was customized, which this transport never does.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin ?? '');
    }
  });

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

type CallKind = 'issue' | 'pr' | 'checks' | 'search';

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
  private readonly explicitGhCommand: string | undefined;
  private readonly spawn: SpawnFn;

  constructor(options: GhCliGitHubProviderOptions = {}) {
    this.env = options.env;
    const envTimeout = readEnvTimeoutMs(options.env ?? process.env);
    this.timeoutMs = options.timeoutMs ?? envTimeout ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.explicitGhCommand = options.ghCommand;
    this.spawn = options.spawnImpl ?? defaultSpawn;
  }

  /**
   * Resolved per invocation so a runtime `SPECGIT_GH` in the injected or
   * process environment takes effect without re-construction. An explicit
   * `ghCommand` option always wins; `gh` is the fallback.
   */
  private resolveGhCommand(): string {
    return (
      this.explicitGhCommand ??
      this.env?.SPECGIT_GH ??
      process.env.SPECGIT_GH ??
      'gh'
    );
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
      title?: unknown;
      pull_request?: unknown;
    };
    if (typeof parsed.number !== 'number' || (parsed.state !== 'open' && parsed.state !== 'closed')) {
      return fail('gh_transport', 'GitHub returned an unexpected issue payload.');
    }

    return ok({
      number: parsed.number,
      state: parsed.state,
      pullRequest: parsed.pull_request != null,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
    });
  }

  /**
   * Every open issue as a title-carrying fact via the search API
   * (excludes PRs, newest first) — the one probe the adoption path reads
   * (#77). Evidence-completeness rule (#120, I3b): the list is paginated
   * to exhaustion, and any truncation signal — GitHub's own
   * `incomplete_results: true` or the 1000-result search cap reached with
   * a full page — fails closed with `evidence_truncated` (exit 3) instead
   * of returning a silently partial list.
   */
  async getOpenIssues(repo: RepoRef): Promise<Evidence<OpenIssueFact[]>> {
    const byNumber = new Map<number, OpenIssueFact>();
    for (let page = 1; page <= MAX_ISSUE_SEARCH_PAGES; page += 1) {
      const endpoint =
        `search/issues?q=repo:${repo.owner}/${repo.repo}+is:issue+is:open` +
        `&per_page=${ISSUE_SEARCH_PAGE_SIZE}&page=${page}`;
      const result = await this.runApi(endpoint, 'search');
      if (!result.ok) {
        return result;
      }
      const parsed = result.value as { items?: unknown; incomplete_results?: unknown };
      if (!Array.isArray(parsed.items)) {
        return fail('gh_transport', 'GitHub returned an unexpected issue-search payload.');
      }
      if (parsed.incomplete_results === true) {
        return fail(
          'evidence_truncated',
          'GitHub reports the open-issue search as incomplete; the list may be missing issues.'
        );
      }
      for (const item of parsed.items) {
        const number = (item as { number?: unknown }).number;
        if (typeof number !== 'number') continue;
        // Deduplicate: a page-boundary shift between calls (an issue
        // opened mid-pagination) can repeat an entry across pages.
        if (byNumber.has(number)) continue;
        const title = (item as { title?: unknown }).title;
        const body = (item as { body?: unknown }).body;
        byNumber.set(number, {
          number,
          ...(typeof title === 'string' && title ? { title } : {}),
          ...(typeof body === 'string' ? { body } : {}),
        });
      }
      if (parsed.items.length < ISSUE_SEARCH_PAGE_SIZE) {
        return ok([...byNumber.values()]);
      }
    }
    return fail(
      'evidence_truncated',
      `GitHub's issue search caps at ${MAX_ISSUE_SEARCH_PAGES * ISSUE_SEARCH_PAGE_SIZE} results; ` +
        'the open-issue list may be truncated.'
    );
  }

  /**
   * Open-issue numbers for the ordered-issues sequencing gate, derived
   * from the same complete title-carrying scan as `getOpenIssues` — one
   * completeness contract, one pagination implementation.
   */
  async getOpenIssueNumbers(repo: RepoRef): Promise<Evidence<number[]>> {
    const issues = await this.getOpenIssues(repo);
    if (!issues.ok) {
      return issues;
    }
    return ok(issues.value.map((fact) => fact.number));
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
      merge_commit_sha?: unknown;
      draft?: unknown;
      head?: { ref?: unknown; sha?: unknown };
      base?: { ref?: unknown };
      body?: unknown;
    };
    if (
      typeof parsed.number !== 'number' ||
      (parsed.state !== 'open' && parsed.state !== 'closed') ||
      typeof parsed.draft !== 'boolean'
    ) {
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
      mergeCommitSha:
        typeof parsed.merge_commit_sha === 'string' && parsed.merge_commit_sha.length > 0
          ? parsed.merge_commit_sha
          : null,
      draft: parsed.draft,
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
        const item = run as {
          name?: unknown;
          status?: unknown;
          conclusion?: unknown;
          id?: unknown;
          started_at?: unknown;
        };
        runs.push({
          name: typeof item.name === 'string' ? item.name : '',
          status: typeof item.status === 'string' ? item.status : '',
          conclusion: typeof item.conclusion === 'string' ? item.conclusion : null,
          id: typeof item.id === 'number' ? item.id : 0,
          startedAt: typeof item.started_at === 'string' ? item.started_at : null,
        });
      }

      if (parsed.check_runs.length < CHECK_RUN_PAGE_SIZE) {
        return ok(runs);
      }
    }
    // Evidence-completeness rule (#120, I3b): the page cap was reached
    // with a full page — more runs may exist beyond it. Never return a
    // silently partial list; fail closed instead.
    return fail(
      'evidence_truncated',
      `Check-run pagination hit its cap (${MAX_CHECK_RUN_PAGES * CHECK_RUN_PAGE_SIZE} runs); ` +
        'the check-run list may be truncated.'
    );
  }

  async createIssue(repo: RepoRef, title: string, body: string): Promise<Evidence<IssueCreation>> {
    if (!title.trim()) {
      return fail('gh_transport', 'Cannot create an issue without a title.');
    }

    const result = await this.runCreateGh([
      'api',
      `repos/${repo.owner}/${repo.repo}/issues`,
      '-f',
      `title=${title}`,
      '-f',
      `body=${body}`,
    ]);
    if (!result.ok) {
      return result;
    }

    const parsed = this.parseJsonOutput(result.value.stdout);
    if (!parsed.ok) {
      return parsed;
    }
    const issue = parsed.value as { number?: unknown; html_url?: unknown };
    if (typeof issue.number !== 'number' || typeof issue.html_url !== 'string' || !issue.html_url) {
      return fail('gh_transport', 'GitHub returned an unexpected issue payload.');
    }
    return ok({ number: issue.number, url: issue.html_url });
  }

  /**
   * Draft PRs cannot be created through the REST pulls API:
   * POST /repos/{owner}/{repo}/pulls has no draft parameter — a draft can
   * only be created via GraphQL createPullRequest(input: { draft: true }),
   * which `gh pr create --draft` performs. So this method shells out to gh,
   * streams the body over stdin (`--body-file -`, keeping bodies out of
   * argv), and parses the PR URL gh prints into {number, url}.
   */
  async createDraftPr(
    repo: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<Evidence<PrCreation>> {
    if (!head.trim() || !base.trim() || !title.trim()) {
      return fail('gh_transport', 'Cannot create a pull request without a head, base, and title.');
    }

    const result = await this.runCreateGh(
      [
        'pr',
        'create',
        '--draft',
        '--repo',
        `${repo.owner}/${repo.repo}`,
        '--head',
        head,
        '--base',
        base,
        '--title',
        title,
        '--body-file',
        '-',
      ],
      body
    );
    if (!result.ok) {
      return result;
    }

    const match = result.value.stdout.match(PR_URL_PATTERN);
    if (!match) {
      return fail('gh_transport', 'GitHub CLI did not report a pull request URL.');
    }
    return ok({ number: Number(match[1]), url: match[0] });
  }

  /**
   * PR discovery by head branch (`gh pr list --state open`). Used by
   * `specgit pr` to repair a binding: exactly one candidate binds, zero
   * or several refuse. Auth failures classify from stderr like the
   * other creation paths.
   */
  async listOpenPrsByHead(repo: RepoRef, head: string): Promise<Evidence<PrSummary[]>> {
    if (!head.trim()) {
      return fail('gh_transport', 'Cannot list pull requests without a head branch.');
    }

    const result = await this.runCreateGh([
      'pr',
      'list',
      '--repo',
      `${repo.owner}/${repo.repo}`,
      '--head',
      head,
      '--state',
      'open',
      '--json',
      'number,title,url',
      '--limit',
      '30',
    ]);
    if (!result.ok) {
      return result;
    }

    const parsed = this.parseJsonOutput(result.value.stdout);
    if (!parsed.ok) {
      return parsed;
    }
    if (!Array.isArray(parsed.value)) {
      return fail('gh_transport', 'GitHub returned an unexpected pull-request list payload.');
    }
    const prs: PrSummary[] = [];
    for (const entry of parsed.value) {
      const item = entry as { number?: unknown; title?: unknown; url?: unknown };
      if (
        typeof item.number !== 'number' ||
        typeof item.title !== 'string' ||
        typeof item.url !== 'string'
      ) {
        return fail('gh_transport', 'GitHub returned an unexpected pull-request list payload.');
      }
      prs.push({ number: item.number, title: item.title, url: item.url });
    }
    return ok(prs);
  }

  /**
   * Branch protection lookup. A 404 means GitHub reports the branch as
   * not protected — evidence, not an error. (Ruleset-only protection also
   * surfaces as 404 here; the classic endpoint cannot distinguish it.)
   */
  async getBranchProtection(repo: RepoRef, branch: string): Promise<Evidence<BranchProtectionFact>> {
    if (!branch.trim()) {
      return fail('gh_transport', 'Cannot query branch protection without a branch name.');
    }
    const payloadEv = await this.fetchProtectionPayload(repo, branch);
    if (!payloadEv.ok) {
      return payloadEv;
    }
    if (payloadEv.value === null) {
      return ok({ protected: false, requiredChecks: [] });
    }
    return ok(protectionFactFromPayload(payloadEv.value));
  }

  /**
   * Read-modify-write: read the current protection, PUT a body that adds
   * `requiredCheck` while preserving required checks, reviews, push
   * restrictions, admin enforcement, and rule booleans (#62: never weaken
   * existing governance). The reported fact comes from the server's
   * post-update payload — a response we cannot parse is reported as a
   * failure to verify, never as a fabricated check list.
   */
  async enableBranchProtection(
    repo: RepoRef,
    branch: string,
    requiredCheck: string
  ): Promise<Evidence<BranchProtectionFact>> {
    if (!branch.trim() || !requiredCheck.trim()) {
      return fail('gh_transport', 'Cannot enable branch protection without a branch and check name.');
    }
    const currentEv = await this.fetchProtectionPayload(repo, branch);
    if (!currentEv.ok) {
      return currentEv;
    }
    const body = JSON.stringify(buildProtectionUpdateBody(currentEv.value, requiredCheck));
    const result = await this.runAdminApi(
      ['api', '-X', 'PUT', `repos/${repo.owner}/${repo.repo}/branches/${branch}/protection`, '--input', '-'],
      body
    );
    if (!result.ok) {
      return result;
    }
    const parsed = this.parseJsonOutput(result.value.stdout);
    if (!parsed.ok) {
      return parsed;
    }
    const payload = parsed.value as { required_status_checks?: { contexts?: unknown } };
    if (!Array.isArray(payload.required_status_checks?.contexts)) {
      return fail(
        'gh_transport',
        'Protection was applied but the response could not be verified: no required_status_checks.contexts.'
      );
    }
    return ok(protectionFactFromPayload(payload));
  }

  /** Raw classic-protection payload; null when the branch is not protected (404). */
  private async fetchProtectionPayload(repo: RepoRef, branch: string): Promise<Evidence<unknown | null>> {
    const result = await this.runAdminApi([
      'api',
      `repos/${repo.owner}/${repo.repo}/branches/${branch}/protection`,
    ]);
    if (!result.ok) {
      if (result.code === 'not_found') {
        return ok(null);
      }
      return result;
    }
    return this.parseJsonOutput(result.value.stdout);
  }

  async getRepoAutomerge(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> {
    const result = await this.runAdminApi(['api', `repos/${repo.owner}/${repo.repo}`]);
    if (!result.ok) {
      return result;
    }
    const parsed = this.parseJsonOutput(result.value.stdout);
    if (!parsed.ok) {
      return parsed;
    }
    const payload = parsed.value as { allow_auto_merge?: unknown };
    return ok({ enabled: payload.allow_auto_merge === true });
  }

  async enableRepoAutomerge(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> {
    const body = JSON.stringify({ allow_auto_merge: true });
    const result = await this.runAdminApi(
      ['api', '-X', 'PATCH', `repos/${repo.owner}/${repo.repo}`, '--input', '-'],
      body
    );
    if (!result.ok) {
      return result;
    }
    const parsed = this.parseJsonOutput(result.value.stdout);
    if (!parsed.ok) {
      return parsed;
    }
    const payload = parsed.value as { allow_auto_merge?: unknown };
    return ok({ enabled: payload.allow_auto_merge === true });
  }

  private parseJsonOutput(stdout: string): Evidence<unknown> {
    try {
      return ok(JSON.parse(stdout));
    } catch {
      return fail('gh_transport', 'GitHub returned a response that is not valid JSON.');
    }
  }

  /**
   * Repository-administration calls (branch protection, auto-merge). Unlike
   * runCreateGh, HTTP 403 means missing admin permission — a transport
   * fact for the caller to report, not an authentication problem — and
   * not_found passes through so reads can treat it as evidence.
   */
  private async runAdminApi(
    args: string[],
    stdin?: string
  ): Promise<
    | { ok: true; value: { stdout: string; stderr: string } }
    | { ok: false; code: string; message: string; fix?: string }
  > {
    const result = await this.runGh(args, stdin);
    if (!result.ok) {
      if (result.code === 'gh_missing' || result.code === 'not_found') {
        return { ok: false, code: result.code, message: result.message, ...(result.fix ? { fix: result.fix } : {}) };
      }
      if (/HTTP 401|Bad credentials|gh auth login|not logged in|authentication required/i.test(result.message)) {
        return fail(
          'gh_unauthenticated',
          'GitHub CLI is not authenticated.',
          'Run "gh auth login" to authenticate.'
        );
      }
      return fail('gh_transport', result.message, result.fix);
    }
    return result;
  }

  /**
   * Creation calls share the read taxonomy but classify authentication
   * failures from gh's stderr (HTTP 401/403, "gh auth login" prompts)
   * instead of relying on `gh auth status`.
   */
  private async runCreateGh(
    args: string[],
    stdin?: string
  ): Promise<
    | { ok: true; value: { stdout: string; stderr: string } }
    | { ok: false; code: string; message: string; fix?: string }
  > {
    const result = await this.runGh(args, stdin);
    if (!result.ok) {
      if (result.code === 'gh_missing') {
        return result;
      }
      if (AUTH_FAILURE_PATTERN.test(result.message)) {
        return fail(
          'gh_unauthenticated',
          'GitHub CLI is not authenticated.',
          'Run "gh auth login" to authenticate.'
        );
      }
      // Timeouts carry their own attributed diagnostic; do not flatten
      // them into the generic transport failure.
      if (result.code === 'gh_timeout') {
        return { ok: false, code: result.code, message: result.message, ...(result.fix ? { fix: result.fix } : {}) };
      }
      return fail('gh_transport', result.message, result.fix);
    }
    return result;
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

  private async runGh(args: string[], stdin?: string): Promise<
    | { ok: true; value: { stdout: string; stderr: string } }
    | (GhFailure & { ok: false; code: string; message: string; fix?: string; exitCode?: number })
  > {
    try {
      const { stdout, stderr } = await this.spawn(this.resolveGhCommand(), args, {
        timeoutMs: this.timeoutMs,
        maxBuffer: this.maxBuffer,
        env: this.env,
        stdin,
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
          code: 'gh_timeout',
          message: `GitHub CLI timed out after ${this.timeoutMs} ms.`,
          fix: 'A timeout this basic points at one of three causes — check in order: (1) network reachability (curl -sI https://api.github.com), (2) a GitHub incident (https://www.githubstatus.com), (3) a genuinely slow call — raise the budget via SPECGIT_GH_TIMEOUT_MS (milliseconds).',
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
