# Provider 架构

Rust library 和 native CLI 将 IssueWrite、RequestWrite 与只读观察分开。核心、watch 和 hooks 没有合并、关闭 Issue、删除分支或管理设置能力；获授权 Agent 的 gh/glab 操作属于外部步骤。

所有状态都是有时间范围的原生快照。2.2 的 GitHub 观察同时读取有界 workflow-run 身份，需要 Actions 读取权限；同名独立 suite 仍分开，替换运行无可见检查时保持未知。不会展开 job/DAG 或推算合并资格。

Issue 创建锁只覆盖同一用户、主机和共享数据根；跨主机或搜索索引延迟仍可能出现重复，必须核对 WHY 后接管确切原生 ID。

[运行时架构](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/README.md)与[对外契约](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。v1 TypeScript provider 已退役。
