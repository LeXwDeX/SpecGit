import type { ForgeEvidencePort, ForgeDeliveryWritePort, ForgeAdminWritePort, PrFact } from '../github/port.js';
import type { RepoRef } from '../gitfacts/origin.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { Policy } from '../record/policy.js';
import { checkLabelConvention, checkTitleConvention } from '../record/conventions.js';
import { checkBodyConvention, renderDeliveryTemplate } from '../record/templates.js';
import { DEFAULT_TAG_CATALOG, fallbackColorFor } from '../tags/catalog.js';
import { recordRepairIntent, recordRepairCreation, repairPolicyHash, findRepairCandidate, repairCauseKey } from './repair-log.js';

export interface DeliveryFailure {
  code: string;
  message: string;
  /** Stable cause scope, such as the provider and CI check identity. */
  target?: string;
  evidenceUrl?: string;
}

export interface FailureIssueInput {
  repo: RepoRef;
  pr: PrFact;
  delivery: string;
  issueNumbers: number[];
  failures: DeliveryFailure[];
  policy: Policy;
}

const NON_FAILURES = new Set([
  'pr_draft', 'automation_checks_pending', 'checks_pending', 'automation_head_changed',
  'automation_disabled', 'automation_checks_missing', 'evidence_truncated',
]);

/** The tracker capabilities needed to reconcile repair issues; no merge or protection writes. */
export type FailureIssuePort =
  Pick<ForgeEvidencePort, 'getIssueWriterAuthority' | 'getPr' | 'getIssue' | 'getOpenIssues' | 'searchIssueHistory' | 'getRequestDeclarations'> &
  Pick<ForgeDeliveryWritePort, 'createIssue' | 'addIssueLabels' | 'addIssueComment' | 'appendRequestDeclaration'> &
  Pick<ForgeAdminWritePort, 'ensureRepoLabels'>;

