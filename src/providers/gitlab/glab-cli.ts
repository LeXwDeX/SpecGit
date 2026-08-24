import { fail, ok, type Evidence } from '../../kernel/evidence.js';
import type { RepoRef } from '../../gitfacts/origin.js';
import { defaultSpawn, sanitizeApiText, type SpawnFn, type SpawnOptions } from '../cli-spawn.js';
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
  OpenIssueFact,
  PrCreation,
  PrFact,
  PrSummary,
  PreflightFact,
  RepoAutomergeFact,
} from '../../github/port.js';

/**
 * The GitLab transport: the `glab` CLI, mirroring GhCliGitHubProvider
 * method-for-method over the same provider port (#114; roadmap:
 * docs/gitlab-support.md, evidence: docs/evidence/gitlab-19.2.md). One CLI
 * per platform, authenticated per host, tokens owned by glab — never read,
 * stored, or logged here. All failures are evidence: none pass acceptance.
 *
 * Endpoint discipline: read endpoints plus exactly four documented write
 * endpoints — POST issues, POST merge_requests, POST protected_branches,
 * PUT project (the pipeline gate; row 24 method map). GitLab's edit-project
 * endpoint is routed for PUT only — a PATCH returns 404 Not Found.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** SPECGIT_GLAB_TIMEOUT_MS (milliseconds) raises the per-call budget. */
function readEnvTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env.SPECGIT_GLAB_TIMEOUT_MS;
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const LIST_PAGE_SIZE = 100;
/** Completeness guard: pagination beyond this cap fails closed. */
const MAX_LIST_PAGES = 10;
/**
 * The checks-gate pipeline bound (#187): the newest pipelines by
 * `updated_at` for the sha — job pages fetched no longer scale with the
 * sha's total pipeline history. The listing asks for limit + 1 so an
 * overflow proves the set continues and fails closed instead of reading
 * a silently partial pipeline set.
 */
const PIPELINE_FETCH_LIMIT = 10;
/** MR discovery window for PR repair — same bound as the gh adapter. */
const MR_LIST_LIMIT = 30;

const GITLAB_SAAS_HOST = 'gitlab.com';

/**
 * Verified self-managed window (ledger row 5): >= 19.2.4 < 19.4.0. A
 * version outside it is advisory, not a gate (#241): preflight flags it
 * and the verdict warns, while the live evidence pass itself stays the
 * fail-closed guarantee. The range moves only through explicit
 * rebaseline deliveries, never drift.
 */
const VERSION_WINDOW_MIN = [19, 2, 4] as const;
const VERSION_WINDOW_MAX_EXCLUSIVE = [19, 4, 0] as const;

/**
 * glab stderr markers that mean "not authenticated" rather than transport.
 * 403 stays out: on the admin-adjacent endpoints it means missing
 * permission — a transport fact for the caller to report (same split the
 * gh adapter makes between its create and admin paths).
 */
const AUTH_FAILURE_PATTERN =
  /HTTP 401|401 Unauthorized|Bad credentials|glab auth login|not logged in|failed to authenticate|authentication required/i;

const NOT_FOUND_PATTERN = /404|Not Found/i;

const TIMEOUT_FIX =
  'A timeout this basic points at one of three causes — check in order: ' +
  '(1) network reachability of the GitLab host, ' +
  '(2) a GitLab instance incident, ' +
  '(3) a genuinely slow call — raise the budget via SPECGIT_GLAB_TIMEOUT_MS (milliseconds).';

/**
 * Window check with the channel-suffix trap handled (ledger rule 4): the
 * `-ee`/`-ce`/`-pre` suffix is a release-channel marker, not semver
 * pre-release semantics — strip it, then compare the `x.y.z` triple.
 */
export function versionInWindow(version: string): boolean {
  const stripped = version.replace(/-[A-Za-z0-9.]+$/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stripped);
  if (match === null) return false;
  const triple = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (compareTriples(triple, VERSION_WINDOW_MIN) < 0) return false;
  return compareTriples(triple, VERSION_WINDOW_MAX_EXCLUSIVE) < 0;
}

