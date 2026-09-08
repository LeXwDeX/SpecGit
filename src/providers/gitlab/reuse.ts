import { z } from 'zod';
import { fail, ok, type Evidence } from '../../kernel/evidence.js';
import type { OriginalExecution, ReuseExecutionPort, ReuseExecutionRef } from '../../verification/reuse-decision.js';
import { parseOriginalJobName, verifyReuseProducer, type ApprovedReuseProducer } from '../../verification/reuse-producer.js';
import { reuseApi, type ReuseApi } from '../reuse-api.js';
import { verifyHistoricalGitLabJobIdentity, verifyRunningGitLabJobIdentity } from './job-identity.js';

const id = z.number().int().positive().safe();
const idText = z.string().regex(/^[1-9][0-9]*$/).max(30);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const pipelineSchema = z.object({ id, project_id: id, sha, source: z.string(), status: z.string(), ref: z.string() });
const jobSchema = z.object({
  id, name: z.string(), pipeline: z.object({ id, project_id: id, sha }), commit: z.object({ id: sha }),
  status: z.string(), ref: z.string(), created_at: z.string(), started_at: z.string().nullable(),
  finished_at: z.string().nullable(), erased_at: z.string().nullable(),
});
const bridgeSchema = z.object({ id, name: z.string(), status: z.string(),
  downstream_pipeline: z.object({ id, project_id: id, sha, status: z.string() }).nullable() });
const unavailable = () => fail<never>('gitlab_original_execution_unproven',
  'The original GitLab verification execution could not be proven.',
  'Execute verification; child/bridge identity, signed parent configuration and native success are required.');

export class GitLabReuseExecutions implements ReuseExecutionPort {
  private readonly api: ReuseApi;
  private readonly prefix: string;
  private readonly identity: string;

  constructor(private readonly options: {
    host: string; project: string; producer: ApprovedReuseProducer; currentRun: string; since: string; api?: ReuseApi;
  }) {
    this.api = options.api ?? reuseApi('gitlab', options.host);
    this.prefix = `projects/${encodeURIComponent(options.project)}`;
    this.identity = `${options.host}/${options.project}`;
  }

  /** Signed executing configuration replaces no authority; it proves the native CI entry directly. */
  async currentConfiguration(input: {
    jobId: string; pipelineId: string; sourceSha: string; assertion?: string; now: number;
  }): Promise<Evidence<string>> {
    try {
      const current = await this.currentPipeline();
      const native = await this.api('job');
      if (!current.ok || !native.ok) return unavailable();
      const parsed = jobSchema.safeParse(native.value);
      if (!parsed.success) return unavailable();
      const job = parsed.data;
      const parent = current.value;
      if (String(job.id) !== input.jobId || String(job.pipeline.id) !== input.pipelineId || job.status !== 'running' ||
          job.pipeline.project_id !== parent.project_id || job.pipeline.sha !== input.sourceSha || job.commit.id !== input.sourceSha ||
          parent.sha !== input.sourceSha || !['push', 'merge_request_event', 'web'].includes(parent.source)) return unavailable();
      let preparation = job;
      let assertion = input.assertion;
      const running = String(job.pipeline.id) === this.options.currentRun;
      if (!running) {
        const bridges = await this.bridges(parent.id);
        const preparations = await this.jobs(parent.id);
        if (!bridges.ok || !preparations.ok) return unavailable();
        const matching = bridges.value.filter((bridge) => bridge.name === `SpecGit dispatch / ${this.options.producer.profile}` &&
          bridge.downstream_pipeline?.id === job.pipeline.id && bridge.downstream_pipeline.project_id === parent.project_id &&
          bridge.downstream_pipeline.sha === input.sourceSha);
        const prepared = preparations.value.filter((item) => item.name === `SpecGit prepare / ${this.options.producer.profile}`);
        if (matching.length !== 1 || prepared.length !== 1 || !this.successful(prepared[0])) return unavailable();
        preparation = prepared[0];
        const proof = await this.api(`${this.prefix}/jobs/${preparation.id}/artifacts/.specgit-reuse/identity.json`);
        if (!proof.ok) return unavailable();
        const stored = z.object({ assertion: z.string().max(65536) }).strict().safeParse(proof.value);
        if (!stored.success) return unavailable();
        assertion = stored.data.assertion;
      }
      if (!assertion || preparation.name !== `SpecGit prepare / ${this.options.producer.profile}` ||
          preparation.pipeline.id !== parent.id || preparation.pipeline.project_id !== parent.project_id ||
          preparation.pipeline.sha !== input.sourceSha || preparation.commit.id !== input.sourceSha || preparation.started_at === null) return unavailable();
      const keys = await this.api(`https://${this.options.host}/oauth/discovery/keys`);
      if (!keys.ok) return unavailable();
      const refPath = await this.configurationRef(parent, preparation.ref);
      if (!refPath.ok) return refPath;
      const expected = { issuer: `https://${this.options.host}`, projectId: String(parent.project_id), projectPath: this.options.project,
        pipelineId: String(parent.id), jobId: String(preparation.id), sourceSha: input.sourceSha, pipelineSource: parent.source,
        configPath: this.options.producer.entry, refPath: refPath.value,
        createdAt: preparation.created_at, startedAt: preparation.started_at };
      const identity = running
        ? verifyRunningGitLabJobIdentity(assertion, keys.value, { ...expected, observedAt: new Date(input.now).toISOString() })
        : verifyHistoricalGitLabJobIdentity(assertion, keys.value, { ...expected, finishedAt: preparation.finished_at! });
      return identity.ok ? ok(identity.value.configPath) : identity;
    } catch { return unavailable(); }
  }

