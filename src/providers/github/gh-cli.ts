import { fail, ok, type Evidence } from '../../kernel/evidence.js';
import type { RepoRef } from '../../gitfacts/origin.js';
import { buildProtectionUpdateBody } from './protection-merge.js';
// Shared CLI transport (spawn seam, shebang resolution, sanitization);
// re-exported below for import-path stability (#114 moved the transport
// beside the adapters so the GitLab adapter shares it).
import { defaultSpawn, sanitizeApiText, type SpawnFn } from '../cli-spawn.js';
export { resolveNodeScriptCommand, sanitizeApiText } from '../cli-spawn.js';
export type { SpawnFn, SpawnOptions } from '../cli-spawn.js';
// The shared CLI-evidence transport (#274): pagination to exhaustion,
// JSON decoding, and the spawn-failure taxonomy exist once there.
import {
  classifySpawnError,
  decodeJsonResponse,
  evidenceTruncated,
  paginateToExhaustion,
  type CliRunOutcome,
} from '../cli-evidence-transport.js';
import type {
  BranchProtectionFact,
  CheckRunInfo,
  EvidenceAnchorFact,
  ForgeProvider,
  IssueCreation,
  IssueCommentCreation,
  IssueFact,
  LabelsAppliedFact,
  MergeChecksFact,
  OpenIssueFact,
  PrCreation,
  PrFact,
  PrSummary,
  PreflightFact,
  RepoAutomergeFact,
  RepoLabelsFact,
} from '../../github/port.js';
import type { TagSpec } from '../../tags/catalog.js';
import { isLaterCheckRun } from '../../github/check-runs.js';

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
const TIMELINE_PAGE_SIZE = 100;
/** Completeness guard: pagination beyond this cap fails closed. */
const MAX_TIMELINE_PAGES = 10;
const ISSUE_SEARCH_PAGE_SIZE = 100;
/** GitHub's search API never returns more than 1000 results (10×100). */
const MAX_ISSUE_SEARCH_PAGES = 10;

/** gh stderr markers that mean "not authenticated" rather than transport. */
const AUTH_FAILURE_PATTERN = /HTTP 40[13]|Bad credentials|gh auth login|not logged in|authentication required/i;

/** gh stderr markers that mean the looked-up resource does not exist. */
const NOT_FOUND_PATTERN = /HTTP 404|Not Found/i;

const LABEL_PAGE_SIZE = 100;
/** Completeness guard for the label-pool probe (#330), same discipline as the timeline pages. */
const MAX_LABEL_PAGES = 10;
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 10;

/** GitHub's 422 validation failure when a label already exists names it in the payload. */
const LABEL_ALREADY_EXISTS_PATTERN = /already.?exist(s)?/i;

const TIMEOUT_FIX =
  'A timeout this basic points at one of three causes — check in order: ' +
  '(1) network reachability (curl -sI https://api.github.com), ' +
  '(2) a GitHub incident (https://www.githubstatus.com), ' +
  '(3) a genuinely slow call — raise the budget via SPECGIT_GH_TIMEOUT_MS (milliseconds).';

const PR_URL_PATTERN = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;

export interface GhCliGitHubProviderOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  ghCommand?: string;
  spawnImpl?: SpawnFn;
}

type CallKind = 'issue' | 'pr' | 'checks' | 'search' | 'labels';

/**
 * The only real GitHub transport: the `gh` CLI. Detection → auth → invoke;
 * array execFile args only, hard timeout, response size cap, JSON-only
 * responses, no silent fallback. All failures are evidence — none of them
 * pass acceptance. Implements both port surfaces (#180): the read surface
 * (`ForgeReadPort`) and the admin surface (`ForgeAdminPort`).
 */
export class GhCliGitHubProvider implements ForgeProvider {
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

