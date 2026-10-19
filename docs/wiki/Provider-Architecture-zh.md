# Provider 架构

Rust library 和 native CLI 将 IssueWrite、RequestWrite 与只读观察分开。核心、watch 和 hooks 没有合并、关闭 Issue、删除分支或管理设置能力；获授权 Agent 的 gh/glab 操作属于外部步骤。

所有观察都是带时间的原生快照。GitHub 会读取有界 workflow-run 身份，需要 Actions 读取权限。同名独立 suite 仍分开；workflow 没有可见 check run 时，仍依据它自身状态判断：queued 或 in-progress 为 pending，completed 且 conclusion 成功时可判为通过。SpecGit 不会展开 job/DAG 或推算合并资格。

Issue 创建锁覆盖共享同一 Git 公共目录的 linked worktree，锁存放在该项目的 Git 元数据中。独立 clone 不共享此锁。项目资产、收据和 checkpoint 按 worktree 保存；linked worktree 可能共享 Git hook 目录及消费者记录。同一 WHY 的并发工作应使用一个 checkout 的 linked worktree。原生搜索也可能滞后于写入；出现重复时必须核对 WHY 后接管确切原生 ID。

[运行时架构](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/README.md)与[对外契约](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。v1 TypeScript provider 已退役。
