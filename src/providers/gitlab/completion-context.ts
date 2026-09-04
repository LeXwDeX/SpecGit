import { fail, ok, type Evidence } from '../../kernel/evidence.js';
import type { RepoRef } from '../../gitfacts/origin.js';
import { isAutomationTargetBranch } from '../../record/policy.js';

/** Supplied only by the trusted remote entry, never read by ordinary CLI evidence. */
export interface GitlabCompletionIdentity {
  projectId: number;
  pipelineId: number;
  jobId: number;
  sourcePipelineId: number;
  pr: number;
  headSha: string;
  checkoutSha: string;
}

export interface GitlabCompletionReads {
  api(path: string): Promise<Evidence<unknown>>;
  list(path: string): Promise<Evidence<unknown[]>>;
}

type ObjectFact = Record<string, unknown>;
const object = (value: unknown): ObjectFact => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectFact : {};
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const sha = (value: string): boolean => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const mismatch = (detail: string) => fail<never>('gitlab_completion_unverified', `The independent completion pipeline could not be proven: ${detail}`);

/**
 * Authenticate every edge before removing this pipeline from its own wait set.
 * An environment hint, job name, or matching SHA alone grants no exception.
 */
export async function verifyGitlabCompletion(
  repo: RepoRef, input: GitlabCompletionIdentity, reads: GitlabCompletionReads,
): Promise<Evidence<{ projectId: number; pipelineId: number }>> {
  if (repo.platform !== 'gitlab' || ![input.projectId, input.pipelineId, input.jobId, input.sourcePipelineId, input.pr].every(positive) ||
      input.pipelineId === input.sourcePipelineId || !sha(input.headSha) || !sha(input.checkoutSha)) return mismatch('invalid identity.');
  const projectResult = await reads.api(`projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}`);
  if (!projectResult.ok) return projectResult;
  const project = object(projectResult.value);
  if (project.id !== input.projectId || project.path_with_namespace !== `${repo.owner}/${repo.repo}` ||
      typeof project.default_branch !== 'string' || !isAutomationTargetBranch(project.default_branch)) return mismatch('project or default branch differs.');
  const base = `projects/${input.projectId}`;
  const pipelineResult = await reads.api(`${base}/pipelines/${input.pipelineId}`);
  if (!pipelineResult.ok) return pipelineResult;
  const pipeline = object(pipelineResult.value);
  if (pipeline.id !== input.pipelineId || pipeline.project_id !== input.projectId || pipeline.source !== 'pipeline' ||
      pipeline.ref !== project.default_branch || pipeline.sha !== input.checkoutSha || pipeline.tag !== false) return mismatch('execution is not the identified default-branch pipeline.');
  const jobsResult = await reads.list(`${base}/pipelines/${input.pipelineId}/jobs`);
  if (!jobsResult.ok) return jobsResult;
  const job = object(jobsResult.value[0]);
  const jobPipeline = object(job.pipeline);
  if (jobsResult.value.length !== 1 || job.id !== input.jobId || job.name !== 'specgit-complete' || job.status !== 'running' ||
      jobPipeline.id !== input.pipelineId || jobPipeline.project_id !== input.projectId || jobPipeline.sha !== input.checkoutSha) return mismatch('the isolated pipeline must contain only its executing completion job.');
  const ownBridges = await reads.list(`${base}/pipelines/${input.pipelineId}/trigger_jobs`);
  if (!ownBridges.ok) return ownBridges;
  if (ownBridges.value.length !== 0) return mismatch('the completion pipeline has additional downstream work.');
  const mrResult = await reads.api(`${base}/merge_requests/${input.pr}`);
  if (!mrResult.ok) return mrResult;
  const mr = object(mrResult.value);
  const headPipeline = object(mr.head_pipeline);
  if (mr.iid !== input.pr || mr.sha !== input.headSha || mr.source_project_id !== input.projectId || mr.target_project_id !== input.projectId ||
      headPipeline.id !== input.sourcePipelineId || headPipeline.project_id !== input.projectId || headPipeline.sha !== input.headSha) return mismatch('the source is not the current same-project MR head pipeline.');
  const sourceResult = await reads.api(`${base}/pipelines/${input.sourcePipelineId}`);
  if (!sourceResult.ok) return sourceResult;
  const source = object(sourceResult.value);
  if (source.id !== input.sourcePipelineId || source.project_id !== input.projectId || source.sha !== input.headSha || source.source !== 'merge_request_event') return mismatch('the source pipeline does not represent this MR head.');
  const bridgesResult = await reads.list(`${base}/pipelines/${input.sourcePipelineId}/trigger_jobs`);
  if (!bridgesResult.ok) return bridgesResult;
  const bridges = bridgesResult.value.map(object).filter((bridge) => object(bridge.downstream_pipeline).id === input.pipelineId);
  const bridge = bridges[0];
  const downstream = object(bridge?.downstream_pipeline);
  if (bridges.length !== 1 || bridge.name !== 'specgit-request-completion' || !positive(Number(bridge.id)) ||
      !['success', 'running', 'pending'].includes(String(bridge.status)) ||
      downstream.sha !== input.checkoutSha || downstream.ref !== project.default_branch ||
      (downstream.project_id !== undefined && downstream.project_id !== input.projectId)) return mismatch('the current MR pipeline does not own this completion trigger.');
  return ok({ projectId: input.projectId, pipelineId: input.pipelineId });
}