function compareTriples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export interface GlabProviderOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  /**
   * Declared self-managed GitLab host (optionally `host:port`), from
   * `spec_git/providers.yaml`. Scopes every call per host —
   * `glab auth status --hostname` and `glab api --hostname` — and turns
   * on the verified-version window check (advisory, #241). Absent (or
   * `gitlab.com`) means the SaaS judgment: capability probing, never
   * version pinning (#93).
   */
  hostname?: string;
  glabCommand?: string;
  spawnImpl?: SpawnFn;
  /**
   * The policy's `required_checks` (`spec_git/policy.yaml`), injected
   * by the caller that holds the policy (#116). `BranchProtectionFact
   * .requiredChecks` reports the verified intersection of this list
   * with the CI job names of the branch's latest pipeline when the
   * pipeline gate is on (ledger rows 7/25); off ⇒ `[]`. Absent ⇒ `[]`:
   * without the policy there is nothing to verify, and no gate read
   * happens — the intersection is never fabricated (row 20).
   */
  requiredChecks?: readonly string[];
}

type RunOutcome = CliRunOutcome;

/**
 * The GitLab transport: the authenticated `glab` CLI (#114). Implements
 * both port surfaces (#180): the read surface (`ForgeReadPort`) and the
 * admin surface (`ForgeAdminPort`) — the same surfaces the gh adapter
 * satisfies today.
 */
export class GlabProvider implements ForgeProvider {
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;
  private readonly hostname: string | undefined;
  private readonly explicitGlabCommand: string | undefined;
  private readonly spawn: SpawnFn;
  private readonly requiredChecks: readonly string[] | undefined;

  constructor(options: GlabProviderOptions = {}) {
    this.env = options.env;
    const envTimeout = readEnvTimeoutMs(options.env ?? process.env);
    this.timeoutMs = options.timeoutMs ?? envTimeout ?? DEFAULT_TIMEOUT_MS;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    this.hostname = options.hostname;
    this.explicitGlabCommand = options.glabCommand;
    this.spawn = options.spawnImpl ?? defaultSpawn;
    this.requiredChecks = options.requiredChecks;
  }

  /**
   * Resolved per invocation so a runtime `SPECGIT_GLAB` in the injected or
   * process environment takes effect without re-construction. An explicit
   * `glabCommand` option always wins; `glab` is the fallback.
   */
  private resolveGlabCommand(): string {
    return (
      this.explicitGlabCommand ??
      this.env?.SPECGIT_GLAB ??
      process.env.SPECGIT_GLAB ??
      'glab'
    );
  }

  /** `--hostname <host>` scoping for every api call (ledger row 8). */
  private hostArgs(): string[] {
    return this.hostname === undefined ? [] : ['--hostname', this.hostname];
  }

  /** Full project path URL-encoded (`/`→`%2F`) as `:id` (ledger row 4). */
  private projectPath(repo: RepoRef): string {
    return `${encodeURIComponent(repo.owner)}%2F${encodeURIComponent(repo.repo)}`;
  }

  /**
   * The canonical note deep-link (#252): CE note objects carry no
   * `web_url` (ledger row 6), so the URL is assembled from returned
   * facts and the known host. Nested-group slashes stay literal —
   * this is a browser link, not an API `:id` (row 4 encodes; here
   * encoding would break the path). Never scraped, never guessed.
   */
  private noteDeepLink(repo: RepoRef, issue: number, noteId: number): string {
    const host = this.hostname ?? GITLAB_SAAS_HOST;
    return `https://${host}/${repo.owner}/${repo.repo}/-/issues/${issue}#note_${noteId}`;
  }

  private isSelfManaged(): boolean {
    if (this.hostname === undefined) return false;
    return this.hostname.split(':')[0] !== GITLAB_SAAS_HOST;
  }

  private authFix(): string {
    return this.hostname === undefined
      ? 'Run "glab auth login" to authenticate.'
      : `Run "glab auth login --hostname ${this.hostname}" to authenticate.`;
  }

  /**
   * Detection → per-host auth → metadata probe. On a declared
   * self-managed host the metadata version is compared against the
   * verified window; outside it (or unparsable) sets
   * `versionUnverified` — an advisory flag the verdict surfaces
   * as a warning (#241) — but never aborts preflight: the real
   * fail-closed guarantee is the live evidence pass itself. The SaaS
   * host is never version-pinned (#93) — the metadata call remains a
   * capability probe whose failure fails closed.
   */
  async preflight(): Promise<Evidence<PreflightFact>> {
    const version = await this.runGlab(['--version']);
    if (!version.ok) {
      if (version.code === 'glab_missing') return this.asFailure(version);
      return fail('glab_transport', `GitLab CLI failed to run: ${sanitizeApiText(version.message ?? '')}`);
    }

    const authArgs =
      this.hostname === undefined ? ['auth', 'status'] : ['auth', 'status', '--hostname', this.hostname];
    const auth = await this.runGlab(authArgs);
    if (!auth.ok) {
      if (auth.code === 'glab_missing') return this.asFailure(auth);
      // glab documents `auth status` exit code 1 as an authentication
      // problem; every other failure (timeout, size cap, unexpected exit)
      // is transport.
      if (auth.exitCode === 1) {
        return fail('glab_unauthenticated', 'GitLab CLI is not authenticated for this host.', this.authFix());
      }
      return fail('glab_transport', `GitLab CLI auth check failed: ${sanitizeApiText(auth.message ?? '')}`);
    }

    const metadataEv = await this.runApi('/metadata');
    if (!metadataEv.ok) {
      return metadataEv;
    }
    if (this.isSelfManaged()) {
      const reported = (metadataEv.value as { version?: unknown }).version;
      if (typeof reported !== 'string' || !versionInWindow(reported)) {
        return ok({ authenticated: true, versionUnverified: true });
      }
    }
    return ok({ authenticated: true });
  }

