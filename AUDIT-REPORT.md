# SpecGit 审计优化报告

> 审计维度：产品使用与体验 → 架构设计 → 代码设计
> 第一优先原则：**Harness 优先** —— 评估 SpecGit 作为「delivery binding + acceptance harness」，能否让大模型 / agent 的开发变得更顺畅。
> 审计日期：2026-08-21

---

## 0. 执行摘要（TL;DR）

SpecGit 是一个成熟度很高的 agent 交付脚手架。其核心公理——`Evidence<T>` 统一返回、fail-closed 裁决、退出码即契约、`--json` 单文档机器面、确定性生成——**在架构与代码两个层面都对 agent 自动化高度友好**，达到优秀水平（无 Critical 问题）。

真正拖慢「大模型开发顺畅度」的短板不在内核，而在 **agent 使用面（surface）的覆盖不足**：agent 只被引导了 `issue` 和 `finish` 两条路径，而实际交付中必然遇到的 `doctor`（exit 3 诊断）、`pr`（绑定修复）、以及 **draft PR → ready for review** 这一必经中间步骤，都没有确定的 skill / 指引。这迫使 agent 在非 happy-path 时回退到读文档、试错，增加 token 消耗与失败率。

**优先修复清单（按 harness 收益排序）：**

| 优先级 | 项 | 收益 |
|---|---|---|
| P0 | Draft PR → ready 的指引缺失（`pr_draft` 必败但无提示） | 消除最高频的一次性失败 |
| P0 | `setup` 仅装 issue+finish，缺 doctor/pr/status entry | 让 agent 在 exit 3 / 绑定断裂时有确定自修复路径 |
| P1 | `doctor` probe 失败不返回 `fix` 字段 | 让诊断结果对 agent 可直接消费 |
| P1 | `GitHubProvider` 命名跨 GitLab 使用 + `src/github` 双重角色 | 降低 agent/新人导航 codebase 的认知成本 |
| P2 | `init.ts` 过胖（849 行）、ESLint 关闭 `no-explicit-any` | 提升可维护性与类型安全反馈 |

---

## 1. 产品使用与体验（Harness 优先视角）

### 1.1 现状亮点

- 十条命令契约稳定（`src/cli/index.ts`），人类主流程 `issue → finish` 极简，且 `issue` 幂等可恢复（positional resume、识别 merged 记录拒绝盲目 resume，见 `src/cli/commands/issue.ts`）。
- 退出码语义清晰（`src/cli/exit-codes.ts`：0/1/2/3/130），fail-closed 严格（`src/acceptance/evaluate.ts`，任一 evidence-kind 失败即 `unknown`）。
- `--json` 机器面干净：stdout 恰好一个 JSON 文档、人类文本走 stderr、递归 sanitize 防注入（`src/cli/output.ts`），并有合约测试锁定（`test/specgit-cli/contract.test.ts`）。
- 语言可配置（en|zh）而机器契约始终不本地化（`src/i18n/language.ts` + `test/specgit-cli/language.test.ts`）。

### 1.2 问题与优化建议

