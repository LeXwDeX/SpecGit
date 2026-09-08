import { z } from 'zod';
import { fail, ok, type Evidence } from '../../kernel/evidence.js';
import type { OriginalExecution, ReuseExecutionPort, ReuseExecutionRef } from '../../verification/reuse-decision.js';
import { parseOriginalJobName, verifyReuseProducer, type ApprovedReuseProducer } from '../../verification/reuse-producer.js';
import { reuseApi, type ReuseApi } from '../reuse-api.js';

const id = z.number().int().positive().safe();
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const runSchema = z.object({
  id, run_attempt: id, head_sha: sha, path: z.string(), status: z.string(), conclusion: z.string().nullable(),
  event: z.string(), repository: z.object({ full_name: z.string() }), head_repository: z.object({ full_name: z.string() }),
});
const jobSchema = z.object({
  id, run_id: id, run_attempt: id, head_sha: sha, name: z.string(), status: z.string(),
  conclusion: z.string().nullable(), completed_at: z.string().nullable(),
});
const unavailable = () => fail<never>('github_original_execution_unproven',
  'The original GitHub verification execution could not be proven.',
  'Execute verification; native original identity, source, attempt and successful completion are required.');

export class GitHubReuseExecutions implements ReuseExecutionPort {
  private readonly api: ReuseApi;
  private readonly prefix: string;
  private readonly identity: string;

  constructor(private readonly options: {
    repository: string; producer: ApprovedReuseProducer; currentRun: string; since: string; api?: ReuseApi;
  }) {
    this.api = options.api ?? reuseApi('github', 'github.com');
    this.prefix = `repos/${options.repository}`;
    this.identity = `github.com/${options.repository}`;
  }

  async candidates(repository: string, profile: string): Promise<Evidence<ReuseExecutionRef[]>> {
    try {
      if (repository !== this.identity || profile !== this.options.producer.profile ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.options.repository) ||
          !Number.isFinite(Date.parse(this.options.since))) return unavailable();
      const result = await this.api(`${this.prefix}/actions/workflows/${encodeURIComponent(this.options.producer.entry)}/runs?per_page=20&created=${encodeURIComponent(`>=${this.options.since}`)}`);
      if (!result.ok) return unavailable();
      const parsed = z.object({ total_count: z.number().int().min(0), workflow_runs: z.array(runSchema).max(20) }).safeParse(result.value);
      if (!parsed.success || parsed.data.total_count !== parsed.data.workflow_runs.length) return unavailable();
      const refs: ReuseExecutionRef[] = [];
      const runs = [...parsed.data.workflow_runs].sort((a, b) => b.id - a.id);
      if (new Set(runs.map((run) => run.id)).size !== runs.length) return unavailable();
      for (const run of runs) {
        if (String(run.id) === this.options.currentRun) continue;
        const jobs = await this.jobs(run.id, run.run_attempt);
        if (!jobs.ok) return jobs;
        for (const job of [...jobs.value].sort((a, b) => b.id - a.id)) {
          const identity = parseOriginalJobName(job.name);
          if (identity?.profile !== profile) continue;
          if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha) return unavailable();
          refs.push({ repository, run: String(run.id), attempt: run.run_attempt, job: String(job.id) });
        }
      }
      return refs.length <= 20 ? ok(refs) : unavailable();
    } catch { return unavailable(); }
  }

  async original(ref: ReuseExecutionRef): Promise<Evidence<OriginalExecution>> {
    try {
      if (ref.repository !== this.identity || !/^[1-9][0-9]*$/.test(ref.run) || !/^[1-9][0-9]*$/.test(ref.job) ||
          !Number.isSafeInteger(ref.attempt) || ref.attempt < 1) return unavailable();
      const runResult = await this.api(`${this.prefix}/actions/runs/${ref.run}`);
      const jobResult = await this.api(`${this.prefix}/actions/jobs/${ref.job}`);
      if (!runResult.ok || !jobResult.ok) return unavailable();
      const run = runSchema.safeParse(runResult.value);
      const job = jobSchema.safeParse(jobResult.value);
      if (!run.success || !job.success) return unavailable();
      const r = run.data;
      const j = job.data;
      const named = parseOriginalJobName(j.name);
      if (!named || named.profile !== this.options.producer.profile ||
          r.repository.full_name !== this.options.repository || r.head_repository.full_name !== this.options.repository ||
          !['pull_request', 'push', 'workflow_dispatch'].includes(r.event) || r.path !== this.options.producer.entry ||
          String(r.id) !== ref.run || r.run_attempt !== ref.attempt || String(j.id) !== ref.job ||
          j.run_id !== r.id || j.run_attempt !== ref.attempt || j.head_sha !== r.head_sha ||
          r.status !== 'completed' || r.conclusion !== 'success' || j.status !== 'completed' || j.conclusion !== 'success' ||
          !j.completed_at || !Number.isFinite(Date.parse(j.completed_at))) return unavailable();
      const jobs = await this.jobs(r.id, ref.attempt);
      if (!jobs.ok || jobs.value.filter((entry) => entry.name === j.name).length !== 1 ||
          !jobs.value.some((entry) => entry.id === j.id)) return unavailable();
      const producer = await verifyReuseProducer(this.options.producer, r.head_sha, async (revision, file) => {
        const result = await this.api(`${this.prefix}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`);
        if (!result.ok) return unavailable();
        const content = z.object({ type: z.literal('file'), encoding: z.literal('base64'), content: z.string().max(1_500_000) }).safeParse(result.value);
        if (!content.success || !/^[A-Za-z0-9+/=\n\r]*$/.test(content.data.content)) return unavailable();
        return ok(Buffer.from(content.data.content, 'base64'));
      });
      if (!producer.ok) return producer;
      return ok({ ref, profile: named.profile, sourceSha: r.head_sha, recipeDigest: producer.value.recipeDigest,
        inputDigest: named.digest, completedAt: j.completed_at });
    } catch { return unavailable(); }
  }

  private async jobs(run: number, attempt: number): Promise<Evidence<z.infer<typeof jobSchema>[]>> {
    const result = await this.api(`${this.prefix}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`);
    if (!result.ok) return unavailable();
    const parsed = z.object({ total_count: z.number().int().min(0), jobs: z.array(jobSchema).max(100) }).safeParse(result.value);
    if (!parsed.success || parsed.data.total_count !== parsed.data.jobs.length ||
        new Set(parsed.data.jobs.map((job) => job.id)).size !== parsed.data.jobs.length) return unavailable();
    return ok(parsed.data.jobs);
  }
}
