# CLI 参考

## 十条公共命令

| 命令 | 用途 |
| --- | --- |
| `specgit init` | 初始化策略与集成资产；用 `--force` 刷新 |
| `specgit setup` | 安装或刷新 Agent 入口 |
| `specgit issue` | 创建/复用 Issue，开始或恢复交付 |
| `specgit pr` | 修复请求绑定；用 `--merge` 恢复已启用的完成自动化 |
| `specgit finish` | 读取验收与完成证据 |
| `specgit bind` | 脚本级绑定操作 |
| `specgit unbind` | 通过显式重置流程移除本地交付记录 |
| `specgit status` | 查看本地记录、上下文与生成资产状态 |
| `specgit accept` | 验收器的脚本别名 |
| `specgit doctor` | 探测 Git、仓库、origin、平台 CLI/认证与策略 |

人工使用可省略 `--json`。脚本应解析退出码和 JSON 字段，不能抓取人类可读文案。
JSON 模式下 stdout 只有一个文档，诊断提供稳定代码和修复方向。

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功或验收通过；完成状态需另外检查 |
| `1` | 已取得拒绝证据；等待中的检查可能只需稍后重试 |
| `2` | 用法错误 |
| `3` | 缺少必要证据；先执行 `errors[].fix` |
| `130` | 已中断；stderr 为 `Interrupted.`，不输出 JSON envelope |

## 常用选项

- `init`：`--required-check`、`--gitlab-host`、`--language`、`--force`、`--no-protect`。
- 自动化：`--automation yes|no` 和 `--merge-target`；开启必须由用户决定。
- `setup`：`--tool generic|opencode|all`；可移植技能位于 `.agents/skills/`。
- `issue`：`--delivery`、`--body-file`、`--pr-body-file` 和 `--tags`。
- 项目规则：`validation.titles`、`validation.labels`、`validation.bodies`、选定模板及必需章节。

用 `specgit <command> --help` 查看已安装版本。完整选项与返回结构见
[CLI 详细参考](https://github.com/LeXwDeX/SpecGit/blob/main/docs/cli.md)。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `SPECGIT_GH` / `SPECGIT_GLAB` | 覆盖平台 CLI 可执行文件 |
| `SPECGIT_GH_TIMEOUT_MS` / `SPECGIT_GLAB_TIMEOUT_MS` | 单次调用超时 |
| `SPECGIT_GUARD_BUDGET_S` | 合并钩子的验收预算，不是通用 CLI 设置 |

认证复用已有 `gh`/`glab` 会话。`status` 只看本地，`finish` 需要平台实时证据。
`doctor` 检查环境前置条件，并不负责所有记录、PR/MR 或 CI 故障。

[快速开始](Getting-Started-zh) · [English](CLI-Reference)
