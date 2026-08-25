# SpecGit Workflow Guide — 从零到验收的完整流程

This guide is the canonical walkthrough: what to do first, what to do next,
and how agents drive the same loop. Language note: prose is English-first
elsewhere in these docs; this file keeps Chinese narrative with English
commands/terms so both humans and agents can follow it verbatim.

```text
  specgit init / setup     每仓库一次：policy + 验收 harness + agent 入口点
        |
        v
  specgit issue "..."      每次交付：issues + 分支 + draft PR（Closes #n）
        |                  + 绑定记录，提交并推送（失败重跑同命令即续）
        v
  开发、commit、push -----> PR head 上跑 CI
        |                  （SpecGit Acceptance job 即 specgit finish --json）
        v
  gh pr ready <n>          draft PR 必然不通过验收（pr_draft）
        |
        v
  specgit finish           裁决：十一道门禁，fail-closed
        |-- exit 0 --> 合并：完成（exit 0 是唯一的 done）
        |-- exit 1 --> 按门禁点名的项修复（证据已完整）
        '-- exit 3 --> 先修环境（specgit doctor）
```

---

## 0. 前置条件（每台机器，一次性）

| 依赖 | 检查命令 | 说明 |
|---|---|---|
| Node ≥ 20.19 | `node --version` | CLI 运行时 |
| git | `git --version` | 本地证据来源 |
| `gh` CLI 已认证 | `gh auth status` | GitHub 证据来源（issues/PR/checks） |
| `glab` CLI 已认证（仅声明式 GitLab origin） | `glab auth status --hostname <host>` | GitLab 证据来源（issues/MR/pipelines），≥ 1.113.0 |

安装 CLI（发布后）：

```bash
npm install -g specgit
# 或开发模式：在本仓库内
pnpm install && pnpm run build
ln -sf "$PWD/bin/specgit.js" ~/.local/bin/specgit
```

一键体检：

```bash
specgit doctor --json
```

`doctor` 按 git → repo → origin → provider CLI 在位 → provider CLI 已认证
→ policy 的顺序探测六项，任何一项不对都会 fail-closed 并给出 fix 提示。

---

## 1. 仓库初始化（每个仓库，一次性）

```bash
specgit init --required-check "Test (linux-bash)" --required-check "Lint & Type Check" --json
```

- 产出 `spec_git/policy.yaml`：列出本仓库 PR 必须 passing 的 CI check 名。
- Check 名必须与 CI 矩阵里的 job `name:` **完全一致**（含空格、括号、大小写）。
- 自动检测（已上线，#63）：无参时从 `.github/workflows/*.yml`（GitHub 模式）
  静态发现 check 名；仓库完全没有 CI 时 policy 为空列表——分支保护强制
  的验收 job 本身就是门。GitLab 模式检测 `.gitlab-ci.yml` 顶层 job 名。
- `--force`：policy 已存在时重建 harness 与全部生成资产；既有
  `required_checks`/`language` 默认**原样保留**（#310）——只有显式传
  `--required-check` 才整体替换该列表。不带 `--force` 的重跑报
  `policy_exists` 拒绝（exit 2，零写入）。
- `spec_git/policy.yaml` 默认被 init 写入的 `.gitignore` 托管块屏蔽（#292）；
  它进入 git 的正规路径是交付引导的绑定提交——手动提交需 `git add -f`
  越过屏蔽，或 init 时用 `--no-ignore` 保持经典提交模型。

---

## 2. 单次交付的标准流程（人类视角）

一次 delivery = 一个 change = 绑定三元组的完整生命周期。
命令故事是 **issue → finish**：一条命令开始，一条命令裁决。

### Step 1 — 一键引导：`specgit issue`

```bash
specgit issue "feat: add login" "Harden the session model" --json
```

一个参数 = 一个独立可验证的 WHY：

- 带引号的文本 → 新建 issue（标题必须 `<type>: <标题>` 前缀，type 走固定白名单；标题正文任意语言（#118），产不出 ASCII slug 时要求 `--delivery <slug>`）；
- 纯数字 → 复用已有 issue。

N 个参数 = N 个 issue 绑进 **同一个** 交付（1 PR : N issues）。
该命令依次完成：创建/复用 issues → 建分支 `<type>/<first#>-<slug>`
（type 取自首个标题的 conventional 前缀，默认 feat；slug 取前三个
ASCII 单词；标题产不出 slug 时绝不静默造名——交互终端会反问一个
kebab-case 交付名，脚本环境报 `issue_delivery_name_required` 并指向
`--delivery <slug>`）→ 开 draft PR（body 自动写
`Closes #n`，覆盖每个 issue）→ 写 `.specgit.yaml` → commit → push。

**幂等续跑**：任何一步之间失败后，重跑同一条命令即恢复——已完成的
步骤（记录里的 issues → 分支 → PR → commit → push）会被检测并跳过，
不会重复建 issue、不会重复开 PR。无参数且无记录时退出 2（CLI 不交互）。

### Step 2 — 开发（TDD）

按 `workflows/specgit-dev-loop.md` 的切片纪律：
红测 → 最小绿 → mutation（回退必红）→ 定向测试 + typecheck → commit。
分支与 draft PR 已在 Step 1 就位，直接在其上工作、push。

### Step 3 — 验收

```bash
specgit finish --json
```

11 道门禁全部从真实 git/PR/CI 证据推导：

