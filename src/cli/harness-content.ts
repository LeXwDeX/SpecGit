/**
 * Harness CONTENT (#280): pure generation and byte-level merging for the
 * derived harness. Configuration in, bytes out — this module never touches
 * the filesystem. Placement (planning against the live tree, writing,
 * rollback) lives in `harness-placement.ts`, which receives these bytes
 * without knowing what they say.
 *
 * Everything here is deterministic so repeated harness writes are
 * byte-stable:
 *
 * - the CI acceptance workflow YAML that runs `specgit finish --json` on
 *   every pull request targeting the default branch;
 * - the managed prompt block in both languages, delimited by exact
 *   markers; a rewrite replaces only the region between them;
 * - the OpenCode merge-guard hook entry and script bytes;
 * - the git `pre-push` guard region, merged with any existing user hook
 *   via markers (#62: merge, never overwrite).
 *
 * File contents use LF line endings only.
 */

import type { PolicyLanguage } from '../record/policy.js';
import { ACCEPTANCE_JOB_MINUTES, waitStepYaml } from './wait-step.js';

const HARNESS_WORKFLOW_SEGMENTS = ['.github', 'workflows', 'specgit-accept.yml'];

export const HARNESS_WORKFLOW_PATH = HARNESS_WORKFLOW_SEGMENTS.join('/');
/** The CI check name the harness workflow contributes; also the check init guards behind branch protection. */
export const ACCEPTANCE_CHECK_NAME = 'SpecGit Acceptance';
export const AGENTS_FILENAME = 'AGENTS.md';
export const CLAUDE_FILENAME = 'CLAUDE.md';
export const BLOCK_START_MARKER = '<!-- specgit:block:start -->';
export const BLOCK_END_MARKER = '<!-- specgit:block:end -->';

export function harnessWorkflowYaml(defaultBranch = 'main'): string {
  if (defaultBranch.length === 0 || /\s/.test(defaultBranch)) {
    throw new Error(`Self harness: "${defaultBranch}" is not a usable remote default branch.`);
  }
  // Preserve this repository's historical bytes for the real `main`
  // workflow while quoting every other proved ref as YAML data.
  const branchLiteral = defaultBranch === 'main' ? 'main' : JSON.stringify(defaultBranch);
  return `name: SpecGit Acceptance

on:
  pull_request:
    branches: [${branchLiteral}]
    # A draft PR fails the verdict (pr_draft), so the draft→ready
    # transition must re-verdict. Listing types replaces the defaults,
    # so the default activity types are listed alongside. Title and body
    # edits change live acceptance evidence even when the head is unchanged.
    types: [opened, synchronize, reopened, ready_for_review, edited]
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read

# One verdict per head at a time (#319): a newer trigger event (a push
# after the draft opened, then ready_for_review) supersedes the older
# run of the same pull request instead of leaving parallel copies
# burning identical wait budgets. The surviving run re-verdicts fully.
concurrency:
  group: specgit-accept-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  specgit-acceptance:
    name: SpecGit Acceptance
    # Hosted pool on purpose: a required check must not hinge on one
    # self-hosted container.
    runs-on: ubuntu-latest
    timeout-minutes: ${ACCEPTANCE_JOB_MINUTES}
    steps:
      - name: Checkout code
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # Pin execution to this event; a newer branch push must not change
          # the code tested by an older run. Manual dispatch uses its own SHA.
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Restore the event branch
        if: github.event_name == 'pull_request' || github.ref_type == 'branch'
        env:
          SPECGIT_BRANCH: \${{ github.head_ref || github.ref_name }}
        run: |
          git check-ref-format --branch "$SPECGIT_BRANCH" >/dev/null
          git switch --create "$SPECGIT_BRANCH"

      - name: Setup Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '20.19.0'
          package-manager-cache: false
          # No dependency cache here, by design (#66): this job checks out
          # and executes untrusted PR code (install scripts, build, the CLI
          # under verdict), so it must never write to or restore from the
          # repository cache (CodeQL alerts 7-9). ci.yml keeps the warm,
          # branch-scoped cache.

      - name: Setup pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6

      - name: Install classifier dependencies
        run: pnpm install --frozen-lockfile --ignore-scripts

      - name: Classify CI scope
        id: scope
        run: node scripts/ci-change-scope.mjs

      - name: Validate CI scope
        env:
          CI_BUILD: \${{ steps.scope.outputs.build }}
        run: test "$CI_BUILD" = true || test "$CI_BUILD" = false

      - name: Build CLI
        if: steps.scope.outputs.build == 'true'
        run: pnpm run build

      - name: Install trusted CLI for metadata validation
        if: steps.scope.outputs.build == 'false'
        run: npm install --prefix "$RUNNER_TEMP/specgit-cli" --no-save --ignore-scripts --no-audit --no-fund "specgit@$(node -p \"require('./package.json').version\")"

      - name: Prepare approved policy for acceptance
        env:
          GH_TOKEN: \${{ github.token }}
          SPECGIT_WAIT_POLICY: \${{ runner.temp }}/specgit-policy.yaml
          SPECGIT_POLICY_ENTRY: \${{ steps.scope.outputs.build == 'false' && format('{0}/specgit-cli/node_modules/specgit/dist/automation/workflow-policy.js', runner.temp) || 'dist/automation/workflow-policy.js' }}
        run: |
          gh auth setup-git
          node "$SPECGIT_POLICY_ENTRY"

${waitStepYaml('gh', "\${{ steps.scope.outputs.build == 'false' && format('{0}/specgit-cli', runner.temp) || '' }}")}

      - name: specgit finish
        if: steps.scope.outputs.build == 'true'
        run: node bin/specgit.js finish --json
        env:
          GH_TOKEN: \${{ github.token }}

      - name: specgit finish with trusted CLI
        if: steps.scope.outputs.build == 'false'
        run: '"$RUNNER_TEMP/specgit-cli/node_modules/.bin/specgit" finish --json'
        env:
          GH_TOKEN: \${{ github.token }}
`;
}

/**
 * The managed guidance block (#118: language-aware). `en` and `zh`
 * carry the same delivery contract. The
 * markers are identical in every language; command literals
 * (`specgit ...`, `spec_git/policy.yaml`) stay verbatim so the guidance
 * stays copy-pasteable. Generated machine artifacts — the workflow YAML,
 * the guard scripts — are never localized.
 */
