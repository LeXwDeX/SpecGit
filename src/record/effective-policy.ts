import YAML from 'yaml';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { GitPort } from '../gitfacts/port.js';
import { parsePrUrl, sameRepoRef, type RepoRef } from '../gitfacts/origin.js';
import type { ForgeProvider } from '../github/port.js';
import type { DeliveryBinding } from './schema.js';
import { PolicySchema, type Policy } from './policy.js';

export interface EffectivePolicy {
  policy: Policy;
  source: 'approved' | 'adoption';
  branch: string;
  sha: string;
}

/** A proposed policy cannot authorize its own acceptance or its own merge. */
export async function resolveEffectivePolicy(options: {
  root: string;
  record: Evidence<DeliveryBinding>;
  git: Pick<GitPort, 'facts' | 'remoteDefaultBranch' | 'readFileAtRemoteRef' | 'readFileBeforeMerge'>;
  forge: Pick<ForgeProvider, 'getPr'>;
  parseRepoRef: (origin: string) => Evidence<RepoRef> | Promise<Evidence<RepoRef>>;
  readCandidate: () => Promise<Evidence<Policy>>;
  requireApproved?: boolean;
}): Promise<Evidence<EffectivePolicy>> {
  const { root, record, git, forge } = options;
  const facts = await git.facts(root);
  if (!facts.originUrl) return fail('no_origin', 'No origin remote is configured.');
  const repo = await options.parseRepoRef(facts.originUrl);
  if (!repo.ok) return repo;
  let branch: string;
  let merged: { mergeSha: string; headSha: string } | undefined;
  if (record.ok && record.value.pr !== undefined) {
    if (typeof record.value.pr === 'string') {
      const reference = parsePrUrl(record.value.pr);
      if (reference.ok && !sameRepoRef(reference.value.repo, repo.value)) {
        return fail('pr_repo_mismatch', 'The bound pull request belongs to a different repository.');
      }
    }
    const pr = await forge.getPr(repo.value, record.value.pr);
    if (!pr.ok) return pr;
    branch = pr.value.baseBranch;
    if (options.requireApproved && pr.value.state === 'merged') {
      if (!pr.value.mergeCommitSha) return fail('policy_history_unavailable', 'The merged request has no result commit proving its original authorization.');
      merged = { mergeSha: pr.value.mergeCommitSha, headSha: pr.value.headSha };
    }
  } else {
    const defaultBranch = await git.remoteDefaultBranch(root, { requireEvidence: true });
    if (!defaultBranch.ok) return defaultBranch;
    branch = defaultBranch.value;
  }
  const approved = merged
    ? await git.readFileBeforeMerge(root, merged.mergeSha, merged.headSha, 'spec_git/policy.yaml')
    : await git.readFileAtRemoteRef(root, branch, 'spec_git/policy.yaml');
  if (!approved.ok) return approved;
  if (approved.value.content === null) {
    if (options.requireApproved) return fail('policy_approval_required', 'Automatic merge requires a policy already approved on the target branch.');
    const candidate = await options.readCandidate();
    return candidate.ok ? ok({ policy: candidate.value, source: 'adoption', branch, sha: approved.value.sha }) : candidate;
  }
  try {
    const parsed = PolicySchema.safeParse(YAML.parse(approved.value.content));
    if (!parsed.success) return fail('policy_invalid', `The approved policy at ${approved.value.sha} failed schema validation.`);
    return ok({ policy: parsed.data, source: 'approved', branch, sha: approved.value.sha });
  } catch {
    return fail('policy_invalid', `The approved policy at ${approved.value.sha} is not valid YAML.`);
  }
}
