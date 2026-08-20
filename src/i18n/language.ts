/**
 * #118 — the generated-text catalog.
 *
 * `spec_git/policy.yaml`'s optional `language` key (default `en`) selects
 * the language of GENERATED text: issue/PR body scaffolding, the init
 * harness guidance, and success-path human prose. The catalog is the only
 * home of translated strings; every consumer renders through it, and the
 * English builders are byte-identical to the pre-#118 strings so an `en`
 * repository sees no output change.
 *
 * Never localized, under every language (the machine contract — pinned by
 * test/specgit-cli/language.test.ts):
 *
 * - exit codes (0/1/2/3/130) and the `--json` envelope field names;
 * - diagnostic `code` values — and, in 1.0.0, diagnostic prose
 *   (`message`/`fix`/`warnings`, gate/doctor probe lines): the evidence
 *   vocabulary stays greppable and locale-independent;
 * - the closing-reference keywords (`Closes #n`) — provider grammar, not
 *   prose;
 * - generated machine artifacts: the acceptance workflow YAML, the guard
 *   scripts, and conventional-commit messages.
 */

import type { Policy, PolicyLanguage } from '../record/policy.js';

export type { PolicyLanguage } from '../record/policy.js';

export const DEFAULT_LANGUAGE: PolicyLanguage = 'en';

/** The policy's language, or the default when absent. */
export function resolveLanguage(policy: Policy | undefined | null): PolicyLanguage {
  return policy?.language ?? DEFAULT_LANGUAGE;
}

// ---------------------------------------------------------------------------
// Scaffold text — issue bodies and draft-PR bodies.
// ---------------------------------------------------------------------------

export interface ScaffoldText {
  /** Issue body section headings. */
  issueWhy: string;
  issueScope: string;
  issueAcceptance: string;
  /** The acceptance sentence under the issue body's acceptance heading. */
  issueAcceptanceLine: string;
  /** PR scaffold section headings and hint lines (never closing refs). */
  prWhy: string;
  prWhyHint: string;
  prWhat: string;
  prWhatHint: string;
  prEvidence: string;
  prEvidenceHint: string;
  prChecklist: string;
  prChecklistFilled: string;
  prChecklistFinish: string;
}

// ---------------------------------------------------------------------------
// Human prose — success-path output lines of the commands. Builders take
// the dynamic values so identifiers (branch names, numbers, paths) pass
// through verbatim.
// ---------------------------------------------------------------------------

export interface HumanText {
  // issue
  issueHeader(resumed: boolean, delivery: string): string;
  issueBranch(branch: string): string;
  issueIssues(list: string): string;
  issuePr(pr: number | string): string;
  issueRecorded(filename: string): string;
  issuePrTitleFallback(delivery: string): string;
  // pr
  prBound(pr: number | string, delivery: string): string;
  prIssues(list: string): string;
  // bind
  bindHeader(delivery: string): string;
  bindContextWorktree(label: string, branch: string): string;
  bindContextBranch(branch: string): string;
  bindIssues(list: string): string;
  bindPr(pr: number | string): string;
  // unbind
  unbindAborted(): string;
  unbindRemoved(filename: string): string;
  // status
  statusDelivery(delivery: string, state: string): string;
  statusContextWorktree(label: string, branch: string): string;
  statusContextBranch(branch: string): string;
  statusIssues(list: string): string;
  statusIssuesNone(): string;
  statusPr(pr: number | string): string;
  statusPrNone(): string;
  statusRepository(repo: string): string;
  statusRepositoryUnresolved(): string;
  statusLiveBranch(branch: string): string;
  statusLiveBranchDetached(): string;
  // setup
  setupTool(tool: string): string;
  setupInstalled(): string;
  // init
  initCreatedPolicy(path: string): string;
  initRequiredChecks(count: number): string;
  initCheck(name: string): string;
  initPlatformGithubDefault(): string;
  initPlatformGitlab(host: string, path: string): string;
  initPlatformGithubUser(): string;
  initDetectedPlatform(platform: string): string;
  initDetectedSource(source: string): string;
  initCreatedHook(hook: string): string;
  initGitHook(hook: string): string;
  initManagedRefreshed(filename: string): string;
  initProtectionRequired(branch: string, check: string): string;
  initAutomerge(enabled: boolean): string;
  // finish / accept
  finishAccepted(delivery: string, pr: number | null): string;
  finishRejected(delivery: string): string;
  finishUnknown(delivery: string | null): string;
}

export interface LanguageCatalog {
  scaffold: ScaffoldText;
  human: HumanText;
}