  async candidates(repository: string, profile: string): Promise<Evidence<ReuseExecutionRef[]>> {
    try {
      if (repository !== this.identity || profile !== this.options.producer.profile ||
          !Number.isFinite(Date.parse(this.options.since))) return unavailable();
      const current = await this.currentPipeline();
      if (!current.ok) return current;
      const projectId = current.value.project_id;
      const result = await this.api(`${this.prefix}/pipelines?per_page=20&order_by=id&sort=desc&ref=${encodeURIComponent(current.value.ref)}&updated_after=${encodeURIComponent(this.options.since)}`);
      if (!result.ok) return unavailable();
      // A full page cannot prove the bounded time-window inventory is complete.
      const parsed = z.array(pipelineSchema).max(19).safeParse(result.value);
      if (!parsed.success || new Set(parsed.data.map((run) => run.id)).size !== parsed.data.length) return unavailable();
      const refs: ReuseExecutionRef[] = [];
      for (const parent of [...parsed.data].sort((a, b) => b.id - a.id)) {
        if (String(parent.id) === this.options.currentRun || parent.source === 'parent_pipeline') continue;
        if (parent.project_id !== projectId || parent.ref !== current.value.ref) return unavailable();
        const bridges = await this.bridges(parent.id);
        if (!bridges.ok) return bridges;
        for (const bridge of bridges.value) {
          if (bridge.name !== `SpecGit dispatch / ${profile}`) continue;
          const child = bridge.downstream_pipeline;
          // Native skipped dispatches without a child contain no execution.
          // A failed, canceled or missing child remains unavailable evidence.
          if (bridge.status === 'skipped' && child === null) continue;
          if (!child || child.project_id !== projectId || child.sha !== parent.sha) return unavailable();
          const jobs = await this.jobs(child.id);
          if (!jobs.ok) return jobs;
          for (const job of [...jobs.value].sort((a, b) => b.id - a.id)) {
            if (parseOriginalJobName(job.name)?.profile !== profile) continue;
            if (job.pipeline.id !== child.id || job.pipeline.project_id !== projectId || job.pipeline.sha !== parent.sha) return unavailable();
            refs.push({ repository, run: String(child.id), attempt: 1, job: String(job.id) });
          }
        }
      }
      return refs.length <= 20 ? ok(refs) : unavailable();
    } catch { return unavailable(); }
  }

