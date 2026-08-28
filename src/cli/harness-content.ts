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
import { waitStepYaml } from './wait-step.js';

const HARNESS_WORKFLOW_SEGMENTS = ['.github', 'workflows', 'specgit-accept.yml'];

export const HARNESS_WORKFLOW_PATH = HARNESS_WORKFLOW_SEGMENTS.join('/');
/** The CI check name the harness workflow contributes; also the check init guards behind branch protection. */
export const ACCEPTANCE_CHECK_NAME = 'SpecGit Acceptance';
export const AGENTS_FILENAME = 'AGENTS.md';
export const CLAUDE_FILENAME = 'CLAUDE.md';
export const BLOCK_START_MARKER = '<!-- specgit:block:start -->';
export const BLOCK_END_MARKER = '<!-- specgit:block:end -->';

export function harnessWorkflowYaml(): string {
  return `name: SpecGit Acceptance

on:
  pull_request:
    branches: [main]
    # A draft PR fails the verdict (pr_draft), so the draft→ready
    # transition must re-verdict. Listing types replaces the defaults,
    # so the default activity types are listed alongside.
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

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
    timeout-minutes: 15
    steps:
      - name: Checkout code
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          # Check out the PR head branch by name so HEAD is on the branch
          # (not the detached merge ref): the execution context gate reads
          # live git. Falls back to the default ref on non-PR events.
          ref: \${{ github.head_ref || github.ref }}
          fetch-depth: 0
          persist-credentials: false

      - name: Setup pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6

      - name: Setup Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '20.19.0'
          # No dependency cache here, by design (#66): this job checks out
          # and executes untrusted PR code (install scripts, build, the CLI
          # under verdict), so it must never write to or restore from the
          # repository cache (CodeQL alerts 7-9). ci.yml keeps the warm,
          # branch-scoped cache.

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build CLI
        run: pnpm run build

${waitStepYaml('rest')}

      - name: specgit finish
        run: node bin/specgit.js finish --json
        env:
          GH_TOKEN: \${{ github.token }}
`;
}