  async getIssue(repo: RepoRef, n: number): Promise<Evidence<IssueFact>> {
    const result = await this.runApi(`projects/${this.projectPath(repo)}/issues/${n}`, 'issue');
    if (!result.ok) {
      return result;
    }
    const parsed = result.value as { iid?: unknown; state?: unknown; title?: unknown };
    if (typeof parsed.iid !== 'number' || (parsed.state !== 'opened' && parsed.state !== 'closed')) {
      return fail('glab_transport', 'GitLab returned an unexpected issue payload.');
    }
    return ok({
      number: parsed.iid,
      state: parsed.state === 'opened' ? 'open' : 'closed',
      // GitLab issues and merge requests are distinct entities: the
      // issues API never surfaces a merge request.
      pullRequest: false,
      ...(typeof parsed.title === 'string' && parsed.title ? { title: parsed.title } : {}),
    });
  }

  /**
   * Every open issue as a title-carrying fact (#77 mirror) through the
   * issues list API. Evidence-completeness rule (#120, I3b): offset
   * pagination runs to a short page — proof of exhaustion — and the
   * page cap reached with a full page fails closed
   * (`evidence_truncated`); a silently partial list is never consumed.
   */
  async getOpenIssues(repo: RepoRef): Promise<Evidence<OpenIssueFact[]>> {
    const pagesEv = await this.paginateList(
      (page) => `projects/${this.projectPath(repo)}/issues?state=opened&per_page=${LIST_PAGE_SIZE}&page=${page}`,
      'issue-list'
    );
    if (!pagesEv.ok) {
      return pagesEv;
    }
    const byIid = new Map<number, OpenIssueFact>();
    for (const item of pagesEv.value) {
      const issue = item as { iid?: unknown; title?: unknown; description?: unknown };
      if (typeof issue.iid !== 'number' || byIid.has(issue.iid)) continue;
      byIid.set(issue.iid, {
        number: issue.iid,
        ...(typeof issue.title === 'string' && issue.title ? { title: issue.title } : {}),
        ...(typeof issue.description === 'string' ? { body: issue.description } : {}),
      });
    }
    return ok([...byIid.values()]);
  }

  /**
   * Open-issue numbers for the ordered-issues sequencing gate, derived
   * from the same complete title-carrying scan — one completeness
   * contract, one pagination implementation.
   */
  async getOpenIssueNumbers(repo: RepoRef): Promise<Evidence<number[]>> {
    const issues = await this.getOpenIssues(repo);
    if (!issues.ok) {
      return issues;
    }
    return ok(issues.value.map((fact) => fact.number));
  }

  /**
   * MR fact through the state machine pinned at row 19: `opened`, `closed`,
   * `locked`, `merged` — `locked` still accepts work, so it maps to `open`.
   */
  async getPr(repo: RepoRef, pr: number | string): Promise<Evidence<PrFact>> {
    const ref = String(pr);
    if (!/^\d+$/.test(ref)) {
      return fail(
        'pr_not_found',
        `Cannot resolve merge request reference "${sanitizeApiText(ref)}".`,
        'Bind the merge request by iid or a full merge request URL.'
      );
    }
    const result = await this.runApi(`projects/${this.projectPath(repo)}/merge_requests/${ref}`, 'pr');
    if (!result.ok) {
      return result;
    }
    const parsed = result.value as {
      iid?: unknown;
      state?: unknown;
      draft?: unknown;
      source_branch?: unknown;
      target_branch?: unknown;
      sha?: unknown;
      description?: unknown;
      merge_commit_sha?: unknown;
    };
    if (
      typeof parsed.iid !== 'number' ||
      typeof parsed.draft !== 'boolean' ||
      (parsed.state !== 'opened' &&
        parsed.state !== 'closed' &&
        parsed.state !== 'locked' &&
        parsed.state !== 'merged')
    ) {
      return fail('glab_transport', 'GitLab returned an unexpected merge request payload.');
    }
    const state: PrFact['state'] =
      parsed.state === 'merged' ? 'merged' : parsed.state === 'closed' ? 'closed' : 'open';
    return ok({
      number: parsed.iid,
      state,
      headBranch: typeof parsed.source_branch === 'string' ? parsed.source_branch : '',
      headSha: typeof parsed.sha === 'string' ? parsed.sha : '',
      baseBranch: typeof parsed.target_branch === 'string' ? parsed.target_branch : '',
      body: typeof parsed.description === 'string' ? parsed.description : '',
      mergeCommitSha:
        typeof parsed.merge_commit_sha === 'string' && parsed.merge_commit_sha.length > 0
          ? parsed.merge_commit_sha
          : null,
      draft: parsed.draft,
    });
  }

