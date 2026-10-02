# Provider 架构

Rust library 和 native CLI 将 IssueWrite、RequestWrite 与只读观察分开。核心、watch 和 hooks 没有合并、关闭 Issue、删除分支或管理设置能力；获授权 Agent 的 gh/glab 操作属于外部步骤。

所有状态都是有时间范围的原生快照。2.2 的 GitHub 观察同时读取有界 workflow-run 身份，需要 Actions 读取权限；同名独立 suite 仍分开，替换运行无可见检查时保持未知。不会展开 job/DAG 或推算合并资格。

Issue 创建锁覆盖共享同一 Git 公共目录的 linked worktree，锁存放在该项目的 Git 元数据中。独立 clone 与其他主机不共享此锁；自 2.4 起不再有用户级全局数据根。同一 WHY 的并发工作应使用一个 checkout 的 linked worktree。原生搜索也可能滞后于写入；出现重复时必须核对 WHY 后接管确切原生 ID。

[运行时架构](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/README.md)与[对外契约](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。v1 TypeScript provider 已退役。
