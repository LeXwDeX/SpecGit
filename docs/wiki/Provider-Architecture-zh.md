# Provider 架构

Rust 运行时将 Issue 写入、请求写入和观察能力分开。核心、watch 与 hooks 不能合并请求、关闭 Issue、删除分支或管理设置。获授权的 Agent 操作不属于这些运行时能力。

当前实现见[运行时开发文档](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/README.md)，对外行为见[原生契约](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。1.0 TypeScript provider 实现已退役。