const EN_SCAFFOLD: ScaffoldText = {
  issueWhy: '## Why (required)',
  issueScope: '## Scope (optional)',
  issueAcceptance: '## Acceptance (required)',
  issueAcceptanceLine:
    'The delivery pull request closes this issue; `specgit finish` must exit 0.',
  prWhy: '## Why',
  prWhyHint: 'Summarize the problem or need this delivery addresses.',
  prWhat: '## What changed',
  prWhatHint: '- Describe each meaningful change.',
  prEvidence: '## Evidence',
  prEvidenceHint: '- Point at the proof: tests, checks, verification runs.',
  prChecklist: '## Checklist',
  prChecklistFilled: '- [ ] Why, What changed, and Evidence are filled in.',
  prChecklistFinish: '- [ ] `specgit finish` exits 0.',
};

const ZH_SCAFFOLD: ScaffoldText = {
  issueWhy: '## 为什么（必填）',
  issueScope: '## 范围（选填）',
  issueAcceptance: '## 验收（必填）',
  issueAcceptanceLine: '交付拉取请求会关闭本议题；`specgit finish` 必须以退出码 0 结束。',
  prWhy: '## 为什么',
  prWhyHint: '概述本次交付要解决的问题或需求。',
  prWhat: '## 变更内容',
  prWhatHint: '- 逐条描述有意义的变更。',
  prEvidence: '## 证据',
  prEvidenceHint: '- 指向证明材料：测试、检查、验证运行。',
  prChecklist: '## 清单',
  prChecklistFilled: '- [ ] 为什么、变更内容与证据已填写。',
  prChecklistFinish: '- [ ] `specgit finish` 退出码为 0。',
};

const EN_HUMAN: HumanText = {
  issueHeader: (resumed, delivery) =>
    `${resumed ? 'Resumed' : 'Bootstrapped'} delivery '${delivery}':`,
  issueBranch: (branch) => `  Branch: ${branch}`,
  issueIssues: (list) => `  Issues: ${list}`,
  issuePr: (pr) => `  PR: #${pr} (draft)`,
  issueRecorded: (filename) => `  Recorded ${filename}, committed, pushed to origin`,
  issuePrTitleFallback: (delivery) => `Delivery ${delivery}`,
  prBound: (pr, delivery) => `Bound PR #${pr} to delivery '${delivery}':`,
  prIssues: (list) => `  Issues: ${list}`,
  bindHeader: (delivery) => `Bound delivery '${delivery}':`,
  bindContextWorktree: (label, branch) => `Context: worktree ${label} on ${branch}`,
  bindContextBranch: (branch) => `Context: branch ${branch}`,
  bindIssues: (list) => `  Issues: ${list}`,
  bindPr: (pr) => `  PR: ${pr}`,
  unbindAborted: () => 'Unbind aborted; record kept.',
  unbindRemoved: (filename) => `Removed ${filename}.`,
  statusDelivery: (delivery, state) => `Delivery: ${delivery} (${state})`,
  statusContextWorktree: (label, branch) => `Context: worktree ${label} on ${branch}`,
  statusContextBranch: (branch) => `Context: branch ${branch}`,
  statusIssues: (list) => `Issues: ${list}`,
  statusIssuesNone: () => 'Issues: (none)',
  statusPr: (pr) => `PR: ${pr}`,
  statusPrNone: () => 'PR: (none)',
  statusRepository: (repo) => `Repository: ${repo}`,
  statusRepositoryUnresolved: () => 'Repository: (unresolved)',
  statusLiveBranch: (branch) => `Live branch: ${branch}`,
  statusLiveBranchDetached: () => 'Live branch: (detached)',
  setupTool: (tool) => `Tool: ${tool}`,
  setupInstalled: () => 'Installed entry points:',
  initCreatedPolicy: (path) => `Created ${path}`,
  initRequiredChecks: (count) => `Required checks (${count}):`,
  initCheck: (name) => `  - ${name}`,
  initPlatformGithubDefault: () => 'Platform: github (default from origin)',
  initPlatformGitlab: (host, path) => `Platform: gitlab (${host}) declared in ${path}`,
  initPlatformGithubUser: () => 'Platform: github (user-selected)',
  initDetectedPlatform: (platform) => `Detected platform: ${platform}`,
  initDetectedSource: (source) => `  detected from ${source}`,
  initCreatedHook: (hook) => `Created ${hook}`,
  initGitHook: (hook) => `Installed git pre-push guard (${hook})`,
  initManagedRefreshed: (filename) => `Managed block refreshed in ${filename}`,
  initProtectionRequired: (branch, check) =>
    `Branch protection: ${branch} now requires "${check}"`,
  initAutomerge: (enabled) => `Auto-merge: ${enabled ? 'enabled' : 'already on'}`,
  finishAccepted: (delivery, pr) =>
    `Accepted: delivery '${delivery}'${pr !== null ? ` (PR ${pr})` : ''}.`,
  finishRejected: (delivery) => `Rejected: delivery '${delivery}' failed acceptance.`,
  finishUnknown: (delivery) =>
    `Cannot determine acceptance${delivery !== null ? ` for delivery '${delivery}'` : ''}.`,
};

