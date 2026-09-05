# 核心概念

SpecGit 的契约建立在真实 Git 和平台证据上。它保存交付绑定与项目策略，每次请求
验收时重新计算结果。

## 一次交付

交付由分支或 worktree、一个或多个 Issue、唯一 PR/MR 和必需检查构成。每个 Issue
对应一个可独立验证的 WHY；请求正文必须为同仓库的每个绑定 Issue 保留关闭引用。
关闭引用表达交付意图，实际关闭状态需要在合并后确认。

## 验收与完成

| 结果 | 证据含义 |
| --- | --- |
| `accepted` | 当前请求 head 通过验收门禁 |
| `rejected` | 已证明某项条件不满足 |
| `unknown` | 证据缺失、不可得或不完整 |
| `closure_pending` | 已确认合并，部分绑定 Issue 仍未关闭 |
| `completed` | 已确认合并，且所有绑定 Issue 已关闭 |

`specgit finish` 只读。退出 `0` 本身不会合并请求。本地测试通过或修改清单状态，
都不能单独证明验收或完成。判定只适用于观测到的事实，相关内容变化后需要重取证据。

十一道门禁依次涉及记录、策略、完整性、上下文、origin、provider、Issue、顺序、
请求、关闭引用与检查。必需检查在请求 head 上验证。认证失败或证据截断均拒绝放行，
不能把未取得的事实当成成功。

## 状态与配置

| 载体 | 职责 |
| --- | --- |
| `.specgit.yaml` | 交付绑定 |
| `spec_git/policy.yaml` | 必需检查与可选项目规则/自动化 |
| `spec_git/providers.yaml` | 需要时声明 GitLab 主机 |
| 生成 workflow 与托管指导 | 派生集成资产 |
| 钩子与 `setup` 入口 | 本地集成资产 |

生成区域通过 `init`/`setup` 刷新，手写指导放在标记之外。下一次正常交付会替换
已确认完成的历史记录；`unbind` 用于显式重置或放弃，不是常规清理步骤。

SpecGit 使用现有 Git、Issue、PR/MR 和 CI 系统，不要求另一套 proposal/spec/task
产物生命周期。验证投入由实际输入决定，普通说明文字无需产品测试。

[详细概念](https://github.com/LeXwDeX/SpecGit/blob/main/docs/concepts.md) · [English](Concepts)