  async original(ref: ReuseExecutionRef): Promise<Evidence<OriginalExecution>> {
    try {
      if (ref.repository !== this.identity || !idText.safeParse(ref.run).success || !idText.safeParse(ref.job).success || ref.attempt !== 1) return unavailable();
      const current = await this.currentPipeline();
      if (!current.ok) return current;
      const projectId = current.value.project_id;
      const child = await this.readPipeline(ref.run);
      const currentJobs = await this.jobs(Number(ref.run));
      if (!child.ok || !currentJobs.ok) return unavailable();
      const j = currentJobs.value.find((item) => String(item.id) === ref.job);
      if (!j || currentJobs.value.filter((item) => item.name === j.name).length !== 1) return unavailable();
      const named = parseOriginalJobName(j.name);
      const c = child.value;
      if (!named || named.profile !== this.options.producer.profile || c.project_id !== projectId ||
          String(c.id) !== ref.run || String(j.id) !== ref.job || j.pipeline.id !== c.id ||
          j.pipeline.project_id !== projectId || j.pipeline.sha !== c.sha || j.commit.id !== c.sha ||
          c.source !== 'parent_pipeline' || c.status !== 'success' || !this.successful(j)) return unavailable();
      // This artifact only locates evidence. Native bridge membership and signed identity prove it.
      const hintResult = await this.api(`${this.prefix}/jobs/${ref.job}/artifacts/.specgit-reuse/parent.json`);
      if (!hintResult.ok) return unavailable();
      const hint = z.object({ parentPipeline: idText, prepareJob: idText }).strict().safeParse(hintResult.value);
      if (!hint.success) return unavailable();
      const parent = await this.readPipeline(hint.data.parentPipeline);
      const preparationJobs = await this.jobs(Number(hint.data.parentPipeline));
      if (!parent.ok || !preparationJobs.ok) return unavailable();
      const prep = preparationJobs.value.find((item) => String(item.id) === hint.data.prepareJob);
      if (!prep || preparationJobs.value.filter((item) => item.name === prep.name).length !== 1) return unavailable();
      const p = parent.value;
      // A draft can fail current acceptance after successful business verification.
      // Only that exact independent failure may coexist with reusable original evidence.
      const acceptanceOnlyFailure = p.status === 'failed' &&
        preparationJobs.value.filter((item) => item.name === 'SpecGit Acceptance').length === 1 &&
        preparationJobs.value.every((item) => item.name === 'SpecGit Acceptance'
          ? item.status === 'failed' && item.started_at !== null && item.finished_at !== null && item.erased_at === null &&
            Number.isFinite(Date.parse(item.started_at)) && Number.isFinite(Date.parse(item.finished_at))
          : this.successful(item));
      if (p.project_id !== projectId || p.ref !== current.value.ref || p.sha !== c.sha ||
          (p.status !== 'success' && !acceptanceOnlyFailure) ||
          !['push', 'merge_request_event', 'web'].includes(p.source) ||
          prep.pipeline.id !== p.id || prep.pipeline.project_id !== projectId || prep.pipeline.sha !== c.sha ||
          prep.commit.id !== c.sha || prep.name !== `SpecGit prepare / ${named.profile}` || !this.successful(prep)) return unavailable();
      const bridges = await this.bridges(p.id);
      if (!bridges.ok) return bridges;
      const matching = bridges.value.filter((bridge) => bridge.name === `SpecGit dispatch / ${named.profile}`);
      if (matching.length !== 1 || matching[0].status !== 'success' || matching[0].downstream_pipeline?.id !== c.id ||
          matching[0].downstream_pipeline.project_id !== projectId || matching[0].downstream_pipeline.sha !== c.sha) return unavailable();
      const proofResult = await this.api(`${this.prefix}/jobs/${prep.id}/artifacts/.specgit-reuse/identity.json`);
      const keys = await this.api(`https://${this.options.host}/oauth/discovery/keys`);
      if (!proofResult.ok || !keys.ok) return unavailable();
      const proof = z.object({ assertion: z.string().max(65536) }).strict().safeParse(proofResult.value);
      if (!proof.success) return unavailable();
      const refPath = await this.configurationRef(p, prep.ref);
      if (!refPath.ok) return refPath;
      const verified = verifyHistoricalGitLabJobIdentity(proof.data.assertion, keys.value, {
        issuer: `https://${this.options.host}`, projectId: String(projectId), projectPath: this.options.project,
        pipelineId: String(p.id), jobId: String(prep.id), sourceSha: c.sha, pipelineSource: p.source,
        configPath: this.options.producer.entry, refPath: refPath.value,
        createdAt: prep.created_at, startedAt: prep.started_at!, finishedAt: prep.finished_at!,
      });
      if (!verified.ok) return verified;
      const producer = await verifyReuseProducer(this.options.producer, c.sha, async (revision, file) => {
        const result = await this.api(`${this.prefix}/repository/files/${encodeURIComponent(file)}/raw?ref=${revision}`, 'text');
        if (!result.ok) return unavailable();
        if (typeof result.value !== 'string' || Buffer.byteLength(result.value, 'utf8') > 1_000_000) return unavailable();
        return ok(Buffer.from(result.value, 'utf8'));
      });
      if (!producer.ok) return producer;
      return ok({ ref, profile: named.profile, sourceSha: c.sha, recipeDigest: producer.value.recipeDigest,
        inputDigest: named.digest, completedAt: j.finished_at! });
    } catch { return unavailable(); }
  }