const ZH_HUMAN: HumanText = {
  issueHeader: (resumed, delivery) => `${resumed ? '已恢复交付' : '已引导交付'} '${delivery}'：`,
  issueBranch: (branch) => `  分支：${branch}`,
  issueIssues: (list) => `  议题：${list}`,
  issuePr: (pr) => `  PR：#${pr}（草稿）`,
  issueRecorded: (filename) => `  已记录 ${filename}，已提交并推送到 origin`,
  issuePrTitleFallback: (delivery) => `交付 ${delivery}`,
  prBound: (pr, delivery) => `已将 PR #${pr} 绑定到交付 '${delivery}'：`,
  prIssues: (list) => `  议题：${list}`,
  bindHeader: (delivery) => `已绑定交付 '${delivery}'：`,
  bindContextWorktree: (label, branch) => `上下文：工作树 ${label}，分支 ${branch}`,
  bindContextBranch: (branch) => `上下文：分支 ${branch}`,
  bindIssues: (list) => `  议题：${list}`,
  bindPr: (pr) => `  PR：${pr}`,
  unbindAborted: () => '已取消解绑；记录保留。',
  unbindRemoved: (filename) => `已移除 ${filename}。`,
  statusDelivery: (delivery, state) => `交付：${delivery}（${state}）`,
  statusContextWorktree: (label, branch) => `上下文：工作树 ${label}，分支 ${branch}`,
  statusContextBranch: (branch) => `上下文：分支 ${branch}`,
  statusIssues: (list) => `议题：${list}`,
  statusIssuesNone: () => '议题：（无）',
  statusPr: (pr) => `PR：${pr}`,
  statusPrNone: () => 'PR：（无）',
  statusRepository: (repo) => `仓库：${repo}`,
  statusRepositoryUnresolved: () => '仓库：（未解析）',
  statusLiveBranch: (branch) => `当前分支：${branch}`,
  statusLiveBranchDetached: () => '当前分支：（分离头指针）',
  setupTool: (tool) => `工具：${tool}`,
  setupInstalled: () => '已安装入口：',
  initCreatedPolicy: (path) => `已创建 ${path}`,
  initRequiredChecks: (count) => `必需检查（${count}）：`,
  initCheck: (name) => `  - ${name}`,
  initPlatformGithubDefault: () => '平台：github（默认来自 origin）',
  initPlatformGitlab: (host, path) => `平台：gitlab（${host}）已声明于 ${path}`,
  initPlatformGithubUser: () => '平台：github（用户选择）',
  initDetectedPlatform: (platform) => `检测到平台：${platform}`,
  initDetectedSource: (source) => `  检测来源 ${source}`,
  initCreatedHook: (hook) => `已创建 ${hook}`,
  initGitHook: (hook) => `已安装 git pre-push 守卫（${hook}）`,
  initManagedRefreshed: (filename) => `已在 ${filename} 中刷新托管块`,
  initProtectionRequired: (branch, check) => `分支保护：${branch} 现在要求 "${check}"`,
  initAutomerge: (enabled) => `自动合并：${enabled ? '已启用' : '已开启'}`,
  finishAccepted: (delivery, pr) =>
    `已接受：交付 '${delivery}'${pr !== null ? `（PR ${pr}）` : ''}。`,
  finishRejected: (delivery) => `已拒绝：交付 '${delivery}' 未通过验收。`,
  finishUnknown: (delivery) =>
    `无法判定验收${delivery !== null ? `（交付 '${delivery}'）` : ''}。`,
};

const CATALOGS: Record<PolicyLanguage, LanguageCatalog> = {
  en: { scaffold: EN_SCAFFOLD, human: EN_HUMAN },
  zh: { scaffold: ZH_SCAFFOLD, human: ZH_HUMAN },
};

/** The generated-text catalog for a language. Unknown keys never reach here (strict policy schema). */
export function catalogFor(language: PolicyLanguage = DEFAULT_LANGUAGE): LanguageCatalog {
  return CATALOGS[language] ?? CATALOGS[DEFAULT_LANGUAGE];
}
