/** Internal trusted-workflow entry. It is deliberately not a public CLI command. */
import { presentCompletion } from '../cli/completion-output.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createDefaultContext } from '../cli/wiring.js';
import { DeliveryBindingSchema } from '../record/schema.js';
import { isAutomationTargetBranch } from '../record/policy.js';
import { matchesBoundRequest, runRemoteDelivery } from './remote-delivery.js';
import * as recordIo from '../record/io.js';
import { GlabProvider } from '../providers/gitlab/glab-cli.js';
import type { GitlabCompletionIdentity } from '../providers/gitlab/completion-context.js';

const git = (root: string, hooks: string, args: string[]): string => execFileSync('git', ['-C', root, '-c', `core.hooksPath=${hooks}`, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
});

/** workflow_run may omit its PR list after merge; retain the identity resolved by the trusted identify job. */
export function workflowRequestNumber(requests: unknown, supplied: number): number | undefined {
  if (Array.isArray(requests) && requests.length === 1) {
    const item = requests[0] as { number?: unknown } | null;
    if (typeof item?.number === 'number' && Number.isSafeInteger(item.number) && item.number > 0) return item.number;
  }
  return Number.isSafeInteger(supplied) && supplied > 0 ? supplied : undefined;
}

/** Capability checked by workflows that must release a shared runner immediately. */
export const REMOTE_ENTRY_SINGLE_PASS = true;

