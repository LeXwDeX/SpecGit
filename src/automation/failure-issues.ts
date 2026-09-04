import { createHash } from 'node:crypto';
import type { ForgeProvider, PrFact } from '../github/port.js';
import type { RepoRef } from '../gitfacts/origin.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { Policy } from '../record/policy.js';
import { checkLabelConvention, checkTitleConvention } from '../record/conventions.js';
import { checkBodyConvention, renderDeliveryTemplate } from '../record/templates.js';
import { DEFAULT_TAG_CATALOG, fallbackColorFor } from '../tags/catalog.js';

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
  issueNumbers: number[];
  failures: DeliveryFailure[];
  policy: Policy;
}

const NON_FAILURES = new Set([
  'pr_draft', 'automation_checks_pending', 'checks_pending', 'automation_head_changed',
  'automation_disabled', 'automation_checks_missing', 'evidence_truncated',
]);

/** A failed delivery gets new repair work; repeated observations reconcile it through the tracker. */
export async function ensureFailureIssues(
  input: FailureIssueInput,
  forge: ForgeProvider,
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
    const identity = failure.target ? `${failure.code}\0${failure.target}` : failure.code;
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 20);
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
    const rendered = renderDeliveryTemplate(input.policy, 'issue', { title, body, issues: input.issueNumbers });
    if (!rendered.ok) return rendered;
    for (const checked of [checkTitleConvention(input.policy, rendered.value.title), checkBodyConvention(input.policy, 'issue', rendered.value.body)]) {
      if (!checked.ok) return checked;
    }
    const repairBody = rendered.value.body.includes(marker) ? rendered.value.body : `${marker}\n${rendered.value.body}`;
    const matches = pool.value.filter((issue) => issue.body?.split('\n').some((line) => line.trim() === marker));
    if (matches.length > 1) return fail('repair_issue_ambiguous', `Several open issues track failure ${failure.code} for PR ${input.pr.number}.`,
      'Resolve the duplicate repair issues before retrying.');
    let number = matches[0]?.number;
    if (number === undefined) {
      const created = await forge.createIssue(input.repo, rendered.value.title, repairBody);
      if (!created.ok) return created;
      number = created.value.number;
      pool.value.push({ number, title: rendered.value.title, body: repairBody });
    }
    const applied = await forge.addIssueLabels(input.repo, number, labels);
    if (!applied.ok) return applied;
    if (!labels.every((label) => applied.value.names.includes(label))) return fail('repair_labels_unconfirmed', 'The repair labels were not confirmed by the forge.');
    const comment = await forge.addIssueComment(input.repo, number, `${marker}\n${evidence}`);
    if (!comment.ok) return comment;
    numbers.push(number);
  }
  return ok({ issues: numbers });
}