  async preflight(): Promise<Evidence<PreflightFact>> {
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
    if (!parsed || parsed.number !== n || (parsed.state !== 'open' && parsed.state !== 'closed')) {
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
    const pagesEv = await paginateToExhaustion<unknown>(
      {
        pageSize: ISSUE_SEARCH_PAGE_SIZE,
        maxPages: MAX_ISSUE_SEARCH_PAGES,
        what: "GitHub's issue search",
        capMessage:
          `GitHub's issue search caps at ${MAX_ISSUE_SEARCH_PAGES * ISSUE_SEARCH_PAGE_SIZE} results; ` +
          'the open-issue list may be truncated.',
      },
      async (page) => {
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
          return evidenceTruncated(
            'GitHub reports the open-issue search as incomplete; the list may be missing issues.'
          );
        }
        return ok(parsed.items);
      }
    );
    if (!pagesEv.ok) {
      return pagesEv;
    }
    const byNumber = new Map<number, OpenIssueFact>();
    for (const item of pagesEv.value) {
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
    return ok([...byNumber.values()]);
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
      !parsed || parsed.number !== Number(ref) ||
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

    return paginateToExhaustion<CheckRunInfo>(
      {
        pageSize: CHECK_RUN_PAGE_SIZE,
        maxPages: MAX_CHECK_RUN_PAGES,
        what: 'Check-run',
        capMessage:
          `Check-run pagination hit its cap (${MAX_CHECK_RUN_PAGES * CHECK_RUN_PAGE_SIZE} runs); ` +
          'the check-run list may be truncated.',
      },
      async (page) => {
        const endpoint =
          `repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs` +
          `?per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`;
        const result = await this.runApi(endpoint, 'checks');
        if (!result.ok) {
          return result;
        }

        const parsed = result.value as { check_runs?: unknown } | null;
        if (!Array.isArray(parsed?.check_runs)) {
          return fail('gh_transport', 'GitHub returned an unexpected check-runs payload.');
        }
        if (parsed.check_runs.some((run) => run === null || typeof run !== 'object')) {
          return fail('gh_transport', 'GitHub returned a malformed check run.');
        }

        return ok(
          parsed.check_runs.map((run) => {
            const item = run as {
              name?: unknown;
              status?: unknown;
              conclusion?: unknown;
              id?: unknown;
              started_at?: unknown;
              app?: { id?: unknown };
            };
            return {
              name: typeof item.name === 'string' ? item.name : '',
              status: typeof item.status === 'string' ? item.status : '',
              conclusion: typeof item.conclusion === 'string' ? item.conclusion : null,
              id: typeof item.id === 'number' ? item.id : 0,
              startedAt: typeof item.started_at === 'string' ? item.started_at : null,
              ...(typeof item.app?.id === 'number' && Number.isSafeInteger(item.app.id) && item.app.id > 0
                ? { source: `app:${item.app.id}` } : {}),
            };
          })
        );
      }
    );
  }

  async getPrChecks(repo: RepoRef, pr: number): Promise<Evidence<MergeChecksFact>> {
    const request = await this.getPr(repo, pr);
    if (!request.ok) return request;
    const headSha = request.value.headSha;
    const runs = await this.getCheckRuns(repo, headSha);
    if (!runs.ok) return runs;
    const checks = new Map<string, CheckRunInfo>();
    const recordAttempt = (key: string, run: CheckRunInfo): Evidence<true> => {
      const previous = checks.get(key);
      // Workflow reruns keep their creation ID. An undated attempt cannot
      // be proven older than a green run, even when its ID is lower.
      if (previous && [previous, run].some((attempt) =>
        attempt.startedAt === null || !Number.isFinite(Date.parse(attempt.startedAt)))) {
        return fail('gh_transport', 'Cannot order multiple CI attempts without valid start timestamps.');
      }
      if (!previous || isLaterCheckRun(run, previous)) checks.set(key, run);
      return ok(true);
    };
    for (const run of runs.value) {
      if (!run.name || !run.status || !run.source || !Number.isSafeInteger(run.id) || run.id <= 0 ||
          (run.status === 'completed' && !run.conclusion)) {
        return fail('gh_transport', 'GitHub returned incomplete check-run evidence.');
      }
      const key = `${run.source ?? 'check'}:${run.name}`;
      const selected = recordAttempt(key, run);
      if (!selected.ok) return selected;
    }
    // Classic commit statuses and workflow runs are independent evidence:
    // a workflow awaiting approval can have no check jobs at all (#265).
    for (const kind of ['statuses', 'workflows'] as const) {
      const rows = await paginateToExhaustion<unknown>(
        { pageSize: 100, maxPages: 10, what: kind === 'statuses' ? 'Commit-status' : 'Workflow-run' },
        async (page) => {
          const endpoint = kind === 'statuses'
            ? `repos/${repo.owner}/${repo.repo}/commits/${headSha}/statuses?per_page=100&page=${page}`
            : `repos/${repo.owner}/${repo.repo}/actions/runs?head_sha=${headSha}&per_page=100&page=${page}`;
          const result = await this.runApi(endpoint, 'checks');
          if (!result.ok) return result;
          const values = kind === 'statuses' ? result.value
            : (result.value as { workflow_runs?: unknown } | null)?.workflow_runs;
          return Array.isArray(values) ? ok(values)
            : fail('gh_transport', `GitHub returned an unexpected ${kind} payload.`);
        }
      );
      if (!rows.ok) return rows;
      for (const row of rows.value) {
        if (row === null || typeof row !== 'object') return fail('gh_transport', 'GitHub returned malformed CI evidence.');
        const value = row as Record<string, unknown>;
        if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) {
          return fail('gh_transport', 'GitHub returned CI evidence without an attempt identity.');
        }
        let key: string;
        let run: CheckRunInfo;
        if (kind === 'statuses') {
          if (typeof value.context !== 'string' || !value.context ||
              !['pending', 'success', 'failure', 'error'].includes(String(value.state))) {
            return fail('gh_transport', 'GitHub returned an unexpected commit status.');
          }
          key = `status:${value.context}`;
          run = { name: value.context, status: value.state === 'pending' ? 'in_progress' : 'completed',
            conclusion: value.state === 'pending' ? null : String(value.state), id: value.id,
            startedAt: typeof value.created_at === 'string' ? value.created_at : null };
        } else {
          if (value.head_sha !== headSha || typeof value.workflow_id !== 'number' ||
              !Number.isSafeInteger(value.workflow_id) || value.workflow_id <= 0 ||
              typeof value.event !== 'string' || typeof value.name !== 'string' ||
              typeof value.status !== 'string' ||
              (value.status === 'completed' && typeof value.conclusion !== 'string')) {
            return fail('gh_transport', 'GitHub returned incomplete or stale workflow evidence.');
          }
          key = `workflow:${value.workflow_id}:${value.event}`;
          run = { name: `workflow: ${value.name} (${value.event})`, status: value.status,
            conclusion: typeof value.conclusion === 'string' ? value.conclusion : null, id: value.id,
            startedAt: typeof value.run_started_at === 'string' ? value.run_started_at : null };
        }
        const selected = recordAttempt(key, run);
        if (!selected.ok) return selected;
      }
    }
    return ok({ headSha, checks: [...checks.values()] });
  }

