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