| 编号 | 严重度 | 问题 | 证据 | 优化建议 |
|---|---|---|---|---|
| P-1 | **High** | Draft PR → `finish` 必败，skill/managed block 未提醒 agent 先 `gh pr ready` | `src/acceptance/evaluate.ts`（`pr_draft` factual failure）；`skills/specgit-finish/SKILL.md` | 在 `specgit-finish` SKILL 的 Steps 中加一步「finish 前确认 PR 非 draft」；并在 `pr_draft` 的 `fix` 字段附 `gh pr ready <n>` 示例 |
| P-2 | **High** | `specgit setup` 仅安装 issue+finish 两个 entry，缺 doctor/pr/status | `src/cli/agent-surface.ts`（仅 OPENCODE_COMMANDS + GENERIC_SKILLS 两对） | 扩展 setup 安装 `specgit-doctor`（exit 3 诊断循环）与 `specgit-pr`（绑定修复）skill/command |
| P-3 | **High** | agent 遇到 exit 3 无对应 skill 指引诊断循环 | `src/cli/agent-surface.ts` | 同 P-2，补 doctor skill |
| P-4 | **High** | managed block 缺少 draft→ready 修复路径 | `src/cli/harness-assets.ts` | 在 managed block「Finish」小节前加一条：draft PR 恒失败 + 修复命令 |
| P-5 | **Medium** | `doctor` probe 失败不带 `fix` 字段，agent 无法从 JSON 拿到修复建议 | `src/cli/commands/doctor.ts`（`errorDiagnostic(probe.code ?? 'probe_failed', ...)` 无 fix） | 将 `src/acceptance/codes.ts` 中对应 code 的 `fix` 透传到 diagnostic |
| P-6 | **Medium** | `issue` 标题必须 conventional type 前缀，agent 不易提前获知列表 | `src/cli/commands/issue.ts`（`validateIssueTitles`） | 在 `--help` 与 SKILL 中列出全部支持的 type |
| P-7 | **Medium** | envelope 缺顶层 numeric `exit` 字段（仅 verdict 内有） | `src/cli/output.ts` | envelope 顶层增加 `exit: number`，与 `status` 并存 |
| P-8 | **Medium** | `setup` 的 `--json` 不输出结构化 `assets` | `src/cli/commands/setup.ts`（仅设 `human`） | `--json` 下输出 `assets: { tool, installed:[...] }` |
| P-9 | **Medium** | `status` 对 `record_missing` 返回 exit 3，语义模糊（"尚未绑定"≠"出错"） | `src/cli/commands/status.ts` | 考虑 exit 0 + state `unbound`，或在 envelope 加 `phase: "pre-binding"` 提示 |
| P-10 | **Medium** | `docs/agent-contract.md` 不随 `init` 安装到 adopter 仓库 | `docs/agent-contract.md`（仅源码仓文档） | 将核心铁律摘入 managed block，或 init 时复制到 adopter `docs/` |
| P-11 | Low | `pr_not_found` 在 `pr.ts` 与 `codes.ts` 中 fix 文案不一致 | `src/cli/commands/pr.ts` vs `src/acceptance/codes.ts` | 统一文案来源 |
| P-12 | Low | zh managed block 与英文 error/fix 混合语言 | `harness-assets.ts` vs `codes.ts` | 在 zh block 注明「诊断信息恒为英文，属机器契约」 |

---

## 2. 架构设计

### 2.1 现状亮点

- **三层文件模型分层清晰无泄漏**：authoritative（`spec_git/policy.yaml`、`.specgit.yaml`、`spec_git/providers.yaml`，Zod strict 守护）/ derived harness（`init --force` 确定性重生成，anti-drift 测试锁）/ local assets（永不作为 acceptance 输入）。
- **Provider seam 优秀**：`GitHubProvider`（`src/github/port.ts`）与 `GitPort`（`src/gitfacts/port.ts`）均以 `satisfies Record<keyof X, true>` 做编译时成员完整性守护；`src/providers/routing.ts` 按 `RepoRef.platform` marker 分发 + 延迟构建 + memoization。
- **no-REST / no-token 约束由架构强制**：所有平台通信只经 `gh`/`glab` CLI（`src/providers/cli-spawn.ts` 用 `execFile`），全 `src/` 无 HTTP client、无 token 存储/日志。
- **依赖方向为单向树形无环**：`kernel` 在底，`cli` 为组合根（`src/cli/wiring.ts`）。
- **契约测试三重守护 seam**（`test/specgit/provider-port-contract.test.ts`）：成员清单导出 + 运行时实现校验 + 别名引用相等 + 文档同步。

### 2.2 问题与优化建议