/**
 * The managed guidance block (#118: language-aware). `en` is the
 * pre-#118 text byte-for-byte; `zh` is its Chinese counterpart. The
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

- 用 \`specgit issue <标题或编号>...\` 开始：它会创建或复用议题、建分支、
  开一个预填确定性骨架的草稿拉取请求（每个绑定议题一行 \`Closes #n\`，
  随后是 为什么 / 变更内容 / 证据 / 清单 各节），并写入 \`.specgit.yaml\`。
  重复执行会恢复现场；它是幂等的。
- 议题正文在引导时从对话中填写：\`specgit issue\` 成功后立即用
  \`gh issue edit <n>\` 把讨论出的 为什么 / 范围 / 做法 / 验收 写进它
  创建的每条议题，然后再开始实现。PR 骨架的占位内容仅是建议——随交付
  过程填写即可；关闭引用是正文里唯一的门槛。PR 正文只在创建时写入一次；
  任何 SpecGit 命令都不会修改已存在的 PR 正文，也从不读取仓库自己的
  PR 模板。
- 草稿拉取请求恒使裁决失败（\`pr_draft\`）：在 \`specgit finish\` 之前，
  先把它标为可评审——GitHub 用 \`gh pr ready <number>\`，GitLab 用
  \`glab mr update <number> --ready\`。
- 用 \`specgit finish\` 收尾：裁决来自真实的 git、PR 与 CI 证据。退出码
  0 是唯一的"完成"。

### 修复与诊断

- \`specgit pr\` 修复拉取请求绑定：不带参数时按当前头分支自动发现拉取
  请求，找不到时报错并给出修复办法，找到多个时列出并拒绝。
- \`specgit status\` 只展示本地证据：记录、状态、漂移、origin。
  \`specgit doctor\` 探测 git、仓库、origin、gh 与策略。
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

### 建议题之前，先查重

- 用新标题运行 \`specgit issue\` 之前，先在 tracker 里搜索相近的在办
  工作：用标题关键词做 \`gh issue list\`（状态、标签、检索词用
  \`gh search issues\`）。
- 打开并阅读每一个疑似候选（\`gh issue view <n>\`）——比较 WHY 本身，
  而不是措辞。
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

- **SpecGit 是这里的默认工作方式。** 任何非平凡的任务——新功能、修复、
  重构、文档变更——都是一次交付：工作项作为议题存放在这个 tracker
  里，绝不放进私人任务清单或对话式清单。触发点是“决定开工”的那一刻：
  对话收敛、开始把计划变成变更之时，第一个动作就是
  \`specgit issue <type>: <标题>...\`——先于任何文件编辑。无绑定就动手
  是违反契约，不是风格偏好。引导完成后，立即用 \`gh issue edit\` 把
  讨论中的 为什么 / 范围 / 做法 / 验收 填进每条议题正文，然后再开始
  实现。会话中途的盘点（“让我列出所有要做的事”）也应变成议题，而不是
  聊天产物。平凡的回复与只读提问无需如此。
- 唯一规则：交付完成当且仅当 \`specgit finish\` 退出 \`0\`。绝不凭任务
  清单、文件状态或自己跑过的测试宣布完成。
- 按退出码分支，不按措辞：\`1\` = 证据齐全，修门槛点名的内容；\`3\` =
  证据缺失，先修环境（\`specgit doctor\`）。绝不把退出 \`3\` 当作成功。
- 保持 PR 正文里的 \`Closes #n\` 引用完整；改动 PR 正文、头分支或 CI
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
  the issues, branches, opens the draft pull request pre-filled with a
  deterministic scaffold (the \`Closes #n\` line for every bound issue,
  then Why / What changed / Evidence / Checklist sections), and writes
  \`.specgit.yaml\`. Re-running resumes; it is idempotent.
- Issue bodies are filled at bootstrap, from the conversation: right after
  \`specgit issue\` succeeds, edit each issue it created (\`gh issue edit <n>\`)
  with the discussed Why / Scope / Approach / Acceptance, then implement.
  The PR scaffold's placeholders are advisory — fill those sections in as
  you deliver; the closing references are the only body gate. The PR body
  is written once at creation; no SpecGit command edits an existing PR
  body, and the repository's own pull-request template is never read.
- A draft pull request always fails the verdict (\`pr_draft\`): before
  \`specgit finish\`, mark it ready for review — \`gh pr ready <number>\`
  on GitHub, \`glab mr update <number> --ready\` on GitLab.
- Finish with \`specgit finish\`: the verdict, derived from real git, PR,
  and CI evidence. Exit code 0 is the only "done".

### Issue tags

- Every bootstrap applies the title's \`kind::<type>\` member
  automatically; pass \`--tags <a,b>\` to choose the full set explicitly.
- Selection is pool-first: existing on-spec labels win verbatim; anything
  missing is seeded from the built-in \`kind::\` catalog or the policy's
  \`tags:\` declarations. Unknown vocabulary exits 2 naming the universe.
- Choose with restraint: at most one label per axis, none when unsure —
  off-spec pool labels are reported (\`tag_pool_dirty\` warnings are for
  humans) and never renamed by SpecGit.

### Repair and diagnostics

- \`specgit pr\` repairs the pull-request binding: with no arguments it
  auto-discovers the pull request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- \`specgit status\` shows local evidence only: record, state, drift,
  origin. \`specgit doctor\` probes git, repository, origin, gh, and
  policy.

### The command surface

- Ten commands: \`specgit init\`, \`specgit setup\`, \`specgit issue\`,
  \`specgit pr\`, \`specgit finish\`, \`specgit bind\`, \`specgit unbind\`,
  \`specgit status\`, \`specgit accept\`, \`specgit doctor\`.
- \`specgit setup\` installs the agent entry points (commands for opencode,
  portable skills for other tools); \`specgit bind\`, \`specgit unbind\`,
  and \`specgit accept\` are automation aliases for scripts and CI.

### Before creating an issue, check for duplicates

- Before running \`specgit issue\` with a new title, search the tracker for
  similar open work: \`gh issue list\` with keywords from the title
  (state, labels, and search terms via \`gh search issues\`).
- Open and read every plausible candidate (\`gh issue view <n>\`) — compare
  the WHY, not just the wording.
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

- **SpecGit is the default way of working here.** Any non-trivial
  task — a feature, a fix, a refactor, a docs change — is a delivery:
  work items live in this tracker as issues, never in private task
  lists or conversational checklists. The trigger is the decision to
  start: the moment the conversation settles and you begin turning
  the plan into changes, the FIRST action is
  \`specgit issue <type>: <title>...\` — before any file edit.
  Working without a binding is a contract violation, not a style
  choice. Immediately after bootstrap, fill each issue body
  (Why / Scope / Approach / Acceptance) from the discussion with
  \`gh issue edit\`, then implement. Mid-conversation inventories
  ("let me list everything to do") become issues, not chat
  artifacts. Trivial replies and read-only questions need none of
  this.
- The one rule: a delivery is done if and only if \`specgit finish\`
  exits \`0\`. Never declare completion from task lists, file states, or
  test runs you performed yourself.
- Branch on exit codes, not phrasing: \`1\` = evidence complete, fix what
  the gates named; \`3\` = evidence missing, fix the environment first
  (\`specgit doctor\`). Never present exit \`3\` as success.
- Keep the \`Closes #n\` references in the PR body intact; after changing
  the PR body, head branch, or CI, re-run \`specgit finish\`. Never
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

  if (!Array.isArray(config.PreToolUse)) {
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
    if (ownedEntry.matcher !== GUARD_MATCHER) {
      ownedEntry.matcher = GUARD_MATCHER;
    }
  } else {
    preToolUse.push(specgitEntry);
  }

  return { json: `${JSON.stringify(config, null, 2)}\n` };
}

// Blocks merge/push-main attempts that bypass the evidence verdict, and —
// since #335 — file-mutation tool calls on a branch with no delivery
// binding: the start gate. Bash verbs match only the command's leading
// pattern so prose containing the keywords (e.g. an issue body) never trips
// the guard; the start gate keys off tool_name (edit/write), comparing the
// branch recorded in .specgit.yaml with the current git branch. The merge
// branch is bounded (#68): the verdict runs under a budget derived from the
// configured gh timeout (SPECGIT_GH_TIMEOUT_MS) and never below it; budget
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
      echo "specgit: start gate - this branch has no delivery binding. Start the delivery first: specgit issue \\"<type>: <title>\\", then fill each issue body from the discussion, then edit files." >&2
      exit 2
    fi
    exit 0
    ;;
esac
command=\$(printf '%s' "\$payload" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j.tool_input&&j.tool_input.command)||'')}catch{process.stdout.write('')}})")

case "\$command" in
  gh\\ pr\\ merge*)
    exec node -e '
      const { spawn } = require("child_process");
      const fs = require("fs");
      const path = require("path");
      const ghMsRaw = parseInt(process.env.SPECGIT_GH_TIMEOUT_MS || "", 10);
      const ghMs = Number.isFinite(ghMsRaw) && ghMsRaw > 0 ? ghMsRaw : 15000;
      const ghS = Math.max(1, Math.floor(ghMs / 1000));
      let budgetS = Math.max(60, ghS * 8);
      const overrideRaw = parseInt(process.env.SPECGIT_GUARD_BUDGET_S || "", 10);
      if (Number.isFinite(overrideRaw) && overrideRaw > 0) {
        budgetS = Math.max(overrideRaw, ghS);
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
            "specgit: merge blocked - no verdict possible (evidence incomplete, exit " + code + "). This is not a rejection: fix evidence gathering (network, gh auth), then retry."
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
  git\\ push\\ origin\\ main*|git\\ push\\ origin\\ +main*|git\\ push\\ origin\\ HEAD:main*)
    echo "specgit: direct push to main is not the delivery path. Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge." >&2
    exit 2
    ;;
esac
exit 0
`;

export { GUARD_SCRIPT };

// Local git-layer guard: refuses direct pushes to main; deliveries must go
// through PR + CI + specgit finish. The managed file wraps this BODY in
// SPECGIT_PRE_PUSH_MARKERS so an existing user hook is merged, not
// replaced (#62) — and keeps the shebang on line 1, ahead of the start
// marker, because git on Windows execs the hook directly and cannot
// spawn a file whose first line is a plain comment (#67 matrix,
// windows-pwsh: "cannot spawn ... pre-push: Exec format error").
const GIT_PRE_PUSH_BODY = `# SpecGit pre-push guard (managed by specgit init).
while read -r local_ref local_sha remote_ref remote_sha; do
  case "\$remote_ref" in
    refs/heads/main)
      echo "specgit: direct push to main is not the delivery path." >&2
      echo "Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge." >&2
      exit 1
      ;;
  esac
done
exit 0
`;

// The pre-#62 unmarked install: shebang + body, no markers.
const GIT_PRE_PUSH = `#!/bin/sh
${GIT_PRE_PUSH_BODY}`;

const PRE_PUSH_START = '# >>> specgit:start >>>';
const PRE_PUSH_END = '# <<< specgit:end <<<';

/** The marker-delimited guard region (no shebang of its own). */
function managedPrePushRegion(): string {
  return `${PRE_PUSH_START}\n${GIT_PRE_PUSH_BODY}${PRE_PUSH_END}\n`;
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
 * - markers present: only the delimited region is replaced;
 * - anything else (a user hook, e.g. husky): preserved verbatim with
 *   the managed region appended after it.
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
    if (firstPair.start === 0) {
      // Old managed layout: the marker was line 1 and the shebang sat
      // inside the region. Rebuild in the spawnable layout, keeping any
      // user content that trails the managed region — the wholesale
      // replacement used to delete it (#88-3).
      return [managedPrePush().trimEnd(), ...trailing].join('\n');
    }
    return [
      ...nonMarkerLines(lines, { from: 0, to: firstPair.start }, isMarkerLine),
      managedPrePushRegion().trimEnd(),
      ...trailing,
    ].join('\n');
  }
  const remainder = lines.filter((line) => !isMarkerLine(line)).join('\n');
  if (remainder === '') {
    return managedPrePush();
  }
  const separator = remainder.endsWith('\n') ? '' : '\n';
  return `${remainder}${separator}${managedPrePushRegion()}`;
}