  /**
   * Pipelines for the sha, then per-pipeline jobs (the sha→pipelines→jobs
   * chain, row 15). The pipeline listing is bounded by recency (#187):
   * `order_by=updated_at`, `sort=desc`, one page of
   * `PIPELINE_FETCH_LIMIT + 1` — an overflow fails closed
   * (`evidence_truncated`), so the bound never turns missing evidence
   * into a pass. Retried jobs stay omitted (`include_retried` never
   * passed, row 16) so latest-attempt semantics are native. The #116
   * mapping (ledger rows 16/17/26): final states complete the run —
   * success/'success', failed/'failure' with the platform
   * `allow_failure` boolean carried as job-level truth, canceled/
   * 'cancelled' (gate-failing, §8.4.2); `skipped` jobs produce no
   * check-run at all (intentionally not run ⇒ absent); every other
   * status stays non-completed ⇒ the gate reads it as pending
   * (manual included: it never ran).
   */
  async getCheckRuns(repo: RepoRef, sha: string): Promise<Evidence<CheckRunInfo[]>> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      return fail('glab_transport', 'Cannot query pipelines without a valid commit SHA.');
    }
    const listEv = await this.runApi(
      `projects/${this.projectPath(repo)}/pipelines?sha=${sha}&order_by=updated_at&sort=desc&per_page=${PIPELINE_FETCH_LIMIT + 1}&page=1`
    );
    if (!listEv.ok) {
      return listEv;
    }
    if (!Array.isArray(listEv.value)) {
      return fail('glab_transport', 'GitLab returned an unexpected pipeline-list payload.');
    }
    if (listEv.value.length > PIPELINE_FETCH_LIMIT) {
      return evidenceTruncated(
        `pipeline-list returned more than the ${PIPELINE_FETCH_LIMIT} most recent pipelines for this sha; the job evidence would be incomplete.`
      );
    }
    const runs: CheckRunInfo[] = [];
    for (const entry of listEv.value) {
      const pipelineId = (entry as { id?: unknown }).id;
      if (typeof pipelineId !== 'number') continue;
      const jobsEv = await this.paginateList(
        (page) =>
          `projects/${this.projectPath(repo)}/pipelines/${pipelineId}/jobs?per_page=${LIST_PAGE_SIZE}&page=${page}`,
        'pipeline-job-list'
      );
      if (!jobsEv.ok) {
        return jobsEv;
      }
      for (const job of jobsEv.value) {
        const item = job as {
          name?: unknown;
          status?: unknown;
          id?: unknown;
          started_at?: unknown;
          allow_failure?: unknown;
        };
        const jobStatus = typeof item.status === 'string' ? item.status : '';
        // Decided #116: skipped ⇒ absent — the job was intentionally
        // not run, so it contributes no evidence object.
        if (jobStatus === 'skipped') continue;
        runs.push({
          name: typeof item.name === 'string' ? item.name : '',
          status:
            jobStatus === 'success' || jobStatus === 'failed' || jobStatus === 'canceled'
              ? 'completed'
              : jobStatus,
          conclusion:
            jobStatus === 'success'
              ? 'success'
              : jobStatus === 'failed'
                ? 'failure'
                : jobStatus === 'canceled'
                  ? 'cancelled'
                  : null,
          ...(item.allow_failure === true ? { allowFailure: true } : {}),
          id: typeof item.id === 'number' ? item.id : 0,
          startedAt: typeof item.started_at === 'string' ? item.started_at : null,
        });
      }
    }
    return ok(runs);
  }

  /**
   * Check-freshness anchor (#315): GitLab declares no boundary. The
   * three-state contract reads `anchoredAt: null` as "this provider
   * sets no freshness boundary" — the verdict then keeps exactly its
   * pre-#315 shape, without claiming the two platforms' facts are
   * equivalent. No glab call is made and no GitLab-specific behavior
   * is invented: within the verified window (19.2.4 CE,
   * docs/evidence/gitlab-19.2.md) no equivalent of GitHub's
   * ready-for-review transition has been evidenced, so asserting one
   * would be fabrication. Should live evidence for an equivalent MR
   * transition emerge, GitLab anchor support is its own delivery.
   */
  async getEvidenceAnchor(
    _repo: RepoRef,
    _pr: number | string
  ): Promise<Evidence<EvidenceAnchorFact>> {
    return ok({ anchoredAt: null });
  }

  async createIssue(repo: RepoRef, title: string, body: string): Promise<Evidence<IssueCreation>> {
    if (!title.trim()) {
      return fail('glab_transport', 'Cannot create an issue without a title.');
    }
    const result = await this.runCreate([
      'api',
      ...this.hostArgs(),
      '-X',
      'POST',
      `projects/${this.projectPath(repo)}/issues`,
      '-f',
      `title=${title}`,
      '-f',
      `body=${body}`,
    ]);
    if (!result.ok) {
      return this.asFailure(result);
    }
    const parsedEv = this.parseJsonOutput(result.value.stdout);
    if (!parsedEv.ok) {
      return parsedEv;
    }
    const issue = parsedEv.value as { iid?: unknown; web_url?: unknown };
    if (typeof issue.iid !== 'number' || typeof issue.web_url !== 'string' || !issue.web_url) {
      return fail('glab_transport', 'GitLab returned an unexpected issue payload.');
    }
    return ok({ number: issue.iid, url: issue.web_url });
  }

  async addIssueComment(
    repo: RepoRef,
    issue: number,
    body: string
  ): Promise<Evidence<IssueCommentCreation>> {
    if (!Number.isInteger(issue) || issue <= 0) {
      return fail('glab_transport', 'Cannot comment on an issue without a positive number.');
    }
    if (!body.trim()) {
      return fail('glab_transport', 'Cannot post an empty issue comment.');
    }
    const result = await this.runCreate([
      'api',
      ...this.hostArgs(),
      '-X',
      'POST',
      `projects/${this.projectPath(repo)}/issues/${issue}/notes`,
      '-f',
      `body=${body}`,
    ]);
    if (!result.ok) {
      return this.asFailure(result);
    }
    const parsedEv = this.parseJsonOutput(result.value.stdout);
    if (!parsedEv.ok) {
      return parsedEv;
    }
    const note = parsedEv.value as { id?: unknown; web_url?: unknown };
    if (typeof note.web_url === 'string' && note.web_url) {
      return ok({ url: note.web_url });
    }
    if (typeof note.id === 'number') {
      // CE notes carry no web_url (live probe, note 88688 on 19.3.0
      // CE; #252): derive the canonical deep-link from returned facts.
      return ok({ url: this.noteDeepLink(repo, issue, note.id) });
    }
    return fail('glab_transport', 'GitLab returned an unexpected issue-note payload.');
  }

  /**
   * `glab mr create` has no structured-output flag (row 6): the REST
   * create is the only path. Draft state comes from the `Draft: ` title
   * prefix (row 18); the {number, url} fact is mapped from the JSON
   * entity's `iid`/`web_url` — zero stdout scraping.
   */
  async createDraftPr(
    repo: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<Evidence<PrCreation>> {
    if (!head.trim() || !base.trim() || !title.trim()) {
      return fail(
        'glab_transport',
        'Cannot create a merge request without a source branch, target branch, and title.'
      );
    }
    const result = await this.runCreate([
      'api',
      ...this.hostArgs(),
      '-X',
      'POST',
      `projects/${this.projectPath(repo)}/merge_requests`,
      '-f',
      `source_branch=${head}`,
      '-f',
      `target_branch=${base}`,
      '-f',
      `title=Draft: ${title}`,
      '-f',
      `description=${body}`,
    ]);
    if (!result.ok) {
      return this.asFailure(result);
    }
    const parsedEv = this.parseJsonOutput(result.value.stdout);
    if (!parsedEv.ok) {
      return parsedEv;
    }
    const mr = parsedEv.value as { iid?: unknown; web_url?: unknown };
    if (typeof mr.iid !== 'number' || typeof mr.web_url !== 'string' || !mr.web_url) {
      return fail('glab_transport', 'GitLab returned an unexpected merge request payload.');
    }
    return ok({ number: mr.iid, url: mr.web_url });
  }

  /**
   * MR discovery by source branch for `specgit pr` repair: the MR-list
   * `source_branch` filter (pinned FU-4, ledger row 24) with the open
   * state — exactly one candidate binds, zero or several refuse.
   */
  async listOpenPrsByHead(repo: RepoRef, head: string): Promise<Evidence<PrSummary[]>> {
    if (!head.trim()) {
      return fail('glab_transport', 'Cannot list merge requests without a source branch.');
    }
    const result = await this.runApi(
      `projects/${this.projectPath(repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(head)}&per_page=${MR_LIST_LIMIT}`
    );
    if (!result.ok) {
      return result;
    }
    if (!Array.isArray(result.value)) {
      return fail('glab_transport', 'GitLab returned an unexpected merge request list payload.');
    }
    const mrs: PrSummary[] = [];
    for (const entry of result.value) {
      const item = entry as { iid?: unknown; title?: unknown; web_url?: unknown };
      if (
        typeof item.iid !== 'number' ||
        typeof item.title !== 'string' ||
        typeof item.web_url !== 'string'
      ) {
        return fail('glab_transport', 'GitLab returned an unexpected merge request list payload.');
      }
      mrs.push({ number: item.iid, title: item.title, url: item.web_url });
    }
    return ok(mrs);
  }

  /**
   * Protection truth = existence of the branch in protected_branches
   * (row 20); `requiredChecks` truth = the pipeline gate (row 7): the
   * verified intersection of the injected policy list with the CI job
   * names of the branch's latest pipeline when
   * `only_allow_merge_if_pipeline_succeeds` is on; off ⇒ `[]` (the
   * init warning carries the enable guidance). Never fabricated, and
   * the Ultimate-only status-checks primitive is never touched
   * (row 22).
   */
  async getBranchProtection(repo: RepoRef, branch: string): Promise<Evidence<BranchProtectionFact>> {
    if (!branch.trim()) {
      return fail('glab_transport', 'Cannot query branch protection without a branch name.');
    }
    const payloadEv = await this.fetchProtectionPayload(repo, branch);
    if (!payloadEv.ok) {
      return payloadEv;
    }
    if (this.requiredChecks === undefined) {
      return ok({ protected: payloadEv.value !== null, requiredChecks: [] });
    }
    const checksEv = await this.pipelineGateChecks(repo, branch);
    if (!checksEv.ok) {
      return checksEv;
    }
    return ok({ protected: payloadEv.value !== null, requiredChecks: checksEv.value });
  }

  /**
   * Read-modify-write, Free-tier shape: keep the pipeline gate on (row 7),
   * protect the branch with integer access levels only (row 20 — the
   * `allowed_to_*` hash forms are Premium), and never re-POST a branch
   * that is already protected (idempotent).
   */
  async enableBranchProtection(
    repo: RepoRef,
    branch: string,
    requiredCheck: string
  ): Promise<Evidence<BranchProtectionFact>> {
    if (!branch.trim() || !requiredCheck.trim()) {
      return fail('glab_transport', 'Cannot enable branch protection without a branch and check name.');
    }
    const currentEv = await this.fetchProtectionPayload(repo, branch);
    if (!currentEv.ok) {
      return currentEv;
    }
    const gateEv = await this.setPipelineGate(repo);
    if (!gateEv.ok) {
      return gateEv;
    }
    if (currentEv.value === null) {
      const created = await this.runCreate([
        'api',
        ...this.hostArgs(),
        '-X',
        'POST',
        `projects/${this.projectPath(repo)}/protected_branches`,
        '-f',
        `name=${branch}`,
        '-f',
        'push_access_level=40',
        '-f',
        'merge_access_level=40',
        '-f',
        'unprotect_access_level=40',
      ]);
      if (!created.ok) {
        return this.asFailure(created);
      }
      const parsedEv = this.parseJsonOutput(created.value.stdout);
      if (!parsedEv.ok) {
        return parsedEv;
      }
    }
    if (this.requiredChecks === undefined) {
      return ok({ protected: true, requiredChecks: [] });
    }
    // Post-state read: the gate is now on by construction, and the
    // intersection reflects the branch's live pipeline, not the PUT
    // echo.
    const checksEv = await this.pipelineGateChecks(repo, branch);
    if (!checksEv.ok) {
      return checksEv;
    }
    return ok({ protected: true, requiredChecks: checksEv.value });
  }

  /**
   * The verified pipeline-gate intersection (rows 7/25, #116): read the
   * project gate (identity-verified, row 5); on ⇒ take the latest
   * pipeline for the ref (`order_by` id `desc` default — the first
   * entry of page 1), read its jobs to exhaustion, and keep the policy
   * names that exist as job names — any status counts (verification is
   * existence in CI, not success). Off or no pipeline ⇒ `[]`.
   */
  private async pipelineGateChecks(
    repo: RepoRef,
    branch: string
  ): Promise<Evidence<string[]>> {
    const projectEv = await this.runApi(`projects/${this.projectPath(repo)}`);
    if (!projectEv.ok) {
      return projectEv;
    }
    const payload = projectEv.value as {
      only_allow_merge_if_pipeline_succeeds?: unknown;
      path_with_namespace?: unknown;
    };
    const identityEv = this.verifyProjectIdentity(payload, repo);
    if (!identityEv.ok) {
      return identityEv;
    }
    if (payload.only_allow_merge_if_pipeline_succeeds !== true) {
      return ok([]);
    }
    const latestEv = await this.runApi(
      `projects/${this.projectPath(repo)}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1&page=1`
    );
    if (!latestEv.ok) {
      return latestEv;
    }
    if (!Array.isArray(latestEv.value)) {
      return fail('glab_transport', 'GitLab returned an unexpected pipeline-list payload.');
    }
    const pipelineId = (latestEv.value[0] as { id?: unknown } | undefined)?.id;
    if (typeof pipelineId !== 'number') {
      return ok([]);
    }
    const jobsEv = await this.paginateList(
      (page) =>
        `projects/${this.projectPath(repo)}/pipelines/${pipelineId}/jobs?per_page=${LIST_PAGE_SIZE}&page=${page}`,
      'pipeline-job-list'
    );
    if (!jobsEv.ok) {
      return jobsEv;
    }
    const names = new Set<string>();
    for (const job of jobsEv.value) {
      const name = (job as { name?: unknown }).name;
      if (typeof name === 'string' && name) {
        names.add(name);
      }
    }
    return ok(this.requiredChecks!.filter((name) => names.has(name)));
  }

  /**
   * Repository auto-merge truth is the pipeline gate (row 7); the per-MR
   * `auto_merge` layer (row 21) belongs to the merge action, not a repo
   * setting. Identity is verified by path comparison: renamed projects
   * redirect transparently, so a silently-moved binding must fail closed
   * (row 5).
   */
  async getRepoAutomerge(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> {
    const result = await this.runApi(`projects/${this.projectPath(repo)}`);
    if (!result.ok) {
      return result;
    }
    const payload = result.value as {
      only_allow_merge_if_pipeline_succeeds?: unknown;
      path_with_namespace?: unknown;
    };
    const identityEv = this.verifyProjectIdentity(payload, repo);
    if (!identityEv.ok) {
      return identityEv;
    }
    return ok({ enabled: payload.only_allow_merge_if_pipeline_succeeds === true });
  }

  async enableRepoAutomerge(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> {
    return this.setPipelineGate(repo);
  }

  private async setPipelineGate(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> {
    const result = await this.runCreate([
      'api',
      ...this.hostArgs(),
      '-X',
      'PUT',
      `projects/${this.projectPath(repo)}`,
      '-f',
      'only_allow_merge_if_pipeline_succeeds=true',
    ]);
    if (!result.ok) {
      return this.asFailure(result);
    }
    const parsedEv = this.parseJsonOutput(result.value.stdout);
    if (!parsedEv.ok) {
      return parsedEv;
    }
    const payload = parsedEv.value as {
      only_allow_merge_if_pipeline_succeeds?: unknown;
      path_with_namespace?: unknown;
    };
    const identityEv = this.verifyProjectIdentity(payload, repo);
    if (!identityEv.ok) {
      return identityEv;
    }
    return ok({ enabled: payload.only_allow_merge_if_pipeline_succeeds === true });
  }

  /**
   * Row 5: REST GETs by the old path redirect transparently to the renamed
   * project — the only way to detect a moved binding from the payload is
   * comparing the resolved `path_with_namespace` against the declared
   * path. A mismatch is fail-closed evidence, never a silent rebinding.
   */
  private verifyProjectIdentity(
    payload: { path_with_namespace?: unknown },
    repo: RepoRef
  ): Evidence<true> {
    if (typeof payload.path_with_namespace === 'string') {
      const declared = `${repo.owner}/${repo.repo}`;
      if (payload.path_with_namespace !== declared) {
        return fail(
          'glab_transport',
          `The project resolved to "${sanitizeApiText(payload.path_with_namespace)}" — it was renamed or moved; the binding points at "${sanitizeApiText(declared)}".`,
          'Update the origin remote and the providers.yaml declaration to the current project path, then re-bind.'
        );
      }
    }
    return ok(true);
  }

  /** Raw protection payload; null when the branch is not protected (404). */
  private async fetchProtectionPayload(
    repo: RepoRef,
    branch: string
  ): Promise<Evidence<unknown | null>> {
    const result = await this.runApi(
      `projects/${this.projectPath(repo)}/protected_branches/${encodeURIComponent(branch)}`,
      'protection'
    );
    if (!result.ok) {
      if (result.code === 'not_found') {
        return ok(null);
      }
      return result;
    }
    return ok(result.value);
  }

  /**
   * Offset pagination with the completeness contract: page until a short
   * page proves exhaustion; a full page at the cap fails closed
   * (`evidence_truncated`) instead of returning a silently partial list.
   */
  private async paginateList(
    buildEndpoint: (page: number) => string,
    what: string
  ): Promise<Evidence<unknown[]>> {
    return paginateToExhaustion(
      { pageSize: LIST_PAGE_SIZE, maxPages: MAX_LIST_PAGES, what },
      async (page) => {
        const result = await this.runApi(buildEndpoint(page));
        if (!result.ok) {
          return result;
        }
        if (!Array.isArray(result.value)) {
          return fail('glab_transport', `GitLab returned an unexpected ${what} payload.`);
        }
        return ok(result.value);
      }
    );
  }

  private parseJsonOutput(stdout: string): Evidence<unknown> {
    return decodeJsonResponse(stdout, 'glab_transport', 'GitLab');
  }

  private asFailure<T>(
    outcome: Extract<RunOutcome, { ok: false }> | { code: string; message: string; fix?: string }
  ): Evidence<T> {
    return fail(outcome.code, outcome.message, outcome.fix);
  }

  private async runApi(
    endpoint: string,
    kind?: 'issue' | 'pr' | 'protection'
  ): Promise<Evidence<unknown>> {
    const result = await this.runGlab(['api', ...this.hostArgs(), endpoint]);
    if (!result.ok) {
      if (result.code === 'glab_missing') {
        return this.asFailure(result);
      }
      if (AUTH_FAILURE_PATTERN.test(result.message ?? '')) {
        return fail('glab_unauthenticated', 'GitLab CLI is not authenticated for this host.', this.authFix());
      }
      if (result.code === 'not_found') {
        if (kind === 'issue') {
          return fail('issue_not_found', 'GitLab reports this issue does not exist.');
        }
        if (kind === 'pr') {
          return fail('pr_not_found', 'GitLab reports this merge request does not exist.');
        }
        // 'protection' reads a 404 as "not protected" — evidence, not an
        // error; every other 404 is a transport-grade lookup failure.
        if (kind === 'protection') {
          return fail('not_found', result.message ?? 'Not found.');
        }
        return fail('glab_transport', `GitLab lookup failed for ${sanitizeApiText(endpoint)}.`);
      }
      return fail('glab_transport', result.message, result.fix);
    }
    return this.parseJsonOutput(result.value.stdout);
  }

  /** Creation calls share the read taxonomy, classifying auth from stderr. */
  private async runCreate(args: string[]): Promise<RunOutcome> {
    const result = await this.runGlab(args);
    if (!result.ok) {
      if (result.code === 'glab_missing') {
        return result;
      }
      if (AUTH_FAILURE_PATTERN.test(result.message ?? '')) {
        return {
          ok: false,
          code: 'glab_unauthenticated',
          message: 'GitLab CLI is not authenticated for this host.',
          fix: this.authFix(),
        };
      }
      return { ok: false, code: 'glab_transport', message: result.message, fix: result.fix };
    }
    return result;
  }

  private async runGlab(args: string[], stdin?: string): Promise<CliRunOutcome> {
    try {
      const { stdout, stderr } = await this.spawn(this.resolveGlabCommand(), args, {
        timeoutMs: this.timeoutMs,
        maxBuffer: this.maxBuffer,
        env: this.env,
        stdin,
      } satisfies SpawnOptions);
      return { ok: true, value: { stdout, stderr } };
    } catch (error) {
      return classifySpawnError(error, {
        platformWord: 'GitLab',
        codes: { missing: 'glab_missing', transport: 'glab_transport' },
        missingMessage: 'GitLab CLI (glab) is not installed or not on PATH.',
        missingFix:
          'Install glab from https://gitlab.com/gitlab-org/cli and run "glab auth login --hostname <host>".',
        timeoutFix: TIMEOUT_FIX,
        notFoundPattern: NOT_FOUND_PATTERN,
        timeoutMs: this.timeoutMs,
      });
    }
  }
}
