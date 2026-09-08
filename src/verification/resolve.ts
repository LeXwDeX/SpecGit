import { createHash } from 'node:crypto';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { GitPort } from '../gitfacts/port.js';
import type { PrFact } from '../github/port.js';
import type { Policy } from '../record/policy.js';
import { selectVerification, type VerificationSelection } from './select.js';
import type { EffectivePolicy } from '../record/effective-policy.js';
import type { DeliveryBinding } from '../record/schema.js';
import type { ForgeEvidencePort } from '../github/port.js';
import type { RepoRef } from '../gitfacts/origin.js';

export interface VerificationDecision extends VerificationSelection {
  kind: 'fixed' | 'applicable';
  policySha: string | null;
  policyHash: string;
  headSha: string;
  ciEntry?: string;
  baseSha?: string;
  mergeBaseSha?: string;
}

export type VerificationGit = Pick<GitPort, 'changesBetween' | 'readFileAtCommit'>;

/** Shared read-only composition for CI planning and the workflow waiter. */
export async function planBoundVerification(input: {
  root: string;
  record: Evidence<DeliveryBinding>;
  resolution: Evidence<EffectivePolicy>;
  git: VerificationGit & Pick<GitPort, 'facts'>;
  forge: Pick<ForgeEvidencePort, 'getPr' | 'getCiConfigPath'>;
  parseRepoRef: (origin: string) => Evidence<RepoRef> | Promise<Evidence<RepoRef>>;
}): Promise<Evidence<VerificationDecision>> {
  if (!input.record.ok) return input.record;
  if (!input.resolution.ok) return input.resolution;
  if (input.record.value.pr === undefined) return fail('pr_missing', 'Bind the request before planning its checks.');
  const facts = await input.git.facts(input.root);
  if (!facts.originUrl) return fail('no_origin', 'No origin remote is configured.');
  const repo = await input.parseRepoRef(facts.originUrl);
  if (!repo.ok) return repo;
  const request = await input.forge.getPr(repo.value, input.record.value.pr);
  if (!request.ok) return request;
  if (request.value.state !== 'merged' && request.value.headSha !== facts.headSha) {
    return fail('verification_changes_unavailable', 'The checkout does not match the request head.', 'Check out the request head before wiring its verification jobs.');
  }
  if (request.value.baseBranch !== input.resolution.value.branch) {
    return fail('verification_changes_unavailable', 'The request target changed during verification planning.');
  }
  return resolveVerification({ root: input.root, policy: input.resolution.value.policy, policySha: input.resolution.value.sha, request: request.value, git: input.git, repo: repo.value, forge: input.forge });
}

/** Approved entry declarations remain stable when later platform settings change. */
export async function verifyCiEntry(input: {
  policy: Policy; request: PrFact; repo: RepoRef;
  forge: Pick<ForgeEvidencePort, 'getCiConfigPath'>;
}): Promise<Evidence<string | null>> {
  if (!input.policy.verification || input.repo.platform !== 'gitlab') return ok(null);
  const expected = input.policy.verification.gitlab_entry ?? '.gitlab-ci.yml';
  if (input.request.state === 'merged') return ok(expected);
  const configured = await input.forge.getCiConfigPath(input.repo);
  if (!configured.ok) return configured;
  if ((configured.value || '.gitlab-ci.yml') !== expected) {
    return fail('verification_changes_unavailable', 'The GitLab CI entry does not match the approved verification declaration.',
      'Review verification.gitlab_entry and the project CI setting together; external entry references cannot receive path exemptions.');
  }
  return ok(expected);
}

/** The supplied revision is the live approved target, or the original target for a merged request. */
export async function resolveVerification(input: {
  root: string;
  policy: Policy;
  policySha?: string;
  request: PrFact;
  repo: RepoRef;
  forge: Pick<ForgeEvidencePort, 'getCiConfigPath'>;
  git: Partial<VerificationGit>;
}): Promise<Evidence<VerificationDecision>> {
  const { policy, request } = input;
  const identity = { policySha: input.policySha ?? null, policyHash: createHash('sha256').update(JSON.stringify(policy)).digest('hex'), headSha: request.headSha };
  if (!policy.verification) return ok({ kind: 'fixed', ...identity, ...selectVerification(policy, []) });
  const unavailable = () => fail<VerificationDecision>('verification_changes_unavailable',
    'Verification selection requires matching immutable policy, target and request-head evidence.',
    'Fetch the approved target and request head, then retry the verification decision.');
  if (!input.policySha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.policySha)) return unavailable();
  if (!input.git.changesBetween || !input.git.readFileAtCommit) return unavailable();
  const entry = await verifyCiEntry(input);
  if (!entry.ok) return entry;
  const changes = await input.git.changesBetween(input.root, input.policySha, request.headSha);
  if (!changes.ok) return changes;
  if (changes.value.baseSha !== input.policySha || changes.value.headSha !== request.headSha) return unavailable();
  let binding: { before: string | null; after: string | null } | undefined;
  if (changes.value.changes.some((change) => change.path === '.specgit.yaml')) {
    const before = await input.git.readFileAtCommit(input.root, changes.value.mergeBaseSha, '.specgit.yaml');
    if (!before.ok) return before;
    const after = await input.git.readFileAtCommit(input.root, request.headSha, '.specgit.yaml');
    if (!after.ok) return after;
    if (before.value.sha !== changes.value.mergeBaseSha || after.value.sha !== request.headSha) return unavailable();
    binding = { before: before.value.content, after: after.value.content };
  }
  return ok({ kind: 'applicable', ...identity, ...(entry.value ? { ciEntry: entry.value } : {}),
    baseSha: changes.value.baseSha, mergeBaseSha: changes.value.mergeBaseSha,
    ...selectVerification(policy, changes.value.changes, binding) });
}