| 编号 | 严重度 | 问题 | 证据 | 优化建议 |
|---|---|---|---|---|
| A-1 | **Medium** | `GitHubProvider` 命名在 GitLab 语境下语义混淆（`GlabProvider implements GitHubProvider`），增加 agent 认知负担 | `src/github/port.ts`、`src/providers/gitlab/glab-cli.ts` | 重命名为 `ForgeProvider`/`PlatformProvider`，用类型别名保持兼容 |
| A-2 | **Medium** | `src/github/` 同时承担 port 定义与 legacy 别名双重角色，新人易困惑 | `src/github/port.ts`（规范）vs `src/github/gh-cli.ts`（别名） | 将 port 提取到 `src/ports/forge.ts`，使 `src/github/` 降为纯别名目录；或在 CONTRIBUTING 标注迁移时间线 |
| A-3 | **Medium** | port 14 方法全 mandatory，新平台即使只做 issue+PR 也必须实现 protection/auto-merge | `src/github/port.ts` | 记为设计笔记；第三平台出现时拆分 `ReadPort` / `AdminPort` |
| A-4 | **Medium** | GitLab 版本窗口极窄（`>= 19.2.4 < 19.3.0`），每次小版本升级需 rebaseline delivery | `src/providers/gitlab/glab-cli.ts`（硬编码常量） | 有意的稳定性取舍；在 `docs/gitlab-support.md` 补自动 rebaseline SOP |
| A-5 | Low | `wiring.ts` 中重复 `discoverRepoRoot`，理论 TOCTOU | `src/cli/wiring.ts` | `createDefaultContext` 中一次性 resolve root + policy/providers 并缓存注入 |
| A-6 | Low | `SpawnFn`/`SpawnOptions` 在 gitfacts 与 providers 各定义一套 | `src/gitfacts/port.ts`、`src/providers/cli-spawn.ts` | 在 `src/kernel/` 定义统一 `SpawnContract` |
| A-7 | Low | `RepoRef.platform` 为可选字面量而非 union，扩展第三平台需重构 | `src/gitfacts/origin.ts` | 改为非可选 union，routing 用 exhaustive switch 防遗漏 |
| A-8 | Low | `GlabProvider.getCheckRuns` 对每 pipeline 串行分页，大仓库 N*M 调用 | `src/providers/gitlab/glab-cli.ts` | pipeline list 阶段加 `updated_at` 排序 + 时间窗裁剪 |

---

## 3. 代码设计与测试

### 3.1 现状亮点（客观证据）

- 质量基线全绿：TypeCheck（src + test）0 error、ESLint 0 warning、**842 passed / 1 skipped**、测试/源码比 **1.48:1**。
- `Evidence<T>`（`src/kernel/evidence.ts`，仅 13 行）+ 39 个具名诊断码（`src/acceptance/codes.ts`，`kind`/`message`/`fix` 三元组）构成 agent 可靠消费 CLI 输出的基础。
- 依赖注入 + port 模式使测试替身注入路径清晰；三层测试（unit / cli / e2e）+ 进程级 `fake-gh`/`fake-glab` + `MockGitHubProvider` 设计优秀。
- 命名一致（`run<Command>` / `<Command>Options` / snake_case 诊断码），JSDoc 带 issue 引用，对 AI 导航友好。

### 3.2 问题与优化建议

