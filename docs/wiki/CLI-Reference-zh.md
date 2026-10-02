# CLI 参考

`specgit --help` 和离线 `specgit --schema` 是已安装契约；机器输出用 `--json`，结构化输入用 `--input-file`。公共 ZIP 只有二进制，schema 内嵌其中。

| 命令 | 用途 |
| --- | --- |
| `setup` / `init` | 项目级 agent 集成（自 2.4 起仅项目级；hooks 使用已安装的二进制）/ 项目初始化；预览与实际写入分开 |
| `issue` / `pr` | 选择完整规格 / 汇聚原生草稿请求；写入须已有授权 |
| `pr --status` / `watch` | 当前原生状态 / 有界观察；不合并或关闭 Issue |
| `status` / `doctor` | 离线本地证据 / 原生能力诊断 |
| `guard` / `hook` / `inbox` | 本地检查、宿主事件与通知收据 |
| `migrate` | 显式预览和应用已证明归属的 v1 迁移 |

退出码：0 操作或读取成功；1 失败；2 输入无效或需明确选择；3 必要事实未知；130 取消。读取成功可以同时报告 CI 失败，不能只看退出码。

2.2 中已有 PR/MR 正文差异只能预览：`pr --update-body --body-file <file> --dry-run`。在平台核对并发修改后编辑，再读 `pr --status`。不能去掉 dry-run 期待无条件覆盖。

[完整命令、配置和诊断](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。v1 的 `finish`、`accept`、`bind`、`unbind` 已退役。