export function managedPromptBlock(language: PolicyLanguage = 'en'): string {
  if (language === 'zh') {
    return `${BLOCK_START_MARKER}
## SpecGit 交付工具链

由 \`specgit init\` 托管。标记之间的内容会在每次 init 写入工具链时重新生成
（全新 init，或策略已存在时的 \`--force\`）；手工指引请放在标记之外。

### 交付故事

- 用 \`specgit issue <标题或编号>...\` 开始：它会创建或复用议题，在交付
  分支写入并推送初始绑定，使用显式提供的正文、策略模板或内置骨架创建草稿
  PR/MR，随后记录并再次推送请求编号。重复执行会恢复现场；它是幂等的。
- 使用策略明确选择的 issue 与 PR/MR 模板。启用 \`validation.bodies\` 或
  \`required_sections\` 时，先从对话准备完整正文，创建时通过
  \`--body-file <path>\`（每个新标题一份）和 \`--pr-body-file <path>\` 传入。
  未启用正文规则时，所选策略模板或内置骨架可在创建后填写。保留所有 \`Closes #n\`；
  创建及验收都会检查启用的正文规则。恢复交付保留已有远端正文，
  不会覆盖用户修改，也不会暗中加载未选择的仓库模板。
- 草稿 PR/MR 恒使裁决失败（\`pr_draft\`）：在 \`specgit finish\` 之前，
  先把它标为可评审——GitHub 用 \`gh pr ready <number>\`，GitLab 用
  \`glab mr update <number> --ready\`。
- \`specgit finish\` 只读：裁决来自真实的 git、PR/MR 与 CI 证据，退出码
  0 表示验收通过。已启用自动化时，可信远端工作流在 CI 结束后自动续行，
  无需再次人工确认；\`specgit pr --merge --json\` 是恢复入口。它验证已批准
  策略的 \`target_branch\`、重新验收及当前 PR/MR 头的全部 CI 检查，确认合并
  与全部绑定议题关闭后才报告 completed；关闭失败保留可恢复的待收尾状态。

### 议题标签

- 按项目策略的 \`language\` 填写 issue 与 PR/MR；\`validation\` 启用的标题与
  标签规则在创建前和 \`finish\` 中校验。\`kind\` 模式要求一个内置类型，
  扩展标签须在 \`tags\` 中声明；\`project\` 模式只选 \`tags\` 中的标签。
  更改规则时，由用户通过 \`specgit init --force --configure-rules\` 选择。
- 每次引导都会自动应用标题的 \`kind::<type>\` 成员；显式传入
  \`--tags <a,b>\` 可自选完整集合。
- 选择以池为先：仓库中符合语法的既有标签原样胜出；缺失的名称从内置的
  \`kind::\` 目录或策略的 \`tags:\` 声明中播种。未知词汇以退出码 2 指名
  全集。
- 每轴至多一个标签；可选标签拿不准就不选，必选标签以策略为准。池外标签会被报告
  （\`tag_pool_dirty\` 警告是给人看的），SpecGit 绝不重命名它们。

### 修复与诊断

- \`specgit pr\` 修复 PR/MR 绑定：不带参数时按当前头分支自动发现请求，
  找不到时报错并给出修复办法，找到多个时列出并拒绝。
- \`specgit status\` 只展示本地证据：记录、状态、漂移、origin。
  \`specgit doctor\` 探测 git、仓库、origin、已配置的平台 CLI（GitHub 用
  \`gh\`，已声明 GitLab host 时用 \`glab\`）与策略。
- 诊断信息（diagnostic 的 message/fix）与诊断 \`code\` 恒为英文——这是
  机器契约的一部分，任何语言配置都不本地化它们；按 \`code\` 与 \`fix\`
  行动，不要依赖语言一致性。

### 命令面

- 十个命令：\`specgit init\`、\`specgit setup\`、\`specgit issue\`、
  \`specgit pr\`、\`specgit finish\`、\`specgit bind\`、\`specgit unbind\`、
  \`specgit status\`、\`specgit accept\`、\`specgit doctor\`。
- \`specgit setup\` 安装代理入口（opencode 的命令、其他工具的可移植
  skill）；\`specgit bind\`、\`specgit unbind\`、\`specgit accept\` 是面向
  脚本与 CI 的自动化别名。
- 自动化默认关闭（\`--automation no\`）。新建策略时，只有用户本人选择 yes，
  才能用 \`specgit init --automation yes --merge-target <branch>\` 开启；已有策略
  要改为自动化时，使用
  \`specgit init --force --automation yes --merge-target <branch>\`。普通
  \`init --force\` 保留已有选择与目标；代理不得替用户回答 yes。

### 建议题之前，先查重

- 用新标题运行 \`specgit issue\` 之前，通过已认证的会话搜索 tracker 中相近的
  在办工作：GitHub 使用 \`gh issue list --state open --search "<关键词>"\`；GitLab 使用
  \`glab issue list --search "<关键词>" --in title\`。需要时用标签继续缩小范围。
- 用 GitHub 的 \`gh issue view <n>\` 或 GitLab 的 \`glab issue view <n>\`
  打开并阅读每一个疑似候选——比较 WHY 本身，而不是措辞。
- 若某个候选覆盖了同一个 WHY，继续那个议题而不是新建；若相近但不同，
  说明差别在哪里。
- 拿不准时，请提出请求的人决定是继续已有议题还是接受重复。一个团队
  一个 WHY 只走一条工作线，绝不两条。

### 议题粒度

一个议题 = 一个可独立验证的 WHY。若一个交付物无法凭自身证据验证，
先拆分再绑定。

### 铁律

- \`specgit finish\` 退出码非 0：绝不请求合并。修交付，不修门槛。
- 绝不为了通过裁决而削弱 \`spec_git/policy.yaml\`。
- \`--json\` 是唯一的解析面：stdout 恰好是一个 JSON 文档；绝不抓取
  人读输出。

### 代理契约要点

- **SpecGit 是这里的默认交付方式。** 有意提交的新功能、修复、重构、
  文档变更与共享规则变更需要交付绑定：工作项作为议题存放在这个 tracker
  里，绝不放进私人任务清单或对话式清单。触发点是“决定开工”的那一刻：
  对话收敛、开始把计划变成变更之时，第一个动作就是
  \`specgit issue <type>: <标题>...\`——先于受跟踪的实现变更；为引导准备
  临时正文文件属于这一步。无绑定就实现是违反契约。引导完成后，检查
  议题是否包含讨论中的 为什么 / 范围 / 做法 / 验收，只用 \`gh issue edit\`
  或 \`glab issue update\` 补全缺失内容，再开始
  实现。会话中途的盘点（“让我列出所有要做的事”）也应变成议题，而不是
  聊天产物。平凡的回复与只读提问无需如此。
- 本地维护：安装或升级 CLI、运行 \`init\` / \`setup\` 刷新本地配置与入口，
  在没有计划提交产品或共享规则变更时，无需议题、PR/MR、产品构建或发布。
  包升级后，人类可运行裸 \`specgit init\`，仅在它证明存在漂移时批准引导刷新；
  非交互代理依次运行 \`specgit init --force --no-protect\`、
  \`specgit setup --tool all\`，再以 \`specgit status --json\` 验证。
  若权威交付文件被有意跟踪且没有托管 ignore 块，则为 init 追加
  \`--no-ignore\`；setup 会保留这项已证明的选择。
  先检查跟踪文件的差异，再决定哪些变更需要共享；忽略规则不是 CI 豁免名单。
  按宿主项目对真实变更输入的验证政策运行检查，文档也可能是产品输入。
  发布包必须有明确发布意图，并在已有用户授权范围内执行；本地维护与合并本身不代表发布。
- \`specgit finish\` 退出 \`0\` 表示 accepted；只有配置目标上的合并和全部
  绑定议题关闭均经核验，才能报告 completed。绝不凭任务清单、文件状态或
  自己跑过的测试宣布完成。失败 PR/MR 用新的修复议题承接，重复原因复用已有
  开放修复议题，不要求废弃原 PR/MR。
- 沿用已有用户授权完成议题正文、PR/MR 正文与 ready、CI 修复或重试、验收
  以及授权范围内的合并闭环。只在缺少用户授权或平台权限时，携已准备好的
  结果说明具体缺口；文档与入口指引本身不授予权限。
- 按退出码分支，不按措辞：\`1\` = 证据齐全，修门槛点名的内容；\`3\` =
  证据缺失，先按 \`errors[].fix\` 修复。只有 git、仓库、origin、已配置的平台
  CLI/auth 或策略探针失败时才运行 \`specgit doctor --json\`。绝不把退出 \`3\`
  当作成功。
- 保持 PR/MR 正文里的 \`Closes #n\` 引用完整；改动 PR/MR 正文、头分支或 CI
  后重跑 \`specgit finish\`。绝不为通过验收而绕过或改配置必需检查。
- 平台证据只经由用户已认证的 CLI 会话（\`gh\` / \`glab\`）流转：绝不
  读取、记录或传递 token。
${BLOCK_END_MARKER}`;
  }
  return `${BLOCK_START_MARKER}
## SpecGit delivery harness

Managed by \`specgit init\`. Everything between the markers is regenerated
whenever init writes the harness (a fresh init, or \`--force\` when a policy
already exists); keep manual guidance outside them.

### The delivery story

- Start with \`specgit issue <title-or-number>...\`: it creates or reuses
  the issues, writes and pushes the initial binding on the delivery branch,
  opens the draft pull or merge request with the supplied body, selected policy
  template, or built-in scaffold, then records and pushes its number. Re-running
  resumes; it is idempotent.
- Use the issue and PR/MR templates explicitly selected by policy. With
  \`validation.bodies\` or \`required_sections\`, prepare complete content from
  the discussion before bootstrap and supply \`--body-file <path>\` per new
  title and \`--pr-body-file <path>\`. Without enforced body rules, the selected
  policy template or built-in scaffold can be filled after creation. Preserve
  every \`Closes #n\`; enabled body
  rules apply at creation and acceptance. Resume keeps existing remote bodies
  and user edits. Unselected repository templates are not silently loaded.
- A draft PR/MR always fails the verdict (\`pr_draft\`): before
  \`specgit finish\`, mark it ready for review — \`gh pr ready <number>\`
  on GitHub, \`glab mr update <number> --ready\` on GitLab.
- \`specgit finish\` is read-only: its verdict comes from real git, PR/MR,
  and CI evidence; exit 0 means accepted. With automation enabled, the trusted
  remote workflow continues after CI without another confirmation.
  \`specgit pr --merge --json\` is the recovery path: it verifies the approved
  \`target_branch\`, fresh acceptance, and all current-head CI, then confirms
  the merge and every bound issue closure before reporting completed.
  A failed closure remains recoverable and is never reported as completed.

### Issue tags

- Follow the project's \`language\` for issues and PRs/MRs. Enabled \`validation\`
  rules check titles and labels before creation and during \`finish\`.
  \`kind\` mode requires one catalog kind and only declared extras;
  \`project\` mode selects only policy \`tags\`. Users choose rule changes with
  \`specgit init --force --configure-rules\`.
- Every bootstrap applies the title's \`kind::<type>\` member
  automatically; pass \`--tags <a,b>\` to choose the full set explicitly.
- Selection is pool-first: existing on-spec labels win verbatim; anything
  missing is seeded from the built-in \`kind::\` catalog or the policy's
  \`tags:\` declarations. Unknown vocabulary exits 2 naming the universe.
- Choose at most one label per axis; omit uncertain optional labels and
  keep every label required by the selected policy. Existing pool labels
  cannot override that policy —
  off-spec pool labels are reported (\`tag_pool_dirty\` warnings are for
  humans) and never renamed by SpecGit.

### Repair and diagnostics

- \`specgit pr\` repairs the PR/MR binding: with no arguments it
  auto-discovers the request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- \`specgit status\` shows local evidence only: record, state, drift,
  origin. \`specgit doctor\` probes git, repository, origin, the configured
  provider CLI (\`gh\`, or \`glab\` for a declared GitLab host), and policy.

### The command surface

- Ten commands: \`specgit init\`, \`specgit setup\`, \`specgit issue\`,
  \`specgit pr\`, \`specgit finish\`, \`specgit bind\`, \`specgit unbind\`,
  \`specgit status\`, \`specgit accept\`, \`specgit doctor\`.
- \`specgit setup\` installs the agent entry points (commands for opencode,
  portable skills for other tools); \`specgit bind\`, \`specgit unbind\`,
  and \`specgit accept\` are automation aliases for scripts and CI.
- Automation defaults to off (\`--automation no\`). For a fresh policy, only
  when the user personally chooses yes may they enable it with
  \`specgit init --automation yes --merge-target <branch>\`. To change an
  existing policy, use
  \`specgit init --force --automation yes --merge-target <branch>\`; plain
  \`init --force\` preserves its current choice and target. An agent must not
  answer yes for the user.

### Before creating an issue, check for duplicates

- Before running \`specgit issue\` with a new title, search the tracker for
  similar open work through the authenticated session: on GitHub use
  \`gh issue list --state open --search "<keywords>"\`; on GitLab use
  \`glab issue list --search "<keywords>" --in title\`. Narrow
  further with labels when useful.
- Open and read every plausible candidate with \`gh issue view <n>\` on GitHub
  or \`glab issue view <n>\` on GitLab — compare the WHY, not just the wording.
- If a candidate covers the same WHY, continue that issue instead of
  creating a new one; if it is close but different, say how they differ.
- When unsure, ask the requester to decide between continuing the existing
  issue and creating a duplicate. The team ships one line of work per WHY,
  never two.

### Issue granularity

One issue = one independently verifiable WHY. If a deliverable cannot be
verified on its own evidence, split it before binding.

### Iron rules

- \`specgit finish\` exit code other than 0: never request merge. Fix the
  delivery, not the gate.
- Never weaken \`spec_git/policy.yaml\` to make a verdict pass.
- \`--json\` is the only parse surface: stdout is exactly one JSON
  document; never scrape human-readable output.

### Agent contract essentials

- **SpecGit is the default delivery workflow here.** An intended tracked
  change — a feature, a fix, a refactor, a docs change, or shared rules — is a delivery:
  work items live in this tracker as issues, never in private task
  lists or conversational checklists. The trigger is the decision to
  start: the moment the conversation settles and you begin turning
  the plan into changes, the FIRST action is
  \`specgit issue <type>: <title>...\` — before tracked implementation edits.
  Preparing temporary body files for bootstrap is part of this first step.
  Working without a binding is a contract violation, not a style
  choice. After bootstrap, verify each issue contains the discussed
  Why / Scope / Approach / Acceptance and fill only missing content with
  \`gh issue edit\` or \`glab issue update\`,
  then implement. Mid-conversation inventories
  ("let me list everything to do") become issues, not chat
  artifacts. Trivial replies and read-only questions need none of
  this.
- Local maintenance: installing or upgrading the CLI and running \`init\` /
  \`setup\` to refresh local configuration and entry points need no issue, PR/MR,
  product build, or release when no product or shared-rule change is intended
  for commit. After a package upgrade, a human may run plain \`specgit init\`
  and approve its guided refresh when it proves drift; non-interactive agents
  run \`specgit init --force --no-protect\`, then \`specgit setup --tool all\`,
  then verify \`specgit status --json\`. Append \`--no-ignore\` to init when
  authoritative delivery files are intentionally tracked without the managed
  ignore block; setup preserves that proven choice. Review tracked diffs before choosing what to share; ignore rules
  are never CI exemptions. Follow the host project's verification policy for
  the actual changed inputs; documentation may itself be a product input.
  Publishing requires explicit release intent within existing user authorization;
  local maintenance and merging do not imply publication.
- \`specgit finish\` exit \`0\` means accepted. Report completed only after
  the configured target merge and every bound issue closure are confirmed.
  Never declare completion from task lists, file states, or tests alone.
  Track a failed PR/MR with a new repair issue; repeated causes reuse an open
  repair issue and do not require abandoning the original PR/MR.
- Use existing user authorization to complete issue bodies, the PR/MR body
  and ready transition, CI repairs or retries, acceptance, and the authorized
  merge. When user authorization or platform permission is missing, present
  the prepared result and name the specific gap. Documentation and entry
  points do not grant permission themselves.
- Branch on exit codes, not phrasing: \`1\` = evidence complete, fix what
  the gates named; \`3\` = evidence missing, so follow \`errors[].fix\` first.
  Run \`specgit doctor --json\` only for git, repository, origin, configured
  provider CLI/auth, or policy probes. Never present exit \`3\` as success.
- Keep the \`Closes #n\` references in the PR/MR body intact; after changing
  the PR/MR body, head branch, or CI, re-run \`specgit finish\`. Never
  bypass or reconfig a required check to make acceptance pass.
- Forge evidence flows through the user's authenticated CLI session only
  (\`gh\` / \`glab\`): never read, log, or pass around tokens.
${BLOCK_END_MARKER}`;
}