  /** MR execution refs and signed source-branch refs are distinct native identities. */
  private async configurationRef(pipeline: z.infer<typeof pipelineSchema>, jobRef: string): Promise<Evidence<string>> {
    if (pipeline.ref !== jobRef) return unavailable();
    if (pipeline.source !== 'merge_request_event') return ok(`refs/heads/${jobRef}`);
    const match = /^refs\/merge-requests\/([1-9][0-9]*)\/head$/.exec(jobRef);
    if (!match) return unavailable();
    const result = await this.api(`${this.prefix}/merge_requests/${match[1]}`);
    if (!result.ok) return unavailable();
    const request = z.object({ iid: id, project_id: id, source_project_id: id, target_project_id: id,
      source_branch: z.string().min(1).max(1024).regex(/^[^\s\x00-\x1f\x7f]+$/),
    }).safeParse(result.value);
    if (!request.success || String(request.data.iid) !== match[1] ||
        request.data.project_id !== pipeline.project_id || request.data.source_project_id !== pipeline.project_id ||
        request.data.target_project_id !== pipeline.project_id) return unavailable();
    return ok(`refs/heads/${request.data.source_branch}`);
  }

  private successful(job: z.infer<typeof jobSchema>): boolean {
    return job.status === 'success' && job.erased_at === null && job.started_at !== null && job.finished_at !== null &&
      Number.isFinite(Date.parse(job.started_at)) && Number.isFinite(Date.parse(job.finished_at));
  }

  private async currentPipeline(): Promise<Evidence<z.infer<typeof pipelineSchema>>> {
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,4}$/.test(this.options.project) ||
        !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(this.options.host)) return unavailable();
    if (!idText.safeParse(this.options.currentRun).success) return unavailable();
    return this.readPipeline(this.options.currentRun);
  }

  private async readPipeline(run: string): Promise<Evidence<z.infer<typeof pipelineSchema>>> {
    const result = await this.api(`${this.prefix}/pipelines/${run}`);
    if (!result.ok) return unavailable();
    const parsed = pipelineSchema.safeParse(result.value);
    return parsed.success && String(parsed.data.id) === run ? ok(parsed.data) : unavailable();
  }

  private async jobs(run: number): Promise<Evidence<z.infer<typeof jobSchema>[]>> {
    const result = await this.api(`${this.prefix}/pipelines/${run}/jobs?per_page=100&include_retried=false`);
    if (!result.ok) return unavailable();
    const parsed = z.array(jobSchema).max(99).safeParse(result.value);
    return parsed.success && new Set(parsed.data.map((job) => job.id)).size === parsed.data.length ? ok(parsed.data) : unavailable();
  }

  private async bridges(run: number): Promise<Evidence<z.infer<typeof bridgeSchema>[]>> {
    const result = await this.api(`${this.prefix}/pipelines/${run}/bridges?per_page=100`);
    if (!result.ok) return unavailable();
    const parsed = z.array(bridgeSchema).max(99).safeParse(result.value);
    return parsed.success && new Set(parsed.data.map((bridge) => bridge.id)).size === parsed.data.length ? ok(parsed.data) : unavailable();
  }
}