| 编号 | 严重度 | 问题 | 证据 | 优化建议 |
|---|---|---|---|---|
| C-1 | **High** | `init.ts` 849 行、`runInit` 过长，混合 harness 写入/检测/branch protection/providers.yaml 多个关注点 | `src/cli/commands/init.ts` | 拆分为 `detectAndValidate()` / `writeHarnessAndPolicy()` / `setupBranchProtection()`，`runInit` 保留 <100 行编排 |
| C-2 | **High** | ESLint 关闭 `no-explicit-any` 与 `no-unused-vars`，贡献者/agent 可无反馈引入 `any` | `eslint.config.js` | `no-explicit-any` 改 `warn`/`error`；`no-unused-vars` 改 `['error',{argsIgnorePattern:'^_'}]`；清理现有 `any`（<20 处） |
| C-3 | **Medium** | `evaluate.ts` 中 gate 变量命名 `g1`–`g9`，不利搜索理解 | `src/acceptance/evaluate.ts` | 改语义名（`recordOk`/`policyOk`/`completenessOk`…） |
| C-4 | **Medium** | `issue.ts` 单一 `runIssue` ~360 行 | `src/cli/commands/issue.ts` | 提取 resume validation / issue creation loop / PR binding 子函数 |
| C-5 | **Medium** | 测试 helper 大量 `as never` / `as Evidence<never>`，mock 签名与 port 未对齐 | `test/specgit-cli/helpers.ts` | 用 `Partial<GitHubProvider>` + 默认实现对齐签名 |
| C-6 | **Medium** | `CommandOutcome` 12 个 optional 字段，类型无法约束「哪个命令输出哪些字段」 | `src/cli/output.ts` | 按命令区分 outcome 子类型 / 判别联合 |
| C-7 | Low | `evaluate.ts` 用 `{ value: GitFacts \| null }` 模拟可变引用 | `src/acceptance/evaluate.ts` | 改用 `let` + 闭包 |
| C-8 | Low | `fake-gh` 脚本为 73 行内联字符串，无高亮/类型检查 | `test/specgit/helpers/fake-gh.ts` | 抽为独立脚本文件 |
| C-9 | Low | `CommandOutcome.human` 渲染逻辑散布各命令 | 各 command 文件 | 提供统一 human builder |

---

## 4. 跨维度主线结论

三个维度的证据指向同一条主线：**SpecGit 的"内核"（架构 + 代码契约）对 agent 极其友好，但"外壳"（agent 使用面）覆盖不足，是当前拖慢大模型开发顺畅度的首要瓶颈。**

- **内核强**：确定性输出、退出码即契约、`--json` 单文档、fail-closed 无例外、幂等 resume —— agent 无需解析人类文本即可可靠驱动。
- **外壳弱**：agent 只有 issue/finish 两条既定路径；一旦进入 draft→ready、exit 3 诊断、PR 绑定修复等真实中间态，就缺少确定的 skill/指引，被迫试错。
- **导航成本**：`GitHubProvider` 跨平台命名与 `src/github` 双重角色，让 agent 阅读 codebase 时产生可避免的认知负担。

因此，**收益最高的优化是"补全 agent 使用面 + 澄清命名/模块角色"，而非改动内核**。内核应保持稳定。

---

## 5. 落地路线图（建议顺序）

**阶段一（P0，最高 harness 收益，改动小）**
1. `specgit-finish` SKILL + managed block + `pr_draft` fix：补 draft→ready 指引（P-1、P-4）。
2. `specgit setup` 增装 `specgit-doctor`、`specgit-pr` 入口（P-2、P-3）。

**阶段二（P1，可消费性与导航）**
3. `doctor` probe 失败透传 `fix` 字段（P-5）；envelope 顶层加 `exit`（P-7）；`setup --json` 输出 `assets`（P-8）。
4. `GitHubProvider` → `ForgeProvider` 重命名 + `src/github` 角色澄清（A-1、A-2）。

**阶段三（P2，可维护性 / 类型安全）**
5. 拆分 `init.ts`（C-1）；恢复 ESLint 类型规则并清理 `any`（C-2）；gate 变量语义命名（C-3）。

> 说明：每一项落地前都应遵循项目自身的交付纪律（`specgit issue` → TDD → `specgit finish`），且**绝不为通过裁决而弱化 `spec_git/policy.yaml`**。

---

## 附：严重度汇总

- **Critical**：无。
- **High**：P-1、P-2、P-3、P-4（产品使用面）；C-1、C-2（代码可维护性/类型安全）。
- **Medium**：P-5~P-10、A-1~A-4、C-3~C-6。
- **Low**：P-11、P-12、A-5~A-8、C-7~C-9。