/**
 * Line-anchored marker pairing — the same discipline
 * `reconcileLocalAssetIgnore` applies to the managed `.gitignore` region:
 * a marker is a WHOLE line (exact literal up to surrounding whitespace;
 * a mid-line prose mention never pairs and is never consumed), and an END
 * line closes the NEAREST preceding unmatched START line, so a stray
 * START ahead of a complete region never swallows the user bytes between
 * them. Returns the first completed pairing, plus the whole-line marker
 * predicate for stray consumption.
 */
function pairMarkerLines(
  lines: string[],
  isStart: (line: string) => boolean,
  isEnd: (line: string) => boolean
): { firstPair: { start: number; end: number } | null; isMarkerLine: (line: string) => boolean } {
  const open: number[] = [];
  let firstPair: { start: number; end: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (isStart(line)) {
      open.push(index);
    } else if (isEnd(line) && open.length > 0) {
      const start = open.pop() as number;
      if (firstPair === null) {
        firstPair = { start, end: index };
      }
    }
  }
  return {
    firstPair,
    isMarkerLine: (line: string) => isStart(line) || isEnd(line),
  };
}

/**
 * The lines in [from, to) that are NOT marker lines — everything the
 * merge must preserve verbatim.
 */
function nonMarkerLines(
  lines: string[],
  range: { from: number; to: number },
  isMarkerLine: (line: string) => boolean
): string[] {
  return lines.slice(range.from, range.to).filter((line) => !isMarkerLine(line));
}

