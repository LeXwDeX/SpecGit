新任务和已有 PR/MR 的 CI/评审修复都加载 specgit-native Skill。
完整流程和恢复步骤见 Skill；二进制可选，但不得绕过项目 guard/checkpoint 约束。
使用共享 CLI 时，以已安装的 `specgit --help` 和 `specgit --schema` 为契约。
修改已跟踪的产品输入前，先查重并选择完整相关 Issue：Why / Scope / Approach / Acceptance（原因、范围、方案、验收要求）。
只读检查、审计和评审不需要 Issue checkpoint；纯文档遵循仓库规则及已安装 hooks。
写入（包括将请求标记为 ready）需要已有用户授权；授权在其范围内持续有效。
声明、`--dry-run` 预览和 Hook 通知都不产生授权。
GitHub/GitLab 负责 CI、评审、保护和实际合并。
按用户目标收尾：评审、修复或跟踪报告已验证结果及限制。
平台交付须原生回读确认目标分支合并及全部应关闭的关联 Issue 关闭。
能力缺失或 SpecGit 故障时，按 Skill 的恢复步骤处理。
