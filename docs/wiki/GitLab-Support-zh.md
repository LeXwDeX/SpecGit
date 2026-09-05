# GitLab 支持

## 声明主机

使用 `glab >=1.113.0`，并按准确主机认证：

```bash
glab auth status --hostname gitlab.example.com
specgit init --gitlab-host gitlab.example.com
```

主机声明保存在 `spec_git/providers.yaml`。GitLab.com 也需要显式声明
`--gitlab-host gitlab.com`，其支持通过能力探测判断；下方版本窗口针对已验证的自建实例。

## 兼容范围

已验证的自建范围是 **GitLab CE/Free >= 19.2.4 < 19.4.0**。
超出范围会提示 `gitlab_version_unverified`，继续使用实时证据并保持 fail-closed。
警告不会替代通过证据。GitHub Enterprise 在 v1 中没有 provider 路由。

## 流水线归属

GitLab 的业务 CI 由项目维护。应配置经过评审、执行 `specgit finish --json` 的验收
job；基础 init 不会给 GitLab 生成 GitHub Actions workflow。
`gitlab_harness_pending` 提醒项目补齐自己的验收集成。

用户开启完成自动化、且现有布局可安全协调时，SpecGit 在保留业务配置的前提下
安装独立完成路由。启用前查看详细指南中的 include 布局和前置条件；无法证明支持
的布局不能直接改写。

`finish` 通过已认证 `glab` 会话读取 MR 和 pipeline/job 事实。检查必须属于预期 head，
缺失、取消或尚未结束的工作不能被当作成功。`specgit pr --merge` 需要已授权自动化、
配置的目标分支、最新验收和当前流水线证据。确认合并后才会关闭 Issue。

[详细支持与证据](https://github.com/LeXwDeX/SpecGit/blob/main/docs/gitlab-support.md) · [English](GitLab-Support)
