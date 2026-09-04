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

/**
 * The GitLab transport: the `glab` CLI, mirroring GhCliGitHubProvider
 * method-for-method over the same provider port (#114; roadmap:
 * docs/gitlab-support.md, evidence: docs/evidence/gitlab-19.2.md). One CLI
 * per platform, authenticated per host, tokens owned by glab — never read,
 * stored, or logged here. All failures are evidence: none pass acceptance.
 *
 * Writes cover issue/MR lifecycle, notes, labels, branch protection and
 * the project pipeline gate. MR merge sends the expected SHA atomically;
 * the provider never bypasses platform protection. Project edits use PUT.
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
const MAX_MERGE_PIPELINES = 32;
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

/** glab's stderr for a duplicate label POST (409) names it (#330). */
const GLAB_LABEL_ALREADY_EXISTS_PATTERN = /HTTP 409|already been taken|label.{0,10}already.{0,10}exist/i;

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

interface MrPipelineFact {
  headSha: string;
  pipeline: { id: number; projectId: number; status: string | null } | null;
}

interface PipelineRef {
  id: number;
  project: string;
  projectId?: number;
}

interface PipelineJobsFact {
  checks: CheckRunInfo[];
  downstream: unknown[];
}

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
    const parsed = result.value as { iid?: unknown; state?: unknown; title?: unknown } | null;
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.iid !== 'number' || (parsed.state !== 'opened' && parsed.state !== 'closed')) {
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
      squash_commit_sha?: unknown;
      diff_refs?: { head_sha?: unknown } | null;
    } | null;
    if (
      parsed === null || typeof parsed !== 'object' ||
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
    // GitLab fast-forward merges have no merge_commit_sha. Its frozen
    // squash result (or explicitly unsquashed diff head) is the base anchor.
    let mergeCommitSha =
      typeof parsed.merge_commit_sha === 'string' && parsed.merge_commit_sha.length > 0
        ? parsed.merge_commit_sha
        : null;
    if (mergeCommitSha === null && state === 'merged') {
      if (typeof parsed.squash_commit_sha === 'string' && parsed.squash_commit_sha.length > 0) {
        mergeCommitSha = parsed.squash_commit_sha;
      } else if (parsed.merge_commit_sha === null && parsed.squash_commit_sha === null &&
          typeof parsed.diff_refs?.head_sha === 'string' && parsed.diff_refs.head_sha.length > 0) {
        mergeCommitSha = parsed.diff_refs.head_sha;
      }
    }
    return ok({
      number: parsed.iid,
      state,
      headBranch: typeof parsed.source_branch === 'string' ? parsed.source_branch : '',
      headSha: typeof parsed.sha === 'string' ? parsed.sha : '',
      baseBranch: typeof parsed.target_branch === 'string' ? parsed.target_branch : '',
      body: typeof parsed.description === 'string' ? parsed.description : '',
      mergeCommitSha,
      draft: parsed.draft,
    });
  }

  /**
   * Acceptance uses the bound MR's head_pipeline, including its source
   * project. Other pipelines at the same SHA never contribute jobs.
   * Two-argument callers retain bounded discovery and receive only the
   * highest pipeline id; acceptance always supplies the MR iid (#376).
   */
  async getCheckRuns(repo: RepoRef, sha: string, pr?: number): Promise<Evidence<CheckRunInfo[]>> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      return fail('glab_transport', 'Cannot query pipelines without a valid commit SHA.');
    }
    if (pr !== undefined) {
      const mrEv = await this.readMrPipeline(repo, pr, sha);
      if (!mrEv.ok) return mrEv;
      const { pipeline } = mrEv.value;
      return pipeline === null ? ok([]) : this.checkRunsForPipeline(String(pipeline.projectId), pipeline.id);
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
    let newestId: number | undefined;
    for (const entry of listEv.value) {
      const pipeline = entry as { id?: unknown; sha?: unknown } | null;
      if (pipeline === null || typeof pipeline !== 'object' ||
          !Number.isSafeInteger(pipeline.id) || (pipeline.id as number) <= 0 || pipeline.sha !== sha) {
        return fail('glab_transport', 'GitLab returned an incomplete or mismatched pipeline-list entry.');
      }
      const id = pipeline.id as number;
      if (newestId === undefined || id > newestId) newestId = id;
    }
    return newestId === undefined ? ok([]) : this.checkRunsForPipeline(this.projectPath(repo), newestId);
  }

  async getPrChecks(repo: RepoRef, pr: number): Promise<Evidence<MergeChecksFact>> {
    const mrEv = await this.readMrPipeline(repo, pr);
    if (!mrEv.ok) return mrEv;
    const { headSha, pipeline } = mrEv.value;
    if (pipeline === null || pipeline.status === null) {
      return fail('glab_transport', 'GitLab did not report the MR head pipeline status required for merge.');
    }
    const checksEv = await this.collectMergePipelineChecks(pipeline);
    if (!checksEv.ok) return checksEv;
    return ok({ headSha, checks: checksEv.value, pipelineStatus: pipeline.status });
  }

  /** All jobs in the linked pipeline graph, bounded and namespaced by identity. */
  private async collectMergePipelineChecks(root: { id: number; projectId: number }): Promise<Evidence<CheckRunInfo[]>> {
    const queue: PipelineRef[] = [{ id: root.id, project: String(root.projectId), projectId: root.projectId }];
    const visited = new Set<string>();
    const checks: CheckRunInfo[] = [];
    while (queue.length > 0) {
      const ref = queue.shift()!;
      if (ref.projectId !== undefined && visited.has(`${ref.projectId}/${ref.id}`)) continue;
      const isRoot = visited.size === 0;
      let projectId = ref.projectId;
      let pipelineStatus: string | undefined;
      if (!isRoot) {
        const pipelineEv = await this.runApi(`projects/${ref.project}/pipelines/${ref.id}`);
        if (!pipelineEv.ok) return pipelineEv;
        const fact = pipelineEv.value as { id?: unknown; project_id?: unknown; sha?: unknown; status?: unknown } | null;
        if (fact === null || typeof fact !== 'object' || fact.id !== ref.id ||
            !Number.isSafeInteger(fact.project_id) || (fact.project_id as number) <= 0 ||
            (projectId !== undefined && fact.project_id !== projectId) ||
            typeof fact.sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(fact.sha) ||
            typeof fact.status !== 'string' || fact.status === '') {
          return fail('glab_transport', 'GitLab returned incomplete or mismatched downstream pipeline evidence.');
        }
        projectId = fact.project_id as number;
        pipelineStatus = fact.status;
      }
      const key = `${projectId}/${ref.id}`;
      if (visited.has(key)) continue;
      if (visited.size >= MAX_MERGE_PIPELINES) {
        return evidenceTruncated(`The downstream pipeline graph exceeds the ${MAX_MERGE_PIPELINES}-pipeline merge evidence bound.`);
      }
      visited.add(key);
      const prefix = isRoot ? '' : `downstream:${key}:`;
      if (pipelineStatus !== undefined) {
        const terminal = ['success', 'failed', 'canceled', 'skipped'].includes(pipelineStatus);
        checks.push({ name: `${prefix}pipeline`, id: ref.id, startedAt: null, status: terminal ? 'completed' : pipelineStatus,
          conclusion: pipelineStatus === 'success' ? 'success' : terminal ? 'failure' : null });
      }
      for (const collection of ['jobs', 'trigger_jobs'] as const) {
        const jobsEv = await this.readPipelineJobs(String(projectId), ref.id, collection);
        if (!jobsEv.ok) return jobsEv;
        checks.push(...jobsEv.value.checks.map((check) => ({ ...check, name: `${prefix}${check.name}` })));
        for (const downstream of jobsEv.value.downstream) {
          if (downstream === null) continue;
          const refEv = this.downstreamPipelineRef(downstream);
          if (!refEv.ok) return refEv;
          queue.push(refEv.value);
        }
      }
    }
    return ok(checks);
  }

  private downstreamPipelineRef(value: unknown): Evidence<PipelineRef> {
    const fact = value as { id?: unknown; project_id?: unknown; web_url?: unknown } | null;
    if (fact === null || typeof fact !== 'object' || !Number.isSafeInteger(fact.id) || (fact.id as number) <= 0) {
      return fail('glab_transport', 'GitLab did not identify a downstream pipeline.');
    }
    let projectPath: string | undefined;
    if (fact.web_url !== undefined) {
      try {
        if (typeof fact.web_url !== 'string') throw new Error('Missing URL');
        const url = new URL(fact.web_url);
        const host = new URL(`https://${this.hostname ?? GITLAB_SAAS_HOST}`).host;
        const suffix = url.pathname.endsWith(`/-/pipelines/${fact.id}`)
          ? `/-/pipelines/${fact.id}` : `/pipelines/${fact.id}`;
        if (!['https:', 'http:'].includes(url.protocol) || url.host !== host || url.username || url.password ||
            !url.pathname.endsWith(suffix)) throw new Error('Mismatched pipeline URL');
        const project = decodeURIComponent(url.pathname.slice(1, -suffix.length));
        if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(project) ||
            project.split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid project path');
        projectPath = encodeURIComponent(project);
      } catch {
        return fail('glab_transport', 'GitLab returned an invalid or cross-host downstream pipeline URL.');
      }
    }
    if (fact.project_id !== undefined) {
      if (!Number.isSafeInteger(fact.project_id) || (fact.project_id as number) <= 0) {
        return fail('glab_transport', 'GitLab returned an invalid downstream project identity.');
      }
      return ok({ id: fact.id as number, projectId: fact.project_id as number, project: String(fact.project_id) });
    }
    return projectPath === undefined
      ? fail('glab_transport', 'GitLab did not identify the downstream project.')
      : ok({ id: fact.id as number, project: projectPath });
  }

  async mergePr(repo: RepoRef, pr: number, expectedHeadSha: string): Promise<Evidence<{ merged: boolean }>> {
    if (!Number.isSafeInteger(pr) || pr <= 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedHeadSha)) {
      return fail('glab_transport', 'Cannot merge without a positive MR iid and a full expected commit SHA.');
    }
    const current = await this.getPr(repo, pr);
    if (!current.ok) return current;
    if (current.value.number !== pr || current.value.headSha !== expectedHeadSha) {
      return fail('glab_transport', 'The merge request head changed after its evidence was verified.');
    }
    if (current.value.state === 'merged') return ok({ merged: true });
    if (current.value.state !== 'open') return ok({ merged: false });
    const result = await this.runCreate([
      'api', ...this.hostArgs(), '-X', 'PUT',
      `projects/${this.projectPath(repo)}/merge_requests/${pr}/merge`, '-f', `sha=${expectedHeadSha}`,
    ]);
    if (!result.ok) return this.asFailure(result);
    const confirmed = await this.getPr(repo, pr);
    if (!confirmed.ok) return confirmed;
    if (confirmed.value.number !== pr || confirmed.value.headSha !== expectedHeadSha) {
      return fail('glab_transport', 'The merge response could not be verified against the expected MR head.');
    }
    return ok({ merged: confirmed.value.state === 'merged' });
  }

  async closeIssue(repo: RepoRef, issue: number): Promise<Evidence<{ closed: boolean }>> {
    if (!Number.isSafeInteger(issue) || issue <= 0) {
      return fail('glab_transport', 'Cannot close an issue without a positive iid.');
    }
    const current = await this.getIssue(repo, issue);
    if (!current.ok) return current;
    if (current.value.number !== issue) {
      return fail('glab_transport', 'GitLab returned a different issue from the requested closure.');
    }
    if (current.value.state === 'closed') return ok({ closed: true });
    const result = await this.runCreate([
      'api', ...this.hostArgs(), '-X', 'PUT',
      `projects/${this.projectPath(repo)}/issues/${issue}`, '-f', 'state_event=close',
    ]);
    if (!result.ok) return this.asFailure(result);
    const confirmed = await this.getIssue(repo, issue);
    if (!confirmed.ok) return confirmed;
    if (confirmed.value.number !== issue) {
      return fail('glab_transport', 'The issue closure response did not identify the requested issue.');
    }
    return ok({ closed: confirmed.value.state === 'closed' });
  }

  private async readMrPipeline(repo: RepoRef, pr: number, expectedSha?: string): Promise<Evidence<MrPipelineFact>> {
    if (!Number.isSafeInteger(pr) || pr <= 0) {
      return fail('glab_transport', 'Cannot query MR pipeline evidence without a positive MR iid.');
    }
    const mrEv = await this.runApi(`projects/${this.projectPath(repo)}/merge_requests/${pr}`, 'pr');
    if (!mrEv.ok) return mrEv;
    const mr = mrEv.value as { iid?: unknown; sha?: unknown; head_pipeline?: unknown } | null;
    if (mr === null || typeof mr !== 'object' || mr.iid !== pr ||
        typeof mr.sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(mr.sha) ||
        (expectedSha !== undefined && mr.sha !== expectedSha)) {
      return fail('glab_transport', 'GitLab returned an MR identity or head SHA that differs from the requested evidence.');
    }
    if (mr.head_pipeline === null) return ok({ headSha: mr.sha, pipeline: null });
    const pipeline = mr.head_pipeline as { id?: unknown; sha?: unknown; project_id?: unknown; status?: unknown } | undefined;
    if (pipeline === undefined || typeof pipeline !== 'object' ||
        typeof pipeline.id !== 'number' || !Number.isSafeInteger(pipeline.id) || pipeline.id <= 0 ||
        typeof pipeline.project_id !== 'number' || !Number.isSafeInteger(pipeline.project_id) || pipeline.project_id <= 0 ||
        pipeline.sha !== mr.sha ||
        (pipeline.status !== undefined && (typeof pipeline.status !== 'string' || pipeline.status === ''))) {
      return fail('glab_transport', 'GitLab returned an incomplete or stale MR head pipeline.');
    }
    return ok({ headSha: mr.sha, pipeline: {
      id: pipeline.id, projectId: pipeline.project_id, status: pipeline.status ?? null,
    } });
  }

  private async checkRunsForPipeline(
    project: string, pipelineId: number, collection: 'jobs' | 'trigger_jobs' = 'jobs'
  ): Promise<Evidence<CheckRunInfo[]>> {
    const jobsEv = await this.readPipelineJobs(project, pipelineId, collection);
    return jobsEv.ok ? ok(jobsEv.value.checks) : jobsEv;
  }

  private async readPipelineJobs(
    project: string, pipelineId: number, collection: 'jobs' | 'trigger_jobs'
  ): Promise<Evidence<PipelineJobsFact>> {
    const jobsEv = await this.paginateList(
      (page) => `projects/${project}/pipelines/${pipelineId}/${collection}?per_page=${LIST_PAGE_SIZE}&page=${page}`,
      'pipeline-job-list'
    );
    if (!jobsEv.ok) return jobsEv;
    const runs: CheckRunInfo[] = [];
    const downstream: unknown[] = [];
    for (const job of jobsEv.value) {
      const item = job as {
        name?: unknown;
        status?: unknown;
        id?: unknown;
        started_at?: unknown;
        allow_failure?: unknown;
        downstream_pipeline?: unknown;
      } | null;
      if (item === null || typeof item !== 'object' ||
          typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0 ||
          typeof item.name !== 'string' || item.name === '' ||
          typeof item.status !== 'string' || item.status === '' ||
          typeof item.allow_failure !== 'boolean' ||
          (item.started_at !== null && (typeof item.started_at !== 'string' || Number.isNaN(Date.parse(item.started_at))))) {
        return fail('glab_transport', 'GitLab returned an incomplete or malformed pipeline job.');
      }
      const jobStatus = item.status;
      if (collection === 'trigger_jobs') downstream.push(item.downstream_pipeline);
      // Skipped is absent in this pipeline; no earlier pipeline fills it.
      if (jobStatus === 'skipped') continue;
      runs.push({
        name: item.name,
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
        ...(item.allow_failure ? { allowFailure: true } : {}),
        id: item.id,
        startedAt: item.started_at,
      });
    }
    return ok({ checks: runs, downstream });
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
    const existingEv = await this.paginateList(
      (page) => `projects/${this.projectPath(repo)}/issues/${issue}/notes?per_page=${LIST_PAGE_SIZE}&page=${page}`,
      'issue-note-list'
    );
    if (!existingEv.ok) return existingEv;
    let existingUrl: string | undefined;
    for (const entry of existingEv.value) {
      const note = entry as { id?: unknown; body?: unknown; web_url?: unknown } | null;
      if (note === null || typeof note !== 'object' || typeof note.body !== 'string' ||
          !Number.isSafeInteger(note.id) || (note.id as number) <= 0) {
        return fail('glab_transport', 'GitLab returned an incomplete issue-note entry.');
      }
      if (note.body === body && existingUrl === undefined) {
        existingUrl = typeof note.web_url === 'string' && note.web_url
          ? note.web_url
          : this.noteDeepLink(repo, issue, note.id as number);
      }
    }
    if (existingUrl !== undefined) return ok({ url: existingUrl });
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
   * Add labels to an issue (#330): PUT with `add_labels` — union
   * semantics; present names stay. GitLab answers the updated issue
   * entity whose `labels` array names every carried label; every
   * requested slug must appear there or the result cannot be verified
   * (fail-closed).
   */
  async addIssueLabels(
    repo: RepoRef,
    issue: number,
    slugs: string[]
  ): Promise<Evidence<LabelsAppliedFact>> {
    if (!Number.isInteger(issue) || issue <= 0) {
      return fail('glab_transport', 'Cannot label an issue without a positive number.');
    }
    if (slugs.length === 0 || slugs.some((slug) => !slug.trim())) {
      return fail('glab_transport', 'Cannot label an issue without at least one non-empty label.');
    }

    const result = await this.runCreate([
      'api',
      ...this.hostArgs(),
      '-X',
      'PUT',
      `projects/${this.projectPath(repo)}/issues/${issue}`,
      '-f',
      `add_labels=${slugs.join(',')}`,
    ]);
    if (!result.ok) {
      return this.asFailure(result);
    }
    const parsedEv = this.parseJsonOutput(result.value.stdout);
    if (!parsedEv.ok) {
      return parsedEv;
    }
    const payload = parsedEv.value as { labels?: unknown };
    if (!Array.isArray(payload.labels)) {
      return fail('glab_transport', 'GitLab returned an unexpected issue-labels payload.');
    }
    const carried = payload.labels.filter(
      (name): name is string => typeof name === 'string' && name !== ''
    );
    for (const slug of slugs) {
      if (!carried.includes(slug)) {
        return fail(
          'glab_transport',
          `Label '${sanitizeApiText(slug)}' is absent after the apply; the result could not be verified.`
        );
      }
    }
    return ok({ names: slugs });
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

  /**
   * Every label title the project carries (#330): the pool tags are
   * selected from. Project endpoint — group-inherited labels live on
   * their own API surface and are out of v1 scope (documented in
   * docs/providers.md); a group-label-only repository reads as an
   * empty pool and converges through seeding. Completeness rule (#120,
   * I3b) via paginateList: exhaustion or fail-closed, never partial.
   */
  async listRepoLabels(repo: RepoRef): Promise<Evidence<RepoLabelsFact>> {
    const pagesEv = await this.paginateList(
      (page) => `projects/${this.projectPath(repo)}/labels?per_page=${LIST_PAGE_SIZE}&page=${page}`,
      'label-list'
    );
    if (!pagesEv.ok) {
      return pagesEv;
    }
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of pagesEv.value) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== 'string' || name === '') {
        return fail('glab_transport', 'GitLab returned a label entry without a name.');
      }
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return ok({ names });
  }

  /**
   * Idempotent seed (#330): create every missing spec at project level,
   * leave existing names untouched, echo exactly the requested slugs.
   * GitLab answers 409 ("already been taken") for a duplicate title;
   * that is presence, not failure. A spec the forge refuses to confirm
   * fails closed. Color takes the same no-`#` six-hex form GitHub does.
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
        return fail('glab_transport', 'Cannot seed a label without a name and six-hex color.');
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
      const result = await this.runCreate([
        'api',
        ...this.hostArgs(),
        '-X',
        'POST',
        `projects/${this.projectPath(repo)}/labels`,
        '-f',
        `name=${spec.name}`,
        '-f',
        `color=${spec.color}`,
      ]);
      if (!result.ok) {
        if (!GLAB_LABEL_ALREADY_EXISTS_PATTERN.test(result.message ?? '')) {
          return this.asFailure(result);
        }
        confirmed.push(spec.name);
        continue;
      }
      const parsedEv = this.parseJsonOutput(result.value.stdout);
      if (!parsedEv.ok) {
        return parsedEv;
      }
      const created = parsedEv.value as { name?: unknown };
      if (created.name !== spec.name) {
        return fail(
          'glab_transport',
          'Label was applied but the response could not be verified: the created name differs.'
        );
      }
      confirmed.push(spec.name);
    }
    return ok({ names: confirmed });
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