/**
 * Pure transform: place `block` (which carries the markers) into existing
 * file content. When both markers are present, only the delimited region is
 * replaced; otherwise the block is appended after a blank line. Byte-stable
 * for repeated injection of the same block.
 *
 * Damaged layouts converge instead of growing: reversed or stray marker
 * LINES are consumed wherever they sit (user bytes never are), and when no
 * START/END pairing exists at all the block is appended to the remainder —
 * so every re-write leaves exactly one managed region and re-writing that
 * output is a byte-level no-op.
 */
export function injectManagedBlock(existing: string, block: string): string {
  const lines = existing.split('\n');
  const { firstPair, isMarkerLine } = pairMarkerLines(
    lines,
    (line) => line.trim() === BLOCK_START_MARKER,
    (line) => line.trim() === BLOCK_END_MARKER
  );
  if (firstPair !== null) {
    // Replace the first paired region; marker lines anywhere else
    // (a later duplicated region's, a stray's) are consumed, and every
    // other line keeps its bytes and position.
    return [
      ...nonMarkerLines(lines, { from: 0, to: firstPair.start }, isMarkerLine),
      ...block.split('\n'),
      ...nonMarkerLines(lines, { from: firstPair.end + 1, to: lines.length }, isMarkerLine),
    ].join('\n');
  }
  const remainder = lines.filter((line) => !isMarkerLine(line)).join('\n');
  if (remainder.length === 0) {
    return `${block}\n`;
  }
  const separator = remainder.endsWith('\n') ? '' : '\n';
  return `${remainder}${separator}\n${block}\n`;
}

