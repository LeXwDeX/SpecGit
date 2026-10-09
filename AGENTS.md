# Repository Guidelines

SpecGit 2 is a Rust library and native CLI for specification Issues, native PR/MR
aggregation and observation. GitHub/GitLab owns CI, protection and merge.

## Structure

- `runtime/src/`: typed library, CLI and forge/host adapters.
- `runtime/tests/`: public command and real subprocess regression tests.
- `runtime/schemas/` and `runtime/REFERENCE.md`: native declarations and contract.
- `runtime/distribution/`: native installation, signed ZIP release and validation.
- `runtime/scripts/`: resumable compilation and installed-runtime qualification.
- `scripts/`: repository metadata and workflow security checks using Node.

The v1 TypeScript runtime, tests, packaging and acceptance controller are retired.
Historical docs do not authorize running their old commands.

## Delivery

Load the specgit-native skill. Read `.specgit.yaml` and discover the installed
contract with `specgit --help` and `specgit --schema`. Search for duplicate Issues
and select complete Why / Scope / Approach / Acceptance specifications before
tracked edits. Preview Issue/PR writes with `--dry-run`, preserve native IDs and
all closing references, and use `--json` as the machine interface.

Target `main`, use Conventional Commit prefixes and the PR template. Use
`pr --status` and bounded `watch` for current evidence. Native gh/glab merge,
closure and publication operations require existing user authorization.
The declaration records preferences and grants no permission. Complete only
after current-head checks, confirmed target merge and every associated Issue
closure. Never weaken platform protection or skip required verification.

## Self-hosting and local integration

Use one shared user-level SpecGit binary for operational work in all repositories
and worktrees. Resolve `command -v specgit` and confirm `specgit --human --version`;
do not install an operational CLI copy inside a project. Isolated build and
installed-runtime qualification artifacts are test outputs, not PATH replacements.
Initialize each participating project with `specgit init`.

SpecGit integration is permanently project-only. No global agent setup, host
assets or observation state is supported. Project hooks reference the shared
installed CLI directly. Official OpenCode gets only project guidance and Skill;
use `--opencode-claude-hooks` only on a custom OpenCode supporting that protocol,
and verify real blocking/context delivery after installation.

Read-only audits need no Issue checkpoint. Product edits need a complete selected
Issue; documentation follows the short path below and any installed hook's
checkpoint requirement. Codex/Claude hooks and `specgit guard --install` enforce
local context while preserving existing user hooks. A checkpoint belongs to its
original branch/worktree; use a new worktree for independent work.

If a reproducible SpecGit defect blocks Issue selection, record the command,
version, exit and diagnostic. Under existing authorization, use authenticated
native gh/glab to search duplicate WHYs and create/read back a complete Issue;
resume SpecGit with the exact native ID when possible. Only if that same defect
still blocks its linked repair may a documented one-task checkpoint bypass be
used, restoring the normal check after repair. This does not bypass forge
protection, verification, review or publication gates.

Differing existing PR/MR bodies are preview-only in 2.2. Review a `--dry-run`, edit
on the native platform with concurrent-change review, then refresh `pr --status`.
See the [native reference](runtime/REFERENCE.md) for recovery and boundaries.

## Verification

For README, Wiki and manual guidance use the [documentation short path](docs/ci-scope.md#documentation-short-path):
one relevant content review and `node scripts/ci-metadata-check.mjs`.

For product changes use the pinned Rust toolchain in `runtime/rust-toolchain.toml`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node scripts/ci-metadata-check.mjs
cd runtime
cargo fmt --all --check
cargo clippy --locked --all-targets --features test-fixtures -- -D warnings
cargo test --locked --all-targets --features test-fixtures
```

Run relevant native distribution tests when changing installation or release.
CI verifies Linux x64, macOS arm64 and Windows x64 source and installed journeys
on GitHub-hosted standard Linux, macOS ARM64 and Windows runners. `Required verification` aggregates the applicable jobs;
`SpecGit Acceptance` requires its success and a ready PR targeting main.
Publishing is a separate explicitly dispatched signed GitHub Release workflow.

Preserve unrelated dirty files and local artifacts. Prefer MCP graph discovery,
check coverage for evidence paths, and read source when results are stale or
missing. Use current-head and installed/runtime evidence for claims.

<!-- specgit:v2:start -->
## SpecGit 2

Runtime: 2.6.0. Declaration: `.specgit.yaml` (v2, local configuration).

SpecGit 管理规格 Issue 与原生 PR/MR 关联。
加载 specgit-native skill，读取完整流程和恢复步骤。
以共享 CLI 的 `specgit --help` 和 `specgit --schema` 为已安装命令契约。
机器输出用 `--json`。Issue/PR 写入先用 `--dry-run` 预览。

选择 Issue 前先查重。
修改已跟踪的产品代码前，选择一个包含原因、范围、方案和验收要求的相关完整 Issue。
只读检查、审计和评审不需要 Issue checkpoint。
纯文档工作按仓库自己的文档流程处理，并满足已安装 hook 的 checkpoint 要求。
本地 init/setup 属于维护，不是交付。不授予 forge 写入权限。

Issue/PR 写入（包括将请求标记为 ready）需要已有用户授权。
会话已有授权在其范围内持续有效。
声明和 `--dry-run` 预览都不产生授权。
Hook 通知只说明变化，不授予写入权限。
Agent 负责判断、修复和已授权的原生 gh/glab 操作。
GitHub/GitLab 负责 CI、评审、保护和实际合并。
保留用户正文和全部关闭引用。

通过 `specgit pr --status` 和有界 `specgit watch` 获取当前证据。
退出码 0 表示操作成功。交付完成须原生回读确认目标分支合并及全部选定 Issue 关闭。
Agent 补关默认禁用，执行时仍需已有授权和已确认的原生身份。
能力缺失或 SpecGit 故障时，按 skill 的明确恢复步骤处理。

先正常尝试 SpecGit inspect/dry-run。
若可复现的 SpecGit 缺陷阻碍 Issue 选择，记录命令、版本、退出码与诊断。
在已有用户授权下，用已认证的原生 gh/glab 查重 WHY，选择包含原因、范围、方案和验收要求的完整 Issue，并回读其原生 ID 和正文。
只有同一缺陷仍阻碍其关联修复时，才允许使用有文档记录的单任务本地 checkpoint 例外；修复后恢复正常检查。
这不会绕过用户授权、forge 保护、CI、评审、合并、Issue 关闭或发布。

SpecGit 集成永久仅限项目级。
共享 CLI 单独安装。Setup 不安装项目内二进制、全局宿主资产或全局状态。
Hooks 与观察状态属于当前项目及其 Git 元数据。
已安装 hook 检查本地 checkpoint。它不是通用的文件写入沙箱。

Declared rules: `{"agent":{"close_issues_after_merge":false,"native_auto_merge":false},"issue_template":"builtin","language":"zh","pr_template":"builtin","validation":{"bodies":false,"labels":"off","titles":false}}`
<!-- specgit:v2:sha256 dd9bcb3847eaa1e75c7b58d6f3fb32645fe3531ffd4ca1b4f43f2253859bfc65 -->
<!-- specgit:v2:end -->