/** Call from a trusted default-branch pipeline with gh/glab authentication and a full-history data checkout. */
export async function completeFromEnvironment(options: { singlePass?: boolean } = {}): Promise<number> {
  const parent = mkdtempSync(join(tmpdir(), 'specgit-completion-'));
  const hooks = join(parent, 'hooks');
  mkdirSync(hooks);
  const dataRoot = resolve(process.env.SPECGIT_DATA_ROOT ?? process.cwd());
  process.chdir(dataRoot);
  const ctx = createDefaultContext();
  const facts = await ctx.git.facts(dataRoot);
  if (!facts.originUrl) throw new Error('Completion requires a repository origin.');
  const repo = await ctx.parseRepoRef(facts.originUrl);
  if (!repo.ok) throw new Error(repo.message);
  let pr = Number(process.env.SPECGIT_PR);
  let headSha = process.env.SPECGIT_HEAD ?? '';
  let eventSha: string | undefined;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    const run = event.workflow_run;
    if (run?.event !== 'pull_request' || run?.status !== 'completed' || run?.repository?.full_name !== process.env.GITHUB_REPOSITORY) {
      throw new Error('Completion requires a completed pull-request workflow in this repository.');
    }
    eventSha = run.head_sha;
    if (!headSha) headSha = run.head_sha;
    const identified = workflowRequestNumber(run.pull_requests, pr);
    if (identified !== undefined) pr = identified;
    else {
      if (!isAutomationTargetBranch(run.head_branch ?? '')) throw new Error('The triggering head branch is unavailable.');
      const candidates = await ctx.gh.listOpenPrsByHead(repo.value, run.head_branch);
      if (!candidates.ok || candidates.value.length !== 1) throw new Error('The triggering workflow does not identify exactly one pull request.');
      pr = candidates.value[0].number;
    }
  }
  const mergeSha = process.env.SPECGIT_MERGE_SHA;
  const targetBranch = process.env.SPECGIT_TARGET_BRANCH;
  if (repo.value.platform === 'gitlab' && (mergeSha !== undefined || targetBranch !== undefined)) {
    const providers = await recordIo.readProviders(dataRoot);
    if (!providers.ok || !providers.value.gitlab) throw new Error('GitLab completion requires its declared host.');
    const { host, port } = providers.value.gitlab;
    const provider = new GlabProvider({ hostname: port ? `${host}:${port}` : host });
    const deadline = Date.now() + (options.singlePass ? 0 : 20 * 60_000);
    while (true) {
      const signal = await provider.resolveMergedPush(repo.value, mergeSha ?? '', targetBranch ?? '', Number(process.env.SPECGIT_SOURCE_PIPELINE));
      if (signal.ok) {
        if (!signal.value) return 0; // Ordinary pushes have no issue-closure action.
        pr = signal.value.pr;
        headSha = signal.value.headSha;
        break;
      }
      if (signal.code !== 'gitlab_completion_source_pending' || Date.now() >= deadline) throw new Error(signal.message);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[a-f0-9]{40}$/i.test(headSha)) {
    throw new Error('Set SPECGIT_PR and SPECGIT_HEAD to the intended request and full current head SHA.');
  }
  let gitlabCompletion: GitlabCompletionIdentity | undefined;
  if (repo.value.platform === 'gitlab') {
    if (process.env.CI_PIPELINE_SOURCE !== 'pipeline' || process.env.SPECGIT_SOURCE_PROJECT !== process.env.CI_PROJECT_ID) {
      throw new Error('GitLab completion requires an independent same-project pipeline trigger.');
    }
    gitlabCompletion = {
      projectId: Number(process.env.CI_PROJECT_ID), pipelineId: Number(process.env.CI_PIPELINE_ID),
      jobId: Number(process.env.CI_JOB_ID), sourcePipelineId: Number(process.env.SPECGIT_SOURCE_PIPELINE),
      ...(mergeSha !== undefined ? { mergeSha, targetBranch } : {}),
      pr, headSha, checkoutSha: git(dataRoot, hooks, ['rev-parse', 'HEAD']).trim(),
    };
  }
  const observed = await ctx.gh.getPr(repo.value, pr);
  if (!observed.ok) throw new Error(observed.message);
  if (eventSha !== undefined && eventSha !== observed.value.headSha &&
      !(observed.value.state === 'merged' && observed.value.mergeCommitSha === eventSha)) throw new Error('The workflow does not identify this request head or merge.');
  if (observed.value.headSha !== headSha) throw new Error('The triggering request head is stale.');
  if (!isAutomationTargetBranch(observed.value.headBranch) || !isAutomationTargetBranch(observed.value.baseBranch)) {
    throw new Error('The forge returned an unusable branch name.');
  }
  {
    // Squash merges and deleted source branches need the forge's retained
    // request ref. Fetch it as data on both platforms, then verify its SHA.
    const requestRef = `refs/specgit/requests/${pr}`;
    const sourceRef = repo.value.platform === 'gitlab' ? `refs/merge-requests/${pr}/head` : `refs/pull/${pr}/head`;
    git(dataRoot, hooks, ['fetch', '--no-tags', 'origin', `+${sourceRef}:${requestRef}`]);
    if (git(dataRoot, hooks, ['rev-parse', requestRef]).trim() !== headSha) throw new Error('The fetched MR head changed after the completion event.');
  }
  const record = DeliveryBindingSchema.parse(YAML.parse(git(dataRoot, hooks, ['show', `${headSha}:.specgit.yaml`])));
  if (!matchesBoundRequest(record, repo.value, pr) || record.context.branch !== observed.value.headBranch) throw new Error('The immutable PR-head record does not match the triggering request.');
  // A dedicated data worktree preserves branch/worktree context without ever
  // installing or running the request's code, hooks, or lifecycle scripts.
  const label = record.context.kind === 'worktree' ? record.context.label : 'delivery';
  if (!label || label === '.' || label === '..' || /[\\/\p{Cc}]/u.test(label)) throw new Error('Unsafe worktree label in delivery record.');
  const checkout = join(parent, label);
  const branch = observed.value.state === 'merged' ? observed.value.baseBranch : record.context.branch;
  if (observed.value.state === 'merged') {
    git(dataRoot, hooks, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  }
  const revision = observed.value.state === 'merged' ? `refs/remotes/origin/${branch}` : headSha;
  git(dataRoot, hooks, ['worktree', 'add', '--detach', checkout, revision]);
  git(checkout, hooks, ['checkout', '-B', branch, revision]);
  git(checkout, hooks, ['config', 'core.hooksPath', hooks]);
  process.chdir(checkout);
  const isolated = createDefaultContext({ gitlabCompletion, record: { ...recordIo, readRecord: async () => ({ ok: true, value: record }) } });
  if (gitlabCompletion !== undefined) {
    // Prove execution before any mutation, including recovery of an already
    // merged request whose issues still need to be closed.
    const execution = await isolated.gh.getPrChecks(repo.value, pr);
    if (!execution.ok) throw new Error(execution.message);
  }
  const result = await runRemoteDelivery({ repo: repo.value, pr, headSha, record }, isolated, {
    ...(options.singlePass ? { deadlineMs: 0 } : {}),
    prepareMerged: async () => {
      const base = observed.value.baseBranch;
      git(checkout, hooks, ['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
      git(checkout, hooks, ['checkout', '-B', base, `refs/remotes/origin/${base}`]);
    },
  });
  const output = presentCompletion(result);
  console.log(JSON.stringify(output));
  return output.exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  completeFromEnvironment({ singlePass: process.argv.includes('--single-pass') }).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
  });
}