const GUARD_COMMAND = '.opencode/hooks/specgit-merge-guard.sh';

/** Tools the guard hook listens on: bash verbs plus the file mutators (#335). */
const GUARD_MATCHER = 'Bash|Edit|Write';

const GUARD_HOOK_JSON = `{
  "PreToolUse": [
    {
      "matcher": "${GUARD_MATCHER}",
      "hooks": [
        {
          "type": "command",
          "command": "${GUARD_COMMAND}",
          "timeout": 600
        }
      ]
    }
  ]
}
`;

/** The specgit entry to merge into an existing hooks.json. */
const GUARD_HOOK_ENTRY = JSON.parse(GUARD_HOOK_JSON) as {
  PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>;
};

export const HOOKS_JSON_PATH = '.opencode/hooks.json';

export interface HooksJsonMergeResult {
  json: string;
  /** Present when the existing file could not be merged; `json` is then the unchanged input. */
  warning?: string;
}

/**
 * Merge the specgit guard into existing `.opencode/hooks.json` content
 * (#62: merge, never overwrite). User entries and unknown top-level keys
 * are preserved verbatim; the specgit `PreToolUse`/Bash entry is appended
 * exactly once. Byte-stable: merging the merge output again is a no-op.
 * Invalid or non-object JSON is returned untouched with a warning — the
 * user's broken file must not be destroyed by us.
 */
export function mergeHooksJson(existing: string | null): HooksJsonMergeResult {
  if (existing === null) {
    return { json: GUARD_HOOK_JSON };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      json: existing,
      warning: `existing ${HOOKS_JSON_PATH} is not valid JSON (${detail}); left untouched`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      json: existing,
      warning: `existing ${HOOKS_JSON_PATH} is not a JSON object; left untouched`,
    };
  }

  const config = structuredClone(parsed) as Record<string, unknown>;
  const specgitEntry = structuredClone(GUARD_HOOK_ENTRY.PreToolUse[0]);

  if (Object.hasOwn(config, 'PreToolUse') && !Array.isArray(config.PreToolUse)) {
    return { json: existing, warning: `existing ${HOOKS_JSON_PATH} PreToolUse is not an array; left untouched` };
  }
  if (config.PreToolUse === undefined) {
    config.PreToolUse = [];
  }
  const preToolUse = config.PreToolUse as unknown[];
  // The specgit entry is found by its command, not its matcher (#335): an
  // install from an older CLI carries matcher "Bash"; the merge upgrades
  // that matcher in place instead of appending a second guard entry. User
  // entries — any entry without the guard command — stay verbatim.
  const ownedEntry = preToolUse.find(
    (entry): entry is { matcher?: unknown; hooks: Array<Record<string, unknown>> } =>
      typeof entry === 'object' &&
      entry !== null &&
      Array.isArray((entry as { hooks?: unknown }).hooks) &&
      ((entry as { hooks?: unknown[] }).hooks ?? []).some(
        (hook) =>
          typeof hook === 'object' &&
          hook !== null &&
          (hook as { command?: unknown }).command === GUARD_COMMAND
      )
  );
  if (ownedEntry) {
    const userHooks = ownedEntry.hooks.filter((hook) =>
      typeof hook !== 'object' || hook === null || hook.command !== GUARD_COMMAND);
    if (userHooks.length > 0) {
      ownedEntry.hooks = userHooks;
      preToolUse.push(specgitEntry);
      return { json: `${JSON.stringify(config, null, 2)}\n` };
    }
    if (ownedEntry.matcher !== GUARD_MATCHER) {
      ownedEntry.matcher = GUARD_MATCHER;
    }
  } else {
    preToolUse.push(specgitEntry);
  }

  return { json: `${JSON.stringify(config, null, 2)}\n` };
}

// Local push guards resolve the full symbolic ref at execution time, so a
// default-branch rename needs no regenerated branch literal. Keep failed or
// dangling evidence distinct from a branch that happens to be named main.
const PUSH_DEFAULT_REF = `specgit_default_ref() {
  specgit_ref=\$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null) || return 1
  case "\$specgit_ref" in
    refs/remotes/origin/HEAD) return 1 ;;
    refs/remotes/origin/?*) ;;
    *) return 1 ;;
  esac
  git rev-parse --verify "\$specgit_ref^{commit}" >/dev/null 2>&1 || return 1
  printf '%s' "\$specgit_ref"
}
`;

