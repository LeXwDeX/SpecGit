# CLI 参考

共享原生 CLI 的 `specgit --help` 和离线 `specgit --schema` 是已安装契约；机器输出用 `--json`，结构化输入用 `--input-file`。GitHub Release 签名 ZIP 包含可执行文件及其内嵌 schema。

| 命令 | 用途 |
| --- | --- |
| `init` | 初始化或检查单个项目的声明和本地指导；不安装宿主 hooks |
| `setup` | 安装/刷新项目 Skill 和指导基线；新选 `--agent` 只添加指导，hooks 须显式指定 `--hook-purpose guard` 和/或 `--hook-purpose context` |
| `update` | 检查、验证或应用签名 GitHub Release，以更新共享可执行文件 |
| `issue` / `pr` | 选择完整规格 / 汇聚原生草稿请求；写入须已有授权 |
| `pr --status` / `watch` | 当前原生状态 / 有界观察；不合并或关闭 Issue |
| `status` / `doctor` | 离线本地证据 / 原生能力诊断 |
| `guard` / `hook` / `inbox` | 本地检查、宿主事件与通知收据 |
| `migrate` | 显式预览和应用已证明归属的 v1 迁移 |

退出码：0 操作或读取成功；1 失败；2 输入无效或需明确选择；3 必要事实未知；130 取消。读取成功可以同时报告 CI 失败，不能只看退出码。

已有 PR/MR 正文差异只能预览：`pr --update-body --body-file <file> --dry-run`。在平台核对并发修改后编辑，再读 `pr --status`。不能去掉 dry-run 期待无条件覆盖。

Setup 仅管理项目资产，默认不添加 Agent hooks。显式用途只作用于 `--agent` 指定宿主；省略 `--agent` 时作用于所有已记录宿主。省略用途会保留已有选择；`none` 不添加 hooks。`observe` 会被识别但拒绝。仅支持 SessionStart 与 PreToolUse 上下文 hooks；应使用有界 `watch`/`inbox` 代替已退役的自动观察回调。

[完整命令、配置和诊断](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。v1 的 `finish`、`accept`、`bind`、`unbind` 已退役。
