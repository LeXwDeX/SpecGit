import type { ForgeProvider } from '../github/port.js';
import type { GitPort } from '../gitfacts/port.js';
import type { RepoRef } from '../gitfacts/origin.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { Policy } from '../record/policy.js';
import { readRepairLog, recordRepairCreation, repairPolicyHash, findRepairCandidate } from './repair-log.js';

type RecoveryPort = Pick<ForgeProvider, 'getOpenIssues' | 'getIssueWriterAuthority' | 'getRequestDeclarations' | 'appendRequestDeclaration' | 'searchIssueHistory' | 'createIssue' | 'getIssue' | 'addIssueLabels'>;

/** Resume confirmed intents before acceptance; request-head files are never changed. */
export async function recoverRepairCreations(input: {
  repo: RepoRef; request: number; headSha: string; root: string; policy: Policy; boundIssues: number[];
}, forge: RecoveryPort, git: Pick<GitPort, 'isAncestor'>): Promise<Evidence<void>> {
  if (input.policy.automation?.merge !== true && input.policy.automation?.close_issues !== true) {
    return fail('automation_disabled', 'Repair recovery requires enabled delivery automation.');
  }
  const log = await readRepairLog(input.repo, input.request, forge);
  if (!log.ok) return log;
  for (const operation of log.value) {
    if (operation.issue !== undefined && input.boundIssues.includes(operation.issue)) continue;
    const authorized = async (): Promise<Evidence<void>> => {
      if (operation.policyHash !== repairPolicyHash(input.policy)) {
        return fail('repair_resolution_unproven', 'The recorded repair policy has changed; restore its evidence or explicitly adopt the created repair.');
      }
      const lineage = await git.isAncestor(input.root, operation.headSha, input.headSha);
      if (!lineage.ok) return lineage;
      return lineage.value.contained ? ok(undefined) : fail('repair_resolution_unproven', 'The request head does not contain the recorded failed head.');
    };
    const marker = `<!-- specgit:repair-operation:${operation.key} -->`;
    let number = operation.issue;
    if (number === undefined) {
      const candidate = await findRepairCandidate(input.repo, operation, forge);
      if (!candidate.ok) return candidate;
      number = candidate.value;
      if (number === undefined) {
        const permission = await authorized();
        if (!permission.ok) return permission;
        const created = await forge.createIssue(input.repo, operation.title, `${marker}\n${operation.body}`);
        if (!created.ok) return created;
        number = created.value.number;
      }
    }
    const issue = await forge.getIssue(input.repo, number);
    if (!issue.ok) return issue;
    if (issue.value.number !== number || issue.value.pullRequest) return fail('repair_issue_mismatch', 'The recorded repair is not the intended issue.');
    if (operation.issue === undefined) {
      const receipt = await recordRepairCreation(input.repo, input.request, operation.key, number, forge);
      if (!receipt.ok) return receipt;
    }
    // Record materialized work even if its original resolution evidence changed.
    // Label repair is a separate write under the original authorization.
    if (issue.value.state === 'open' && (await authorized()).ok) {
      const labels = await forge.addIssueLabels(input.repo, number, operation.labels);
      if (!labels.ok) return labels;
      if (!operation.labels.every((label) => labels.value.names.includes(label))) return fail('repair_labels_unconfirmed', 'The recorded repair labels remain unconfirmed.');
    }
  }
  return ok(undefined);
}