// Blocks merge/default-branch push attempts that bypass the evidence verdict, and —
// since #335 — file-mutation tool calls on a branch with no delivery
// binding: the start gate. Bash verbs match only the command's leading
// pattern so prose containing the keywords (e.g. an issue body) never trips
// the guard; the start gate keys off tool_name (edit/write), comparing the
// branch recorded in .specgit.yaml with the current git branch. The merge
// branch is bounded (#68): the verdict runs under a budget derived from the
// configured provider timeouts (SPECGIT_GH_TIMEOUT_MS and
// SPECGIT_GLAB_TIMEOUT_MS) and never below either; budget
// expiry is reported as "no verdict", never as a rejection, and a blocked
// merge prints a concise summary naming pending (transient) and failed
// checks.
const GUARD_SCRIPT = `#!/bin/sh
# SpecGit guard (managed by specgit init): start gate + merge guard. Exit 2 = block with reason.
GUARD_DIR=\$(cd "\$(dirname "\$0")" && pwd)
export GUARD_DIR
# Hook payloads arrive as the first argument or on stdin; accept both.
if [ -n "\$1" ]; then
  payload=\$1
else
  payload=\$(cat)
fi
tool=\$(printf '%s' "\$payload" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_name)||'')}catch{process.stdout.write('')}})")
case "\$tool" in
  edit|write|Edit|Write)
    # Start gate (#335): mutating files requires the delivery binding on
    # THIS branch. The record's context.branch is written by specgit and
    # matched as a fixed WHOLE line — no YAML parsing, no prefix collision
    # (branch "feat/1-a" must never satisfy a record for "feat/1-a2").
    branch=\$(git branch --show-current 2>/dev/null)
    if [ -z "\$branch" ] || [ ! -f .specgit.yaml ] || ! grep -qFx "  branch: \$branch" .specgit.yaml; then
      echo "specgit: start gate - this branch has no delivery binding. Start the delivery first according to the managed guidance: prepare any required body files, then run specgit issue \\"<type>: <title>\\" with them before editing files." >&2
      exit 2
    fi
    exit 0
    ;;
esac
command=\$(printf '%s' "\$payload" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.command)||'')}catch{process.stdout.write('')}})")

# Classify statically visible forge-merge commands without executing or
# expanding shell input. The lexer understands quoting, command separators,
# environment assignments, env/command/exec wrappers, and forge-global repo
# selectors. It deliberately inspects only each simple command's executable
# and leading global options, so quoted prose such as echo "gh pr merge" does
# not trigger the gate.
merge_command=\$(printf '%s' "\$command" | node -e '
  const fs = require("fs");
  const source = fs.readFileSync(0, "utf8");
  const SQ = String.fromCharCode(39);
  const DQ = String.fromCharCode(34);
  const BS = String.fromCharCode(92);

  function tokenize(text) {
    const tokens = [];
    let word = "";
    let active = false;
    let quote = 0;
    const flush = () => {
      if (!active) return;
      tokens.push({ kind: "word", value: word });
      word = "";
      active = false;
    };
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quote === 39) {
        if (char === SQ) quote = 0;
        else word += char;
        continue;
      }
      if (quote === 34) {
        if (char === DQ) {
          quote = 0;
        } else if (char === BS) {
          if (index + 1 >= text.length) return null;
          word += text[++index];
        } else {
          word += char;
        }
        continue;
      }
      if (char === SQ || char === DQ) {
        quote = char === SQ ? 39 : 34;
        active = true;
      } else if (char === BS) {
        if (index + 1 >= text.length) return null;
        const next = text[++index];
        if (next !== "\\n") {
          word += next;
          active = true;
        }
      } else if (char === " " || char === "\\t" || char === "\\r") {
        flush();
      } else if (char === "\\n" || char === ";" || char === "|" ||
                 char === "&" || char === "(" || char === ")") {
        flush();
        if ((char === "|" || char === "&") && text[index + 1] === char) index += 1;
        tokens.push({ kind: "boundary" });
      } else if (char === "#" && !active) {
        while (index + 1 < text.length && text[index + 1] !== "\\n") index += 1;
      } else {
        word += char;
        active = true;
      }
    }
    if (quote !== 0) return null;
    flush();
    return tokens;
  }

  const executable = (word) => {
    const base = word.replace(/\\\\/g, "/").split("/").pop() || "";
    return base.toLowerCase().replace(/\\.exe$/, "");
  };
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

  function unwrap(words) {
    let index = 0;
    while (assignment.test(words[index] || "")) index += 1;
    if (executable(words[index] || "") === "env") {
      index += 1;
      while (assignment.test(words[index] || "")) index += 1;
    }
    while (["command", "exec"].includes(executable(words[index] || ""))) {
      index += 1;
    }
    return words.slice(index);
  }

  function isForgeMerge(segment) {
    const words = unwrap(segment);
    const forge = executable(words[0] || "");
    if (forge !== "gh" && forge !== "glab") return false;
    let index = 1;
    while (index < words.length) {
      const option = words[index];
      if (["-R", "--repo", "--hostname"].includes(option)) {
        if (index + 1 >= words.length) return false;
        index += 2;
      } else if (option === "--" || option.startsWith("--repo=") ||
                 option.startsWith("--hostname=") ||
                 (option.startsWith("-R") && option.length > 2)) {
        index += 1;
        if (option === "--") break;
      } else {
        break;
      }
    }
    return forge === "gh"
      ? words[index] === "pr" && words[index + 1] === "merge"
      : words[index] === "mr" && words[index + 1] === "merge";
  }

  const tokens = tokenize(source);
  if (tokens === null) {
    process.stdout.write("indeterminate");
  } else {
    let segment = [];
    for (const token of [...tokens, { kind: "boundary" }]) {
      if (token.kind === "word") {
        segment.push(token.value);
      } else {
        if (isForgeMerge(segment)) {
          process.stdout.write("merge");
          process.exit(0);
        }
        segment = [];
      }
    }
  }
')
classifier_status=\$?
if [ "\$classifier_status" -ne 0 ]; then
  merge_command=indeterminate
fi

case "\$merge_command" in
  indeterminate)
    echo "specgit: command blocked - the merge guard could not safely classify the shell input. Retry with a direct gh pr merge or glab mr merge command." >&2
    exit 2
    ;;
  merge)
    exec node -e '
      const { spawn } = require("child_process");
      const fs = require("fs");
      const path = require("path");
      const timeoutMs = ["SPECGIT_GH_TIMEOUT_MS", "SPECGIT_GLAB_TIMEOUT_MS"]
        .map((name) => parseInt(process.env[name] || "", 10))
        .map((value) => Number.isFinite(value) && value > 0 ? value : 15000);
      const providerS = Math.max(1, Math.ceil(Math.max(...timeoutMs) / 1000));
      let budgetS = Math.max(60, providerS * 8);
      const overrideRaw = parseInt(process.env.SPECGIT_GUARD_BUDGET_S || "", 10);
      if (Number.isFinite(overrideRaw) && overrideRaw > 0) {
        budgetS = Math.max(overrideRaw, providerS);
      }
      // The hook runner kills long hooks; surface the mismatch instead of
      // being cut off mid-verdict.
      try {
        const hooks = JSON.parse(
          fs.readFileSync(path.join(process.env.GUARD_DIR || ".", "..", "hooks.json"), "utf8")
        );
        const runner = (hooks.PreToolUse || [])
          .flatMap((entry) => entry.hooks || [])
          .map((hook) => hook.timeout)
          .find((timeout) => typeof timeout === "number");
        if (runner !== undefined && runner - 10 < budgetS) {
          console.error(
            "specgit: guard budget " + budgetS + "s exceeds the hook runner timeout " +
              runner + "s in .opencode/hooks.json - raise the runner timeout or lower SPECGIT_GUARD_BUDGET_S."
          );
        }
      } catch {}
      const cp = require("child_process");
      const isWin = process.platform === "win32";
      // Windows: cmd.exe cannot exec an extensionless sh shim, so prefer
      // git-bash sh when present; only then fall back to shell mode.
      let child;
      if (isWin) {
        const probe = cp.spawnSync("sh", ["-c", "exit 0"]);
        if (probe.status === 0) {
          child = spawn("sh", ["-c", "specgit finish --json"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
        }
      }
      if (!child) {
        child = spawn("specgit", ["finish", "--json"], {
          shell: isWin,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      let out = "";
      let err = "";
      let expired = false;
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const timer = setTimeout(() => {
        expired = true;
        // Bound the wait strictly: descendants may inherit the pipes, so
        // destroy them and exit now — never lag behind orphaned children.
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill("SIGKILL");
        console.error(
          "specgit: merge blocked - guard budget " + budgetS + "s exhausted before a verdict. This says nothing about the delivery; run specgit finish directly for the full verdict."
        );
        process.exit(2);
      }, budgetS * 1000);
      child.on("error", (error) => {
        clearTimeout(timer);
        console.error(
          "specgit: merge blocked - the verdict could not run (" + error.message + "). Install specgit on PATH, then retry the merge."
        );
        process.exit(2);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (expired) {
          process.exit(2);
        }
        if (code === 0) {
          process.exit(0);
        }
        let envelope = null;
        try {
          envelope = JSON.parse(out);
        } catch {}
        const verdict = envelope && envelope.verdict;
        const gates = (envelope && (envelope.gates || (verdict && verdict.gates))) || [];
        const failures = [];
        for (const gate of gates) {
          for (const failure of (gate && gate.failures) || []) failures.push(failure);
        }
        const label = (failure, suffix) => {
          const detail = failure.detail || {};
          const name = detail.name || failure.code;
          const state = suffix || detail.status || detail.conclusion || "";
          return name + (state ? " [" + state + "]" : "");
        };
        const pending = failures.filter((f) => f.code === "checks_pending");
        const failed = failures.filter((f) => f.code === "checks_failed");
        const other = failures.filter(
          (f) => f.code !== "checks_pending" && f.code !== "checks_failed"
        );
        const lines = [];
        if (code === 1) {
          lines.push(
            "specgit: merge blocked - verdict rejected (exit 1). Fix what the failures name; never weaken spec_git/policy.yaml to pass."
          );
        } else {
          lines.push(
            "specgit: merge blocked - no verdict possible (evidence incomplete, exit " + code + "). This is not a rejection: follow errors[].fix in the specgit finish --json result first. Run specgit doctor --json only for git, repository, origin, configured provider CLI/auth, or policy probes, then retry."
          );
        }
        if (pending.length > 0) {
          lines.push(
            "  pending (transient - wait, then re-run): " + pending.map((f) => label(f)).join(", ")
          );
        }
        if (failed.length > 0) {
          lines.push(
            "  failed (repair required): " +
              failed
                .map((f) =>
                  label(
                    f,
                    f.detail && f.detail.conclusion === "action_required"
                      ? "action_required - run awaits maintainer approval"
                      : undefined
                  )
                )
                .join(", ")
          );
        }
        if (other.length > 0) {
          lines.push("  other failures: " + other.map((f) => label(f)).join(", "));
        }
        lines.push("Full verdict: specgit finish");
        console.error(lines.join("\\n"));
        process.exit(2);
      });
    '
    ;;
esac
unset classifier_status merge_command

${PUSH_DEFAULT_REF}
case "\$command" in
  git\\ push\\ origin\\ *)
    default_ref=\$(specgit_default_ref) || {
      echo "specgit: cannot prove origin/HEAD. Run git fetch origin and git remote set-head origin -a before pushing." >&2
      exit 2
    }
    default_branch=\${default_ref#refs/remotes/origin/}
    case "\$command" in
      git\\ push\\ origin\\ "\$default_branch"|git\\ push\\ origin\\ "\$default_branch"\\ *|git\\ push\\ origin\\ +"\$default_branch"|git\\ push\\ origin\\ +"\$default_branch"\\ *|git\\ push\\ origin\\ HEAD:"\$default_branch"|git\\ push\\ origin\\ HEAD:"\$default_branch"\\ *)
        echo "specgit: direct push to \$default_branch is not the delivery path. Deliveries go: specgit issue -> PR/MR -> CI -> specgit finish (exit 0) -> merge." >&2
        exit 2
        ;;
    esac
    ;;
esac
exit 0
`;

