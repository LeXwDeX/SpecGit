import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { createDefaultContext } from './wiring.js';
import { acceptanceScript, GITLAB_ACCEPTANCE_PATH } from './acceptance-step.js';
import { reuseApi } from '../providers/reuse-api.js';
import { GitHubReuseExecutions } from '../providers/github/reuse.js';
import { GitLabReuseExecutions } from '../providers/gitlab/reuse.js';
import { resolveVerification } from '../verification/resolve.js';
import { collectReuseInputs } from '../verification/reuse-inputs.js';
import { reuseEnvironment, type ReuseProfile } from '../verification/reuse-profile.js';
import { verifyReuseProducer } from '../verification/reuse-producer.js';
import { githubReuseWorkflow, gitlabReuseWorkflow } from '../verification/reuse-workflow.js';
import { GITLAB_BUSINESS_WORKFLOW_PATH, gitlabRoutingWorkflowYaml } from './completion-workflow.js';
import { readVerificationTool } from '../verification/reuse-runner.js';
import type { ReuseContext, ReuseExecutionPort } from '../verification/reuse-decision.js';

export interface ReuseCiState {
  root: string; profile: ReuseProfile; checkoutSha: string; platform: 'github' | 'gitlab';
  repository: string; run: string; attempt: number;
  context: Evidence<ReuseContext>; executions: ReuseExecutionPort;
  applicable?: boolean;
  verifyJobName?: (name: string) => Promise<boolean>;
}

const unavailable = (stage = 'current') => fail<never>(`verification_reuse_${stage}_unavailable`,
  'Current native identity, approved recipe or complete runtime inputs are unavailable; execute verification without reuse.');