  async mergePr(repo: RepoRef, pr: number, expectedHeadSha: string): Promise<Evidence<{ merged: boolean }>> {
    if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[0-9a-f]{40}$/i.test(expectedHeadSha)) {
      return fail('gh_transport', 'A pull request and full expected head SHA are required to merge.');
    }
    const result = await this.runCreateGh(
      ['api', '-X', 'PUT', `repos/${repo.owner}/${repo.repo}/pulls/${pr}/merge`, '--input', '-'],
      JSON.stringify({ sha: expectedHeadSha, merge_method: 'merge' })
    );
    if (!result.ok) return result;
    const payload = this.parseJsonOutput(result.value.stdout);
    if (!payload.ok) return payload;
    const merged = (payload.value as { merged?: unknown } | null)?.merged;
    return typeof merged === 'boolean' ? ok({ merged })
      : fail('gh_transport', 'GitHub did not confirm the merge result.');
  }

  async closeIssue(repo: RepoRef, issue: number): Promise<Evidence<{ closed: boolean }>> {
    const before = await this.getIssue(repo, issue);
    if (!before.ok) return before;
    if (before.value.pullRequest) return fail('gh_transport', 'Issue closure cannot close an unmerged pull request.');
    if (before.value.state === 'closed') return ok({ closed: true });
    const result = await this.runCreateGh(
      ['api', '-X', 'PATCH', `repos/${repo.owner}/${repo.repo}/issues/${issue}`, '--input', '-'],
      JSON.stringify({ state: 'closed' })
    );
    if (!result.ok) return result;
    const after = await this.getIssue(repo, issue);
    return after.ok ? ok({ closed: after.value.state === 'closed' && !after.value.pullRequest }) : after;
  }

  /**
   * Check-freshness anchor (#315): the delivery's reviewable moment on
   * GitHub is its latest ready-for-review transition — the
   * `ready_for_review` event on the PR issue's timeline (`gh api
   * repos/{owner}/{repo}/issues/{n}/timeline`; every pull request is an
   * issue). The fact carries that event's `created_at` verbatim or
   * `null` when no such event exists (a PR never marked ready — a draft
   * has none), never a fabricated or re-encoded instant.
   *
   * Evidence-completeness rule (#120, I3b): the timeline is paginated
   * to exhaustion; the cap reached with a full page fails closed
   * (`evidence_truncated`). Selection never trusts response order
   * (#119 discipline): the anchor is the maximum `created_at` across
   * every `ready_for_review` event on every page — equal timestamps
   * keep the later event — so a re-ordered page cannot change the
   * fact. A `ready_for_review` event whose `created_at` is absent
   * fails closed: an unparsable transition is reported, never silently
   * dropped (same discipline as a PR payload omitting the draft flag).
   */
  async getEvidenceAnchor(
    repo: RepoRef,
    pr: number | string
  ): Promise<Evidence<EvidenceAnchorFact>> {
    const ref = String(pr);
    if (!/^\d+$/.test(ref)) {
      return fail(
        'pr_not_found',
        `Cannot resolve pull request reference "${sanitizeApiText(ref)}".`,
        'Bind the PR by number or a full github.com pull request URL.'
      );
    }
    const pagesEv = await paginateToExhaustion<unknown>(
      {
        pageSize: TIMELINE_PAGE_SIZE,
        maxPages: MAX_TIMELINE_PAGES,
        what: 'Timeline-event',
        capMessage:
          `Timeline pagination hit its cap (${MAX_TIMELINE_PAGES * TIMELINE_PAGE_SIZE} events); ` +
          'the ready-for-review anchor may be missing.',
      },
      async (page) => {
        const endpoint =
          `repos/${repo.owner}/${repo.repo}/issues/${ref}/timeline` +
          `?per_page=${TIMELINE_PAGE_SIZE}&page=${page}`;
        const result = await this.runApi(endpoint, 'pr');
        if (!result.ok) {
          return result;
        }
        if (!Array.isArray(result.value)) {
          return fail('gh_transport', 'GitHub returned an unexpected timeline payload.');
        }
        return ok(result.value);
      }
    );
    if (!pagesEv.ok) {
      return pagesEv;
    }
    let anchoredAt: string | null = null;
    let anchorTime: number | null = null;
    for (const entry of pagesEv.value) {
      const event = entry as { event?: unknown; created_at?: unknown };
      if (event.event !== 'ready_for_review') continue;
      if (typeof event.created_at !== 'string' || event.created_at === '') {
        return fail(
          'gh_transport',
          'GitHub returned a ready-for-review event without a timestamp.'
        );
      }
      const eventTime = Date.parse(event.created_at);
      if (Number.isNaN(eventTime)) {
        return fail(
          'gh_transport',
          'GitHub returned a ready-for-review event with an invalid timestamp.'
        );
      }
      if (anchoredAt === null || anchorTime === null || eventTime > anchorTime) {
        anchoredAt = event.created_at;
        anchorTime = eventTime;
      }
    }
    return ok({ anchoredAt });
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

  async addIssueComment(
    repo: RepoRef,
    issue: number,
    body: string
  ): Promise<Evidence<IssueCommentCreation>> {
    if (!Number.isInteger(issue) || issue <= 0) {
      return fail('gh_transport', 'Cannot comment on an issue without a positive number.');
    }
    if (!body.trim()) {
      return fail('gh_transport', 'Cannot post an empty issue comment.');
    }

    // #380: a successful POST may lose its response, or a later issue may
    // fail. Reconcile remote comments before retrying either partial run.
    const existing = await paginateToExhaustion<unknown>(
      { pageSize: COMMENT_PAGE_SIZE, maxPages: MAX_COMMENT_PAGES, what: 'Issue-comment' },
      async (page) => {
        const result = await this.runApi(
          `repos/${repo.owner}/${repo.repo}/issues/${issue}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
          'issue'
        );
        if (!result.ok) return result;
        return Array.isArray(result.value)
          ? ok(result.value)
          : fail('gh_transport', 'GitHub returned an unexpected issue-comment list.');
      }
    );
    if (!existing.ok) return existing;
    let matchingUrl: string | undefined;
    for (const entry of existing.value) {
      if (typeof entry !== 'object' || entry === null) {
        return fail('gh_transport', 'GitHub returned an unexpected issue-comment entry.');
      }
      const comment = entry as { body?: unknown; html_url?: unknown };
      if (typeof comment.body !== 'string' || typeof comment.html_url !== 'string' || !comment.html_url) {
        return fail('gh_transport', 'GitHub returned an unexpected issue-comment entry.');
      }
      if (comment.body === body) matchingUrl ??= comment.html_url;
    }
    if (matchingUrl !== undefined) return ok({ url: matchingUrl });

    const result = await this.runCreateGh([
      'api',
      `repos/${repo.owner}/${repo.repo}/issues/${issue}/comments`,
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
    const comment = parsed.value as { html_url?: unknown };
    if (typeof comment.html_url !== 'string' || !comment.html_url) {
      return fail('gh_transport', 'GitHub returned an unexpected issue-comment payload.');
    }
    return ok({ url: comment.html_url });
  }

  /**
   * Add labels to an issue (#330): one POST, union semantics — the API
   * merges requested names into whatever the issue already carries. The
   * response lists every label on the issue after the apply; every
   * requested slug must appear in it or the result cannot be verified
   * (fail-closed, same discipline as a protection update whose payload
   * omits the contexts).
   */
  async addIssueLabels(
    repo: RepoRef,
    issue: number,
    slugs: string[]
  ): Promise<Evidence<LabelsAppliedFact>> {
    if (!Number.isInteger(issue) || issue <= 0) {
      return fail('gh_transport', 'Cannot label an issue without a positive number.');
    }
    if (slugs.length === 0 || slugs.some((slug) => !slug.trim())) {
      return fail('gh_transport', 'Cannot label an issue without at least one non-empty label.');
    }

    const body = JSON.stringify({ labels: slugs });
    const result = await this.runCreateGh(
      ['api', '-X', 'POST', `repos/${repo.owner}/${repo.repo}/issues/${issue}/labels`, '--input', '-'],
      body
    );
    if (!result.ok) {
      return result;
    }
    const parsed = this.parseJsonOutput(result.value.stdout);
    if (!parsed.ok) {
      return parsed;
    }
    const carried = this.labelNamesFromPayload(parsed.value);
    if (carried === null) {
      return fail('gh_transport', 'GitHub returned an unexpected issue-labels payload.');
    }
    for (const slug of slugs) {
      if (!carried.includes(slug)) {
        return fail(
          'gh_transport',
          `Label '${sanitizeApiText(slug)}' is absent after the apply; the result could not be verified.`
        );
      }
    }
    return ok({ names: slugs });
  }

  /** Label titles from a GitHub labels payload; null when it is not an array of names. */
  private labelNamesFromPayload(payload: unknown): string[] | null {
    if (!Array.isArray(payload)) {
      return null;
    }
    const names: string[] = [];
    for (const entry of payload) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== 'string' || name === '') {
        return null;
      }
      names.push(name);
    }
    return names;
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

  /**
   * Every label title the repository carries (#330): the pool the tag
   * selection runs against. Paginated to exhaustion — completeness rule
   * (#120, I3b) applies: a cap-truncated pool fails closed rather than
   * reading as a silently partial selection universe.
   */
  async listRepoLabels(repo: RepoRef): Promise<Evidence<RepoLabelsFact>> {
    const pagesEv = await paginateToExhaustion<unknown>(
      {
        pageSize: LABEL_PAGE_SIZE,
        maxPages: MAX_LABEL_PAGES,
        what: 'Repository-label',
        capMessage:
          `Label pagination hit its cap (${MAX_LABEL_PAGES * LABEL_PAGE_SIZE} labels); ` +
          'the label pool may be truncated.',
      },
      async (page) => {
        const endpoint = `repos/${repo.owner}/${repo.repo}/labels?per_page=${LABEL_PAGE_SIZE}&page=${page}`;
        const result = await this.runApi(endpoint, 'labels');
        if (!result.ok) {
          return result;
        }
        if (!Array.isArray(result.value)) {
          return fail('gh_transport', 'GitHub returned an unexpected label-list payload.');
        }
        return ok(result.value);
      }
    );
    if (!pagesEv.ok) {
      return pagesEv;
    }
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of pagesEv.value) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== 'string' || name === '') {
        return fail('gh_transport', 'GitHub returned a label entry without a name.');
      }
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return ok({ names });
  }

  /**
   * Idempotent seed (#330): create every missing spec, leave existing
   * names untouched, and echo exactly the requested slugs as confirmed.
   * A creation that fails on anything other than already-exists fails
   * closed — an unconfirmed slug never enters the fact.
   */
  async ensureRepoLabels(
    repo: RepoRef,
    specs: TagSpec[]
  ): Promise<Evidence<LabelsAppliedFact>> {
    if (specs.length === 0) {
      return ok({ names: [] });
    }
    for (const spec of specs) {
      if (!spec.name.trim() || !/^[0-9a-fA-F]{6}$/.test(spec.color)) {
        return fail('gh_transport', 'Cannot seed a label without a name and six-hex color.');
      }
    }

    const existingEv = await this.listRepoLabels(repo);
    if (!existingEv.ok) {
      return existingEv;
    }
    const present = new Set(existingEv.value.names);

    const confirmed: string[] = [];
    for (const spec of specs) {
      if (present.has(spec.name)) {
        confirmed.push(spec.name);
        continue;
      }
      const result = await this.runAdminApi([
        'api',
        '-X',
        'POST',
        `repos/${repo.owner}/${repo.repo}/labels`,
        '-f',
        `name=${spec.name}`,
        '-f',
        `color=${spec.color}`,
      ]);
      if (!result.ok) {
        // Already-exists (a concurrent seed won the race) is presence.
        if (!LABEL_ALREADY_EXISTS_PATTERN.test(result.message)) {
          return result;
        }
        confirmed.push(spec.name);
        continue;
      }
      const parsed = this.parseJsonOutput(result.value.stdout);
      if (!parsed.ok) {
        return parsed;
      }
      const created = parsed.value as { name?: unknown };
      if (created.name !== spec.name) {
        return fail(
          'gh_transport',
          'Label was applied but the response could not be verified: the created name differs.'
        );
      }
      confirmed.push(spec.name);
    }
    return ok({ names: confirmed });
  }

  private parseJsonOutput(stdout: string): Evidence<unknown> {
    return decodeJsonResponse(stdout, 'gh_transport', 'GitHub');
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
      // The behavioural contract (#275): every read path classifies an
      // authentication failure the same way the create and admin paths
      // already do — an expired token mid-evidence-gathering is
      // `gh_unauthenticated`, never a generic transport failure.
      if (AUTH_FAILURE_PATTERN.test(result.message)) {
        return fail(
          'gh_unauthenticated',
          'GitHub CLI is not authenticated.',
          'Run "gh auth login" to authenticate.'
        );
      }
      return fail('gh_transport', result.message, result.fix);
    }
    return this.parseJsonOutput(result.value.stdout);
  }

  private async runGh(args: string[], stdin?: string): Promise<CliRunOutcome> {
    try {
      const { stdout, stderr } = await this.spawn(this.resolveGhCommand(), args, {
        timeoutMs: this.timeoutMs,
        maxBuffer: this.maxBuffer,
        env: this.env,
        stdin,
      });
      return { ok: true, value: { stdout, stderr: stderr ?? '' } };
    } catch (error) {
      return classifySpawnError(error, {
        platformWord: 'GitHub',
        codes: { missing: 'gh_missing', transport: 'gh_transport', timeout: 'gh_timeout' },
        missingMessage: 'GitHub CLI (gh) is not installed or not on PATH.',
        missingFix: 'Install gh from https://cli.github.com/ and run "gh auth login".',
        timeoutFix: TIMEOUT_FIX,
        notFoundPattern: NOT_FOUND_PATTERN,
        timeoutMs: this.timeoutMs,
      });
    }
  }
}