export { GUARD_SCRIPT };

// Local git-layer guard: refuses direct pushes to the proved default branch; deliveries must go
// through PR/MR + CI + specgit finish. The managed file wraps this BODY in
// SPECGIT_PRE_PUSH_MARKERS so an existing user hook is merged, not
// replaced (#62) — and keeps the shebang on line 1, ahead of the start
// marker, because git on Windows execs the hook directly and cannot
// spawn a file whose first line is a plain comment (#67 matrix,
// windows-pwsh: "cannot spawn ... pre-push: Exec format error").
const GIT_PRE_PUSH_BODY = `# SpecGit pre-push guard (managed by specgit init).
${PUSH_DEFAULT_REF}
default_ref=\$(specgit_default_ref) || {
  echo "specgit: cannot prove origin/HEAD. Run git fetch origin and git remote set-head origin -a before pushing." >&2
  exit 1
}
default_branch=\${default_ref#refs/remotes/origin/}
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "\$remote_ref" = "refs/heads/\$default_branch" ]; then
    # A commit already contained by the proved origin default is accepted
    # history and may be mirrored. A zero sha (deletion) cannot pass.
    if git merge-base --is-ancestor "\$local_sha" "\$default_ref" >/dev/null 2>&1; then
      continue
    fi
    echo "specgit: direct push to \$default_branch is not the delivery path." >&2
    echo "Deliveries go: specgit issue -> PR/MR -> CI -> specgit finish (exit 0) -> merge." >&2
    exit 1
  fi
done
exit 0
`;