const emptyExecutions: ReuseExecutionPort = { candidates: async () => unavailable(), original: async () => unavailable() };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** CI-only composition; every observation creates fresh policy and provider readers. */
export async function readReuseCiState(
  root: string, profileId: string, env: NodeJS.ProcessEnv, now: number, parentRun?: string,
): Promise<ReuseCiState> {
  const ctx = createDefaultContext();
  const facts = await ctx.git.facts(root);
  if (!facts.headSha) throw new Error('A committed checkout is required');
  const candidate = await ctx.record.readPolicy(root);
  if (!candidate.ok) throw new Error('A readable verification policy is required');
  const profile = candidate.value.verification?.reuse?.find((entry) => entry.id === profileId);
  if (!profile) throw new Error('The verification profile is not declared');
  const platform = env.GITLAB_CI === 'true' ? 'gitlab' : 'github';
  const host = platform === 'gitlab' ? env.CI_SERVER_FQDN ?? '' : 'github.com';
  const project = platform === 'gitlab' ? env.CI_PROJECT_PATH ?? '' : env.GITHUB_REPOSITORY ?? '';
  const run = platform === 'gitlab' ? parentRun ?? env.CI_PIPELINE_ID ?? '' : env.GITHUB_RUN_ID ?? '';
  const attempt = platform === 'gitlab' ? 1 : Number(env.GITHUB_RUN_ATTEMPT);
  const state: ReuseCiState = { root, profile, checkoutSha: facts.headSha, platform, repository: `${host}/${project}`,
    run, attempt, context: unavailable(), executions: emptyExecutions };
  let stage = 'native_identity';
  const uncached = () => ({ ...state, context: unavailable(stage) });
  try {
    if (!/^[1-9][0-9]*$/.test(run) || !Number.isSafeInteger(attempt) || attempt < 1 || !facts.originUrl) return uncached();
    stage = 'repository';
    const repo = await ctx.parseRepoRef(facts.originUrl);
    if (!repo.ok || repo.value.platform !== platform || `${repo.value.owner}/${repo.value.repo}` !== project) return uncached();
    const api = reuseApi(platform, host);
    const prefix = platform === 'github' ? `repos/${project}` : `projects/${encodeURIComponent(project)}`;
    stage = 'native_run';
    const native = await api(platform === 'github' ? `${prefix}/actions/runs/${run}` : `${prefix}/pipelines/${run}`);
    if (!native.ok || typeof native.value !== 'object' || native.value === null) return uncached();
    const runInfo = z.object({ id: z.number().int().safe(),
      head_sha: z.string().optional(), sha: z.string().optional(),
      run_attempt: z.number().optional(), project_id: z.number().optional(),
      repository: z.object({ full_name: z.string() }).optional(),
      head_repository: z.object({ full_name: z.string() }).optional(),
      path: z.string().optional(), source: z.string().optional(), event: z.string().optional(),
    }).safeParse(native.value);
    if (!runInfo.success || String(runInfo.data.id) !== run) return uncached();
    if (platform === 'github' && (runInfo.data.repository?.full_name !== project ||
        runInfo.data.head_repository?.full_name !== project || runInfo.data.run_attempt !== attempt ||
        runInfo.data.path !== profile.github?.entry || !['pull_request', 'workflow_dispatch'].includes(runInfo.data.event ?? ''))) return uncached();
    if (platform === 'gitlab' && (String(runInfo.data.project_id) !== env.CI_PROJECT_ID ||
        runInfo.data.sha !== facts.headSha || !['push', 'merge_request_event', 'web'].includes(runInfo.data.source ?? ''))) return uncached();
    state.verifyJobName = async (name) => {
      const result = await api(platform === 'github'
        ? `${prefix}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`
        : 'job');
      if (!result.ok) return false;
      if (platform === 'github') {
        const parsed = z.object({ total_count: z.number().int(), jobs: z.array(z.object({
          name: z.string(), status: z.string(), run_id: z.number(), run_attempt: z.number(), head_sha: z.string(),
        })).max(100) }).safeParse(result.value);
        return parsed.success && parsed.data.total_count === parsed.data.jobs.length &&
          parsed.data.jobs.filter((job) => job.name === name && job.status === 'in_progress' &&
            String(job.run_id) === run && job.run_attempt === attempt && job.head_sha === runInfo.data.head_sha).length === 1;
      }
      const parsed = z.object({ id: z.number(), name: z.string(), status: z.string(),
        pipeline: z.object({ id: z.number(), project_id: z.number(), sha: z.string() }),
      }).safeParse(result.value);
      return parsed.success && String(parsed.data.id) === env.CI_JOB_ID && parsed.data.name === name && parsed.data.status === 'running' &&
        String(parsed.data.pipeline.id) === env.CI_PIPELINE_ID && String(parsed.data.pipeline.project_id) === env.CI_PROJECT_ID &&
        parsed.data.pipeline.sha === facts.headSha;
    };
    stage = 'binding';
    const record = await ctx.record.readRecord(root);
    stage = 'approved_policy';
    const resolution = await ctx.resolvePolicy(root, record, { requireApproved: true });
    if (!resolution.ok || !record.ok || record.value.pr === undefined) return uncached();
    stage = 'request';
    const request = await ctx.gh.getPr(repo.value, record.value.pr);
    if (!request.ok || request.value.state !== 'open' || request.value.baseBranch !== resolution.value.branch) return uncached();
    if (platform === 'github' && request.value.headSha !== runInfo.data.head_sha) return uncached();
    stage = 'approved_recipe';
    const approved = resolution.value.policy.verification?.reuse?.find((entry) => entry.id === profileId);
    if (!approved || JSON.stringify(approved) !== JSON.stringify(profile)) return uncached();
    const entry = platform === 'github' ? approved.github?.entry : approved.gitlab?.entry;
    if (!entry) return uncached();
    const files: Array<{ path: string; content: string }> = [];
    if (platform === 'gitlab') files.push({ path: GITLAB_ACCEPTANCE_PATH, content: acceptanceScript() });
    let expected = platform === 'github' ? githubReuseWorkflow(approved)
      : gitlabReuseWorkflow(resolution.value.policy.verification!.reuse!);
    if (platform === 'gitlab' && (resolution.value.policy.automation?.merge || resolution.value.policy.automation?.close_issues)) {
      const branch = await ctx.git.remoteDefaultBranch(root, { requireEvidence: true });
      if (!branch.ok || entry !== '.gitlab-ci.yml') return uncached();
      files.push({ path: GITLAB_BUSINESS_WORKFLOW_PATH, content: expected });
      expected = gitlabRoutingWorkflowYaml({ platform: 'gitlab', selfHosted: false, defaultBranch: branch.value, version: ctx.version,
        targetBranch: resolution.value.policy.automation.target_branch });
    }
    stage = 'producer_files';
    const workflow = await ctx.git.readFileAtCommit(root, resolution.value.sha, entry);
    const policy = await ctx.git.readFileAtCommit(root, resolution.value.sha, 'spec_git/policy.yaml');
    const runtimeLock = await ctx.git.readFileAtCommit(root, resolution.value.sha, approved.runtime.lockfile);
    if (!workflow.ok || workflow.value.content !== expected || !policy.ok || policy.value.content === null ||
        !runtimeLock.ok || runtimeLock.value.content === null) return uncached();
    for (const file of files) {
      const read = await ctx.git.readFileAtCommit(root, resolution.value.sha, file.path);
      if (!read.ok || read.value.content !== file.content) return uncached();
    }
    const producer = { profile: profileId, entry, files: [
      ...files.map((file) => ({ path: file.path, sha256: hash(file.content) })),
      { path: entry, sha256: hash(expected) }, { path: 'spec_git/policy.yaml', sha256: hash(policy.value.content) },
      { path: approved.runtime.lockfile, sha256: hash(runtimeLock.value.content) },
    ] };
    const currentProducer = await verifyReuseProducer(producer, facts.headSha, async (sha, file) => {
      const result = await ctx.git.readFileAtCommit(root, sha, file);
      return result.ok && result.value.content !== null ? ok(Buffer.from(result.value.content)) : unavailable();
    });
    if (!currentProducer.ok) return uncached();
    stage = 'environment';
    const command = (name: string, args: string[]) => readVerificationTool(root, name, args, env);
    const image = platform === 'github' ? env.ImageOS ?? '' : env.CI_JOB_IMAGE ?? '';
    const imageVersion = platform === 'github' ? env.ImageVersion ?? '' : '';
    let system = `${image}\n${imageVersion}`;
    if (platform === 'gitlab') {
      try { system += '\n' + (await command('apk', ['info', '-v'])).split('\n').sort().join('\n'); }
      catch { system += '\n' + (await command('dpkg-query', ['-W', '-f=${Package}=${Version}\n'])).split('\n').sort().join('\n'); }
    }
    const environment = reuseEnvironment(profile, platform, {
      platform: process.platform, arch: process.arch, node: process.versions.node,
      pnpm: await command('pnpm', ['--version']), git: await command('git', ['--version']),
      image, imageVersion, systemDigest: hash(system),
    });
    if (!environment.ok) return uncached();
    stage = 'git_inputs';
    const inputs = await collectReuseInputs(root, { sourceSha: request.value.headSha, checkoutSha: facts.headSha,
      baseSha: resolution.value.sha, policySha: resolution.value.sha,
      recipeDigest: currentProducer.value.recipeDigest, environmentDigest: environment.value.digest });
    if (!inputs.ok) return uncached();
    const since = new Date(now - profile.max_age_seconds * 1000).toISOString();
    const gitlabExecutions = platform === 'gitlab'
      ? new GitLabReuseExecutions({ host, project, producer, currentRun: run, since }) : undefined;
    let entryEvidence: Evidence<string> | undefined;
    if (gitlabExecutions) {
      stage = 'ci_configuration';
      entryEvidence = await gitlabExecutions.currentConfiguration({ jobId: env.CI_JOB_ID ?? '',
        pipelineId: env.CI_PIPELINE_ID ?? '', sourceSha: facts.headSha, assertion: env.SPECGIT_REUSE_IDENTITY, now });
      if (!entryEvidence.ok) return uncached();
    }
    stage = 'selection';
    const selection = await resolveVerification({ root, policy: resolution.value.policy, policySha: resolution.value.sha,
      request: request.value, repo: repo.value,
      // Native signed configuration is evidence of the executing entry, not a guessed project setting.
      forge: entryEvidence ? { getCiConfigPath: async () => entryEvidence! } : ctx.gh, git: ctx.git });
    if (!selection.ok) return uncached();
    state.applicable = selection.value.requiredChecks.includes(profile.check);
    state.context = ok({ repository: state.repository, profile: { id: profileId, maxAgeSeconds: profile.max_age_seconds }, inputs: inputs.value });
    state.executions = gitlabExecutions ?? new GitHubReuseExecutions({ repository: project, producer, currentRun: run, since });
    return state;
  } catch { return uncached(); }
}
