# SpecGit Workflow Guide — 从零到验收的完整流程

This guide is the canonical walkthrough: what to do first, what to do next,
and how agents drive the same loop. Language note: prose is English-first
elsewhere in these docs; this file keeps Chinese narrative with English
commands/terms so both humans and agents can follow it verbatim.

---

## 0. 前置条件（每台机器，一次性）

| 依赖 | 检查命令 | 说明 |
|---|---|---|
| Node ≥ 20.19 | `node --version` | CLI 运行时 |
| git | `git --version` | 本地证据来源 |
| `gh` CLI 已认证 | `gh auth status` | GitHub 证据来源（issues/PR/checks） |

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

`doctor` 探测 git / repo / origin / gh / policy 五项，任何一项不对都会
fail-closed 并给出 fix 提示。

---

## 1. 仓库初始化（每个仓库，一次性）

```bash
specgit init --required-check "Test (linux-bash)" --required-check "Lint & Type Check" --json
```

- 产出 `spec_git/policy.yaml`：列出本仓库 PR 必须 passing 的 CI check 名。
- Check 名必须与 CI 矩阵里的 job `name:` **完全一致**（含空格、括号、大小写）。
- 自动检测（规划中，见 issue #3）：无参时从 `.github/workflows/*.yml` 与
  `.gitlab-ci.yml` 静态发现 check 名。
- `--force`：policy 已存在时强制重建（默认报 `policy_exists` 拒绝）。
- 把 `spec_git/policy.yaml` 提交进仓库（走 change 流程或首次引导提交）。

---

## 2. 单次交付的标准流程（人类视角）

一次 delivery = 一个 change = 绑定三元组的完整生命周期。

### Step 1 — 建 issue（WHY）

```bash
gh issue create --title "..." --body "## Why ... ## Scope ... ## Acceptance ..."
```

Issue 是交付的 WHY 载体。一个交付可以对应 N 个 issue。

### Step 2 — 建分支（或 worktree）

```bash
# 分支模式
git switch -c feat/<issue#>-<slug>

# worktree 模式（并行交付互不干扰）
git worktree add ../<repo>-<issue#>-<slug> -b feat/<issue#>-<slug>
cd ../<repo>-<issue#>-<slug>
```

分支命名约定 `<type>/<issue#>-<slug>`（feat/fix/docs/chore/...）。
`bind` 从**活体 git** 读上下文——在哪个分支/worktree 上运行就绑定哪个。

### Step 3 — 开发（TDD）

按 `workflows/specgit-dev-loop.md` 的切片纪律：
红测 → 最小绿 → mutation（回退必红）→ 定向测试 + typecheck → commit。

### Step 4 — 开 PR 并绑定

```bash
git push -u origin feat/<issue#>-<slug>
gh pr create --title "..." --body "Closes #<N>

## What / Why / Evidence"
# PR body 必须为每个绑定 issue 写 closing 引用（Closes #N / Fixes #N）

specgit bind --delivery <kebab-id> --issue <N> [--issue <M>...] --pr <PR#> --json
git add .specgit.yaml && git commit -m "chore: record delivery binding" && git push
```

- `.specgit.yaml` 是交付记录，随分支一起版本化。
- 一个 PR 可绑定 N 个 issues（`--issue` 可重复）。
- `--delivery` id 首次绑定后不可变；后续增量用 `specgit bind --issue <M>`。

### Step 5 — 验收

```bash
specgit accept --json
```

10 道门禁全部从真实 git/PR/CI 证据推导：

1. `record` / 2. `policy` / 3. `completeness` / 4. `context` / 5. `origin`
6. `provider` / 7. `issues` / 8. `pr` / 9. `closing`（PR body 覆盖所有 issue）
10. `checks`（policy 里的每个 check 在 PR head 上 success）

退出码契约：

| exit | 含义 | 动作 |
|---|---|---|
| 0 | accepted | 全绿，可合并 |
| 1 | rejected | 事实性失败：按 `failures[].fix` 逐条修 |
| 2 | usage | 参数错误 |
| 3 | unknown | 证据不可得（gh 未认证/网络）——修环境，绝不改记录 |

`checks_pending`：CI 还在跑 → `gh pr checks <PR> --watch` 后重试。

### Step 6 — 合并

- 人工检查点 **push right**：唯一一次人审 = 读 PR brief（what/why/issue+PR+CI
  链接 + `specgit accept` 裁决），批准合并。
- 机器裁决先行：**verdict ≠ accepted 的 PR 不允许合并**。

### Step 7 — 收尾

```bash
git switch main && git pull            # 回主干
gh issue view <N>                      # issue 已被 Closes 自动关闭
specgit status                          # main 上无绑定（正常态）
```

---

## 3. Agent 视角（在 AGENT 里怎么做）

Agent 与人类走同一条流程，差异只在驱动者是模型。三层接入：

### 3.1 Skills（能力层）

安装到 agent 的 skills 目录（如 `~/.agents/skills/`）：

| Skill | 职责 |
|---|---|
| `specgit-setup-policy` | 初始化 `spec_git/policy.yaml`（读 CI workflow 推导 check 名） |
| `specgit-bind-delivery` | 从活体 git 创建/更新 `.specgit.yaml`，补 PR body closing 引用 |
| `specgit-accept-delivery` | 跑 accept、按 failures[].fix 修复循环、产出合并 brief |

### 3.2 OpenCode commands（触发层）

本仓库 `.opencode/command/` 提供：

- `/specgit-setup` — 一次性 policy 初始化
- `/specgit-bind` — 绑定交付（分支上运行）
- `/specgit-accept` — 验收 + 修复循环 + 合并 brief
- `/specgit-status` — 本地证据速览

### 3.3 Agent 的标准作业循环

```
触发：新 issue 被认领 / 用户指派交付
  1. 读 issue（WHY/Scope/Acceptance）
  2. git switch -c <type>/<issue#>-<slug>（或 worktree）
  3. TDD 切片循环（红→绿→mutation→门禁→commit）
  4. push + gh pr create（body 含 Closes #N）
  5. specgit bind --delivery ... --issue ... --pr ...
  6. 提交 .specgit.yaml
  7. specgit accept --json
     ├─ exit 0  → 输出 PR brief（含 issue/PR/CI run 链接），请人批准合并
     ├─ exit 1  → 读 failures[].fix → 修复 → 回到 7
     └─ exit 3  → 报告环境问题（gh auth/网络），不动代码
  8. 人批准 → gh pr merge → issue 自动关闭
```

**铁律（agent 必须遵守）**：

- 验收只认证据：任何 spec/task/计划文件的内容都不能改变 verdict。
- `spec_git/policy.yaml` 不许为了让 verdict 通过而削弱——check 名写错走
  reviewed change 修。
- verdict 非 accepted 的 PR 永远不请求合并、不自行合并。
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