// The pre-#62 unmarked install: shebang + body, no markers.
const GIT_PRE_PUSH = `#!/bin/sh
${GIT_PRE_PUSH_BODY}`;

const PRE_PUSH_START = '# >>> specgit:start >>>';
const PRE_PUSH_END = '# <<< specgit:end <<<';

/** Generator-exclusive ownership line: stable across body generations. */
const GIT_PRE_PUSH_SIGNATURE = '# SpecGit pre-push guard (managed by specgit init).';

/** The marker-delimited guard region (no shebang of its own). */
function managedPrePushRegion(): string {
  return `${PRE_PUSH_START}
# Run first in a subshell and replay stdin for the user's hook.
specgit_pre_push_refs=$(mktemp) || exit 1
cat > "$specgit_pre_push_refs" || { rm -f "$specgit_pre_push_refs"; exit 1; }
(
${GIT_PRE_PUSH_BODY}) < "$specgit_pre_push_refs"
specgit_pre_push_status=$?
exec < "$specgit_pre_push_refs"
rm -f "$specgit_pre_push_refs"
if [ "$specgit_pre_push_status" -ne 0 ]; then
  exit "$specgit_pre_push_status"
fi
unset specgit_pre_push_refs specgit_pre_push_status
${PRE_PUSH_END}
`;
}

/** A fresh managed file: shebang line 1, then the managed region. */
function managedPrePush(): string {
  return `#!/bin/sh\n${managedPrePushRegion()}`;
}

/**
 * Merge the specgit pre-push guard into existing hook content (#62:
 * merge, never overwrite). Cases, all byte-stable on re-merge:
 * - absent/empty: the spawnable managed file alone;
 * - the legacy unmarked specgit guard (pre-#62 installs): upgraded;
 * - the #62 marker-first layout (shebang on line 2, unspawnable on
 *   Windows): rebuilt so the shebang becomes line 1, preserving any
 *   content after the managed region (#88-3);
 * - markers present: the delimited region is refreshed before user code;
 * - a user shell hook keeps its shebang and body, with the managed
 *   preflight inserted first and stdin replayed for the original hook;
 * - another interpreter is rejected before writes, since shell text
 *   cannot safely be composed into that program.
 *
 * Damaged marker layouts converge like `injectManagedBlock`: marker
 * LINES pair nearest-start-first (a stray START never swallows user
 * bytes), unpaired marker lines are consumed, and with no pairing at
 * all the region is appended to the remainder.
 */
export function mergeGitPrePush(existing: string | null): string {
  if (existing === null || existing === '') {
    return managedPrePush();
  }
  if (existing === GIT_PRE_PUSH) {
    // Legacy specgit install without markers: upgrade in place.
    return managedPrePush();
  }
  const lines = existing.split('\n');
  const { firstPair, isMarkerLine } = pairMarkerLines(
    lines,
    (line) => line.trim() === PRE_PUSH_START,
    (line) => line.trim() === PRE_PUSH_END
  );
  if (firstPair !== null) {
    const trailing = nonMarkerLines(lines, { from: firstPair.end + 1, to: lines.length }, isMarkerLine);
    return prependPrePushGuard([
      ...nonMarkerLines(lines, { from: 0, to: firstPair.start }, isMarkerLine),
      ...trailing,
    ].join('\n'));
  }
  // An unmarked install carrying the specgit signature line is a legacy
  // specgit guard from ANY earlier generation (#343): byte-equality with
  // one frozen historical body would leave every other generation
  // misread as a user hook and double-guarded. The signature line is
  // generator-exclusive, so this is proven ownership, not a guess.
  if (lines.some((line) => line === GIT_PRE_PUSH_SIGNATURE)) {
    return managedPrePush();
  }
  const remainder = lines.filter((line) => !isMarkerLine(line)).join('\n');
  if (remainder === '') {
    return managedPrePush();
  }
  return prependPrePushGuard(remainder);
}

/** Keep the user's interpreter, arguments, cwd and stdin; run the guard first. */
function prependPrePushGuard(userContent: string): string {
  const lines = userContent.split('\n');
  const shebang = lines[0]?.startsWith('#!') ? lines.shift()! : '#!/bin/sh';
  if (!/^#!\s*(?:\S*\/)?(?:sh|bash|dash|ksh|zsh)(?:\s.*)?$/.test(shebang) &&
    !/^#!\s*\/usr\/bin\/env\s+(?:-S\s+)?(?:sh|bash|dash|ksh|zsh)(?:\s.*)?$/.test(shebang)) {
    throw new Error('The existing pre-push hook is not a supported shell script; preserve it and compose SpecGit through your hook manager before retrying init.');
  }
  return `${shebang}\n${managedPrePushRegion()}${lines.join('\n')}`;
}
