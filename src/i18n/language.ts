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
  issueApproach: string;
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
  /**
   * #330: the tag summary line — what was applied to every bound issue,
   * and which of those names were newly seeded into the pool.
   */
  issueTags(applied: string, seeded: string | null): string;
  /** #330: off-spec labels found in the pool — reported, never rewritten. */
  tagPoolWarning(sample: string, count: number): string;
  /** #330: best-effort mode could not read the pool; nothing was tagged. */
  tagProbeWarning(): string;
  issuePrTitleFallback(delivery: string): string;
  issueTraceabilityComment(branch: string, pr: number | string): string;
  // issue — delivery-name prompt (#246)
  deliveryNamePrompt(): string;
  deliveryNameRetry(): string;
  // pr
  prBound(pr: number | string, delivery: string): string;
  prIssues(list: string): string;
  automationCompleted(pr: number, target: string): string;
  automationHandoffReason(): string;
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
  statusUnbound(): string;
  // status — merged-history candidate (#351); branch interpolates verbatim
  statusHistoricalCandidate(branch: string): string;
  // status — generated-asset drift (#308); states/codes/paths/fix commands
  // interpolate verbatim (machine contract, never localized)
  statusAssetsCurrent(): string;
  statusAssetsDrift(): string;
  statusAssetsIncomplete(): string;
  statusAssetSurface(surface: string, state: string, fix: string): string;
  statusAssetEntry(state: string, path: string): string;
  statusAssetUninspected(code: string): string;
  statusAssetSkipped(code: string): string;
  // setup
  setupTool(tool: string): string;
  setupInstalled(): string;
  setupRemovedAsset(path: string): string;
  setupPreservedAsset(path: string): string;
  // init
  initCreatedPolicy(path: string): string;
  initIgnoredAssets(path: string): string;
  /** #310: the upgrade run kept the existing policy's checks. */
  initPreservedChecks(): string;
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
  initRemovedAsset(path: string): string;
  initPreservedAsset(path: string): string;
  initProtectionRequired(branch: string, check: string): string;
  // init — adoption hand-off (#352); the reasons localize keyed by the
  // verbatim step code, so no positional coupling to the command list.
  // gitlab drops the protect step.
  initNextAdoptionHeadline(): string;
  initAdoptionReasons(gitlab: boolean): Record<string, string>;
  // generic nextActions headline (#360/#361)
  nextHeadline(): string;
  // issue success hand-off reasons (#361), keyed by step code
  issueHandoffReasons(): Record<string, string>;
  // finish accepted hand-off reasons (#361), keyed by step code
  finishHandoffReasons(): Record<string, string>;
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
  issueWhy: '## Why',
  issueScope: '## Scope',
  issueApproach: '## Approach',
  issueAcceptance: '## Acceptance',
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
  issueWhy: '## 为什么',
  issueScope: '## 范围',
  issueApproach: '## 方法',
  issueAcceptance: '## 验收',
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
  issueTags: (applied, seeded) =>
    `  Tags: ${applied}${seeded === null ? '' : ` (seeded: ${seeded})`}`,
  tagPoolWarning: (sample, count) =>
    `  Warning: ${count} repository label(s) are outside the tag grammar and were left untouched: ${sample}`,
  tagProbeWarning: () =>
    '  Warning: the repository label pool could not be read; no tags were applied this run.',
  issuePrTitleFallback: (delivery) => `Delivery ${delivery}`,
  issueTraceabilityComment: (branch, pr) =>
    `SpecGit delivery branch: \`${branch}\` (draft pull request #${pr}).`,
  deliveryNamePrompt: () =>
    'Enter a delivery name (kebab-case ASCII, e.g. add-login): ',
  deliveryNameRetry: () =>
    'Not a valid kebab-case name — try again (e.g. add-login): ',
  prBound: (pr, delivery) => `Bound PR #${pr} to delivery '${delivery}':`,
  prIssues: (list) => `  Issues: ${list}`,
  automationCompleted: (pr, target) => `Merged #${pr} into ${target}; configured issue closure is complete.`,
  automationHandoffReason: () => 'Verify all CI/CD on the current head, merge into the configured target, and complete configured issue closure.',
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
  statusUnbound: () =>
    'Not bound: no delivery record (.specgit.yaml) exists yet — the normal pre-binding state. Run "specgit issue" to start a delivery.',
  statusHistoricalCandidate: (branch) =>
    `Completed-history candidate: the record names branch '${branch}' while this checkout tracks it — likely a merged delivery. Confirm with "specgit finish", or start the next delivery: "specgit issue" replaces the record.`,
  statusAssetsCurrent: () =>
    'Generated assets: current — every desired init/setup output is proven current, absent, or intentionally skipped for this CLI version.',
  statusAssetsDrift: () => 'Generated assets: drift detected — run each surface\'s exact fix:',
  statusAssetsIncomplete: () =>
    'Generated assets: incomplete — parts of the desired state could not be proven, so no current claim is made:',
  statusAssetSurface: (surface, state, fix) => `  ${surface}: ${state} — fix: ${fix}`,
  statusAssetEntry: (state, path) => `    ${state} ${path}`,
  statusAssetUninspected: (code) => `  not inspected (${code})`,
  statusAssetSkipped: (code) => `  not applicable (${code}) — a proven opt-out, not drift`,
  setupTool: (tool) => `Tool: ${tool}`,
  setupInstalled: () => 'Installed entry points:',
  setupRemovedAsset: (path) => `Removed retired SpecGit entry point ${path}`,
  setupPreservedAsset: (path) => `Preserved ${path} (not provably SpecGit-owned; left untouched)`,
  initCreatedPolicy: (path) => `Created ${path}`,
  initIgnoredAssets: (path) => `Added local delivery assets to ${path} (untracked model; --no-ignore to keep them committed)`,
  initPreservedChecks: () =>
    'Preserved the required checks from the existing policy (pass --required-check to replace them)',
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
  initRemovedAsset: (path) => `Removed obsolete SpecGit asset ${path}`,
  initPreservedAsset: (path) => `Preserved ${path} (not provably SpecGit-owned; left untouched)`,
  initProtectionRequired: (branch, check) =>
    `Branch protection: ${branch} now requires "${check}"`,
  initNextAdoptionHeadline: () =>
    'Next: the adoption is not on the default branch yet — finish it before requiring checks:',
  nextHeadline: () => 'Next:',
  issueHandoffReasons: () =>
    ({
      issue_bodies:
        'Fill every issue body (Why / Scope / Approach / Acceptance) — the scaffold body is advisory, the WHY is the contract.',
      pr_brief:
        'Fill the PR brief sections (Why / What changed / Evidence); keep the Closes #n lines intact.',
      pr_ready: 'A draft always fails the verdict; ready makes the delivery reviewable.',
    }) as Record<string, string>,
  finishHandoffReasons: () =>
    ({
      delivery_merge:
        'The verdict is green. Auto-merge fires only when every required check — this verdict among them — passes.',
      next_delivery:
        'This record is completed history — the next bootstrap atomically replaces it.',
    }) as Record<string, string>,
  initAdoptionReasons: (gitlab) =>
    ({
      adoption_branch:
        'Carry the harness and policy to the default branch through a pull request, not a direct push.',
      adoption_commit:
        'The policy is shielded by .gitignore by default — a plain "git add" silently skips it; the -f is required.',
      adoption_pr: gitlab
        ? 'Merge the adoption MR so your CI jobs exist on the default branch.'
        : 'Merge the adoption PR so the acceptance check exists on the default branch.',
      ...(gitlab
        ? {}
        : {
            adoption_protect:
              'Only now is requiring the acceptance check safe: PRs can pass it because the workflow is on the default branch.',
          }),
      adoption_setup:
        'Optional: install the agent entry points, then check the environment and the snapshot.',
    }) as Record<string, string>,
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
  issueTags: (applied, seeded) =>
    `  标签：${applied}${seeded === null ? '' : `（新建：${seeded}）`}`,
  tagPoolWarning: (sample, count) =>
    `  警告：仓库中有 ${count} 个标签不符合标签语法，已保持原样不动：${sample}`,
  tagProbeWarning: () => '  警告：无法读取仓库标签池；本次运行未应用任何标签。',
  issuePrTitleFallback: (delivery) => `交付 ${delivery}`,
  deliveryNamePrompt: () => '请输入交付名（kebab-case ASCII，例如 add-login）：',
  deliveryNameRetry: () => '不是有效的 kebab-case 名称——请重试（例如 add-login）：',
  issueTraceabilityComment: (branch, pr) =>
    `SpecGit 交付分支：\`${branch}\`（草稿拉取请求 #${pr}）。`,
  prBound: (pr, delivery) => `已将 PR #${pr} 绑定到交付 '${delivery}'：`,
  prIssues: (list) => `  议题：${list}`,
  automationCompleted: (pr, target) => `已将 #${pr} 合并到 ${target}，配置要求的议题关闭已完成。`,
  automationHandoffReason: () => '核验当前提交的全部 CI/CD，合并到配置的目标分支，并完成配置要求的议题关闭。',
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
  statusUnbound: () =>
    '尚未绑定：还没有交付记录（.specgit.yaml）——这是引导前的正常状态。运行 "specgit issue" 开始交付。',
  statusHistoricalCandidate: (branch) =>
    `已完成历史候选：记录指向分支 '${branch}'，而当前检出跟踪该记录文件——很可能是已合并的交付。用 "specgit finish" 确认，或开始下一次交付："specgit issue" 会原子替换该记录。`,
  statusAssetsCurrent: () =>
    '生成资产：均为最新——所有期望的 init/setup 产物均被证实与当前 CLI 版本一致、未安装或有意跳过。',
  statusAssetsDrift: () => '生成资产：检测到漂移——请逐面执行精确修复命令：',
  statusAssetsIncomplete: () =>
    '生成资产：检查不完整——部分期望状态无法证明，因此不作"均为最新"的结论：',
  statusAssetSurface: (surface, state, fix) => `  ${surface}：${state} — 修复：${fix}`,
  statusAssetEntry: (state, path) => `    ${state} ${path}`,
  statusAssetUninspected: (code) => `  未检查（${code}）`,
  statusAssetSkipped: (code) => `  不适用（${code}）——已证实的主动退出，并非漂移`,
  setupTool: (tool) => `工具：${tool}`,
  setupInstalled: () => '已安装入口：',
  setupRemovedAsset: (path) => `已移除已退役的 SpecGit 入口 ${path}`,
  setupPreservedAsset: (path) => `已保留 ${path}（无法证明为 SpecGit 所有；未做改动）`,
  initCreatedPolicy: (path) => `已创建 ${path}`,
  initIgnoredAssets: (path) => `已将本地交付资产加入 ${path} 屏蔽（未跟踪模式；如需保持提交请用 --no-ignore）`,
  initPreservedChecks: () => '已保留现有策略中的必需检查（如需替换请显式传入 --required-check）',
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
  initRemovedAsset: (path) => `已移除过时的 SpecGit 资产 ${path}`,
  initPreservedAsset: (path) => `已保留 ${path}（无法证明为 SpecGit 所有；未做改动）`,
  initProtectionRequired: (branch, check) => `分支保护：${branch} 现在要求 "${check}"`,
  initNextAdoptionHeadline: () =>
    '下一步：接入（adoption）尚未落到默认分支——先完成接入，再启用必需检查：',
  nextHeadline: () => '下一步：',
  issueHandoffReasons: () =>
    ({
      issue_bodies:
        '填写每个 issue 正文（Why / Scope / Approach / Acceptance）——骨架正文只是建议，WHY 才是契约。',
      pr_brief: '填写 PR 简报各节（Why / What changed / Evidence）；保持 Closes #n 行不变。',
      pr_ready: '草稿永远过不了裁决；ready 之后交付才可评审。',
    }) as Record<string, string>,
  finishHandoffReasons: () =>
    ({
      delivery_merge: '裁决已绿。auto-merge 只在全部必需检查（含本裁决）通过后触发。',
      next_delivery: '该记录是已完成的历史——下一次引导会原子替换它。',
    }) as Record<string, string>,
  initAdoptionReasons: (gitlab) =>
    ({
      adoption_branch: '通过 pull request（而非直接 push）把 harness 与 policy 带到默认分支。',
      adoption_commit: 'policy 默认被 .gitignore 屏蔽——普通 "git add" 会静默跳过它；必须加 -f。',
      adoption_pr: gitlab
        ? '合并接入 MR，让你的 CI 作业存在于默认分支上。'
        : '合并接入 PR，让验收检查存在于默认分支上。',
      ...(gitlab
        ? {}
        : { adoption_protect: '只有此时启用必需检查才安全：工作流已在默认分支上，PR 能通过它。' }),
      adoption_setup: '可选：安装 agent 入口，然后检查环境与本地快照。',
    }) as Record<string, string>,
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
