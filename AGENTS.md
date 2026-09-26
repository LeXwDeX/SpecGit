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
on GitHub-hosted macOS and owner-provided Linux/Windows runners. `Required verification` aggregates the applicable jobs;
`SpecGit Acceptance` requires its success and a ready PR targeting main.
Publishing is a separate explicitly dispatched signed GitHub Release workflow.

Preserve unrelated dirty files and local artifacts. Prefer MCP graph discovery,
check coverage for evidence paths, and read source when results are stale or
missing. Use current-head and installed/runtime evidence for claims.

<!-- specgit:v2:start -->
## SpecGit 2

Repository runtime: 2.1.1. Declaration: `.specgit.yaml` (v2, local configuration).

SpecGit 管理规格 Issue 与原生 PR/MR 关联。加载 specgit-native skill；以 `specgit --help` 和 `specgit --schema` 为已安装命令契约，机器输出用 `--json`，Issue/PR 写入先用 `--dry-run` 预览。实施前先查重，再明确选择包含原因、范围、方案和验收要求的完整 Issue。完成实施并按授权提交、推送后，将选定 Issue 汇聚到一个原生草稿请求，保留用户正文与关闭引用。准备好评审后使用 `specgit pr --ready`。

Agent 监督开发与修复。Codex 和 Claude 的 PreToolUse hook 会解析实际目标仓库与分支；已初始化的 v2 仓库在当前分支缺少完整 Issue checkpoint 时拒绝 tracked edits。对无法可靠分类的 shell 命令不提前阻断，由本地 Git guard 兜底。使用 `specgit guard --install` 安装受管理的 pre-commit/pre-push 检查；保留并调用已有用户 hook。GitHub/GitLab 负责 CI、评审、保护与实际合并。通过 `specgit pr --status` 和有界 `specgit watch` 观察原生状态。退出码 0 只表示操作成功，不表示交付完成；按返回的诊断和恢复动作处理失败。Hook 不授予远端写入权限。

交付完成须原生回读确认目标分支合并及全部选定 Issue 关闭。合并后回读关联 Issue；尚未关闭时通知 Agent。Agent 补关默认禁用；即使启用该偏好，仍须既有授权，并原生回读合并与关闭结果。通过 specgit init --check 查看不支持或未知的原生能力，再明确选择手动观察，或由获授权的管理员配置平台。

Declared rules: `{"agent":{"close_issues_after_merge":false,"native_auto_merge":false},"issue_template":"builtin","language":"zh","pr_template":"builtin","validation":{"bodies":false,"labels":"off","titles":false}}`
<!-- specgit:v2:end -->