/** A failed delivery gets new repair work; repeated observations reconcile it through the tracker. */
export async function ensureFailureIssues(
  input: FailureIssueInput,
  forge: FailureIssuePort,
): Promise<Evidence<{ issues: number[] }>> {
  const failures = [...new Map(input.failures
    .filter((item) => item.code.trim() !== '' && !NON_FAILURES.has(item.code))
    .map((item) => [`${item.code}\0${item.target ?? ''}`, item])).values()];
  if (input.pr.draft || input.pr.state !== 'open' || failures.length === 0) return ok({ issues: [] });
  const current = await forge.getPr(input.repo, input.pr.number);
  if (!current.ok) return current;
  if (current.value.headSha !== input.pr.headSha || current.value.state !== 'open' || current.value.draft) {
    return fail('failure_head_changed', 'The failed PR/MR is no longer the observed open, ready head.',
      'Re-read the current request and its checks before recording a repair issue.');
  }
  const declared = input.policy.tags ?? [];
  const labels = input.policy.automation?.repair_labels ??
    (checkLabelConvention(input.policy, ['kind::fix']).ok ? ['kind::fix'] :
      declared.length === 1 ? [declared[0].name] : []);
  const validLabels = checkLabelConvention(input.policy, labels);
  if (!validLabels.ok) {
    return fail('repair_label_required', 'Choose repair issue labels from the configured project vocabulary.',
      'Run specgit init --force --repair-label <label> (repeatable) to save the repair label selection.');
  }
  const pool = await forge.getOpenIssues(input.repo);
  if (!pool.ok) return pool;
  const specs = labels.map((name) => ({ name,
    color: declared.find((tag) => tag.name === name)?.color ??
      DEFAULT_TAG_CATALOG.find((tag) => tag.name === name)?.color ?? fallbackColorFor(name),
  }));
  const seeded = await forge.ensureRepoLabels(input.repo, specs);
  if (!seeded.ok) return seeded;
  if (!labels.every((name) => seeded.value.names.includes(name))) return fail('repair_label_unavailable', 'The forge did not confirm the selected repair labels.');
  const numbers: number[] = [];
  const zh = input.policy.language === 'zh';
  const request = `${input.repo.platform === 'gitlab' ? '!' : '#'}${input.pr.number}`;
  for (const failure of failures) {
    const key = repairCauseKey(failure);
    const marker = `<!-- specgit:failure:${input.pr.number}:${key} -->`;
    const kind = `${failure.code}${failure.target ? `-${failure.target}` : ''}`.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || key;
    const title = zh ? `fix: 修复 PR ${input.pr.number} 的 ${kind}` : `fix: repair ${kind} in PR ${input.pr.number}`;
    const validTitle = checkTitleConvention(input.policy, title);
    if (!validTitle.ok) return validTitle;
    const evidence = [
      `${zh ? '关联 PR' : 'Related PR'}: ${request}`,
      `${zh ? '原需求' : 'Original issues'}: ${input.issueNumbers.map((n) => `#${n}`).join(', ')}`,
      `${zh ? '失败提交' : 'Failed head'}: ${input.pr.headSha}`,
      `${zh ? '失败原因' : 'Failure cause'}: ${failure.code}`,
      ...(failure.target ? [`${zh ? '失败对象' : 'Failure target'}: ${failure.target}`] : []),
      ...failure.message.split('\n').map((line) => `> ${line}`),
      ...(failure.evidenceUrl ? [`${zh ? '证据' : 'Evidence'}: ${failure.evidenceUrl}`] : []),
    ].join('\n');
    const body = [marker, '', zh ? '## 原因' : '## Why', evidence, '',
      zh ? '## 范围' : '## Scope',
      zh ? '修复本条失败原因，保留原需求的验收条件。' : 'Repair this failure cause while preserving the original business acceptance criteria.', '',
      zh ? '## 方案' : '## Approach',
      zh ? '复现失败，完成修复与评审，通过当前提交的适用检查。' : 'Reproduce the failure, implement and review the repair, and verify all applicable checks at the current head.', '',
      zh ? '## 验收' : '## Acceptance',
      zh ? '- 修复有可重复的验证证据。\n- 交付合并到配置目标，绑定的 Issue 经核验全部关闭。' : '- The repair has reproducible verification evidence.\n- The delivery is merged into the configured target and all bound issues are confirmed closed.', '',
    ].join('\n');
    const rendered = renderDeliveryTemplate(input.policy, 'issue', {
      title, body, delivery: input.delivery, issues: input.issueNumbers,
    });
    if (!rendered.ok) return rendered;
    for (const checked of [checkTitleConvention(input.policy, rendered.value.title), checkBodyConvention(input.policy, 'issue', rendered.value.body)]) {
      if (!checked.ok) return checked;
    }
    const repairBody = rendered.value.body.includes(marker) ? rendered.value.body : `${marker}\n${rendered.value.body}`;
    const intent = await recordRepairIntent(input.repo, {
      request: input.pr.number, headSha: input.pr.headSha.toLowerCase(),
      policyHash: repairPolicyHash(input.policy),
      cause: { code: failure.code, ...(failure.target ? { target: failure.target } : {}) },
      title: rendered.value.title, body: repairBody, labels,
    }, forge);
    if (!intent.ok) return intent;
    const operationMarker = `<!-- specgit:repair-operation:${intent.value.key} -->`;
    const candidate = await findRepairCandidate(input.repo, intent.value, forge, pool.value);
    if (!candidate.ok) return candidate;
    let number = candidate.value;
    if (number === undefined) {
      const bodyWithOperation = `${operationMarker}\n${intent.value.body}`;
      const created = await forge.createIssue(input.repo, intent.value.title, bodyWithOperation);
      if (!created.ok) return created;
      number = created.value.number;
      pool.value.push({ number, title: intent.value.title, body: bodyWithOperation });
    }
    const issue = await forge.getIssue(input.repo, number);
    if (!issue.ok) return issue;
    if (issue.value.number !== number || issue.value.pullRequest) return fail('repair_issue_mismatch', 'The repair did not resolve to the intended issue.');
    const receipt = await recordRepairCreation(input.repo, input.pr.number, intent.value.key, number, forge);
    if (!receipt.ok) return receipt;
    const applied = await forge.addIssueLabels(input.repo, number, labels);
    if (!applied.ok) return applied;
    if (!labels.every((label) => applied.value.names.includes(label))) return fail('repair_labels_unconfirmed', 'The repair labels were not confirmed by the forge.');
    const comment = await forge.addIssueComment(input.repo, number, `${marker}\n${evidence}`);
    if (!comment.ok) return comment;
    numbers.push(number);
  }
  return ok({ issues: numbers });
}