1. `record` / 2. `policy` / 3. `completeness` / 4. `context` / 5. `origin`
6. `provider` / 7. `issues` / 8. `sequence` / 9. `pr` / 10. `closing`（PR body 覆盖所有 issue）
11. `checks`（policy 里的每个 check 在 PR head 上 success）

`spec_git/policy.yaml` 已由 `specgit init` 声明的 required checks 与
`.github/workflows/specgit-accept.yml` 里的 **SpecGit Acceptance** job
（跑 `specgit finish --json`）共同构成物理 CI 门禁。

退出码契约：

| exit | 含义 | 动作 |
|---|---|---|
| 0 | accepted | 全绿，可合并 |
| 1 | rejected | 事实性失败：按 `failures[].fix` 逐条修 |
| 2 | usage | 参数错误 |
| 3 | unknown | 证据不可得（gh 未认证/网络）——修环境，绝不改记录 |

`checks_pending`：CI 还在跑 → `gh pr checks <PR> --watch` 后重试。

### Step 4 — 合并

- 人工检查点 **push right**：唯一一次人审 = 读 PR brief（what/why/issue+PR+CI
  链接 + `specgit finish` 裁决），批准合并。
- 机器裁决先行：**verdict ≠ accepted 的 PR 不允许合并**。

### Step 5 — 收尾

```bash
git switch main && git pull            # 回主干
gh issue view <N>                      # issues 已被 Closes 自动关闭
specgit status                          # main 上无绑定（正常态）
```

---

## 3. Agent 视角（在 AGENTS 里怎么做）

Agent 与人类走同一条流程，差异只在驱动者是模型。行为来源是
`specgit init` 注入 `AGENTS.md` 的 **specgit 托管块**
（`<!-- specgit:block:start/end -->` 之间的内容，re-init 只重写块内
内容），规范化版本见 [`docs/agent-contract.md`](agent-contract.md)。
`specgit setup` 另行安装本地便利入口点——`.opencode/command/` 命令与
`.agents/skills/` portable skills；它们是便利设施而非第二个行为来源，
也永远不是验收输入。行为契约始终是 CLI 契约 + AGENTS.md 托管块。

### 3.1 Agent 的标准作业循环

```
触发：新 issue 被认领 / 用户指派交付
  1. specgit issue "<type>: <标题>"...        # 一键引导（幂等，失败重跑同命令）
  2. TDD 切片循环（红→绿→mutation→门禁→commit）
  3. push（分支、draft PR、记录都已就位）
  4. specgit finish --json
     ├─ exit 0  → 输出 PR brief（含 issue/PR/CI run 链接），请人批准合并
     ├─ exit 1  → 读 failures[].fix → 修复 → 回到 4
     └─ exit 3  → 报告环境问题（gh auth/网络），不动代码
  5. 人批准 → gh pr merge → issues 自动关闭
```

### 3.2 修复与诊断

- PR 绑定缺失/失准 → `specgit pr`（无参自动按 head 分支发现 PR；
  0 个 → 报错并给 fix；多个 → 拒绝并列出，此时显式 `specgit pr <n>`）。
- 环境疑难 → `specgit doctor --json`（git → repo → origin → gh → auth
  → policy 的探测顺序即排查顺序）。

### 3.3 粒度原则与铁律（agent 必须遵守）

**一个 issue = 一个独立可验证的 WHY。** 交付物无法凭自身证据验证时，
先拆分再绑定。

- 验收只认证据：任何 spec/task/计划文件的内容都不能改变 verdict。
- `spec_git/policy.yaml` 不许为了让 verdict 通过而削弱——check 名写错走
  reviewed change 修。
- `specgit finish` 退出码非 0 的 PR 永远不请求合并、不自行合并。
- `--json` 输出是唯一可靠解析面：stdout 恰好一个 JSON 文档。

### 3.4 Dev loop 规范

完整切片纪律见 [`workflows/specgit-dev-loop.md`](../workflows/specgit-dev-loop.md)；
issue tracker 约定见 [`docs/agents/issue-tracker.md`](agents/issue-tracker.md)。

---

## 4. 多交付并行

- 不同交付 = 不同分支（或不同 worktree）+ 不同 `.specgit.yaml`。
- worktree 模式下，`bind` 记录 worktree label；`accept` 在 accept 时用
  `git worktree list` 重新验证该 label 仍挂在绑定的分支上。
- 每个交付独立 PR、独立验收、独立合并；policy 是仓库级共享的。

## 5. 故障排查

| 症状 | 诊断 |
|---|---|
| `policy_missing` | 先 `specgit init`（Section 1） |
| `gh_unauthenticated` / exit 3 | `gh auth login` |
| `branch_mismatch` | 你不在绑定分支上：`git switch <bound-branch>` |
| `checks_missing` | check 名与 policy 不一致，或 CI 没跑：对照 ci.yml job name |
| `closing_refs_incomplete` | PR body 缺某个 `Closes #N`：补全后重试 |

任何疑难：`specgit doctor --json` 先行。

---

## 参考索引

- CLI 全命令与 JSON 契约：[cli.md](cli.md) · [agent-contract.md](agent-contract.md)
- 概念与名词：[concepts.md](concepts.md) · [glossary.md](glossary.md)
- 安装：[installation.md](installation.md)
- 团队协作：[team-workflow.md](team-workflow.md)
