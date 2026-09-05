# Provider 架构

SpecGit 区分本地 git 事实、平台证据和已授权的写入操作，使验收与改变交付状态的
命令保持职责边界。

| 边界 | 职责 |
| --- | --- |
| 本地 Git | 仓库身份、分支/worktree、提交、引用与祖先关系 |
| 平台证据 | 验收所需的 Issue、PR/MR、检查及平台事实 |
| 交付操作 | 创建 Issue/请求、绑定、合并与关闭 Issue |
| 仓库管理 | 已明确授权的保护规则与集成配置 |

GitHub 使用 `gh`，已声明的 GitLab 主机使用 `glab`。认证复用用户 CLI 会话，SpecGit
不保存 token。平台名称本身不能证明仓库身份或能力可用。

## 证据纪律

验收器消费真实事实，不读取保存的“完成”标记。明确的反例可以拒绝验收；认证缺失、
传输失败、响应格式错误或分页不完整，则表示证据不可得。Provider 保留各平台自己的
语义，不能制造看起来相同的绿色检查。

合并自动化有独立授权边界：核对获准目标与当前请求 head，取得最新验收及 CI 证据，
合并时提交预期 head。只有确认合并才开始关闭 Issue，未完成的关闭可继续恢复。

## 接口细节

接口成员清单、适配器实现及兼容规则集中在
[Provider 参考](https://github.com/LeXwDeX/SpecGit/blob/main/docs/providers.md)。
Wiki 不维护第二份容易过时的接口列表。平台接入与限制见 [GitLab 支持](GitLab-Support-zh)。

[核心概念](Concepts-zh) · [English](Provider-Architecture)
