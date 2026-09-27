# 快速开始

按[安装指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)下载同一稳定 Release 的原生 ZIP、SHA256SUMS 和签名，先验证签名身份与 ZIP 摘要，再安装到共享用户 PATH。支持 macOS arm64、Linux x64 glibc 和 Windows x64；运行无需 Node.js、npm 或 Rust。仓库操作需要 Git 和已认证的 gh/glab。

在目标仓库内执行以下 GitHub 示例；GitLab 使用 `--provider gitlab`，自建实例按实际需要指定 `--api-host`。已有 v1 项目先迁移。

```sh
specgit --human --version
specgit --help
specgit --schema
specgit init --provider github --check --json
specgit init --provider github --dry-run --json
specgit init --provider github --json
specgit status --json
specgit doctor --provider github --json
```

`--check` 和 `--dry-run` 不执行初始化。仅在已授权本地安装、预览适用且无冲突时执行 apply；能力未知且要求选择时，明确选定 `--manual-observe`，在预览和实际命令中同时使用该参数。声明不授予远端权限。

宿主集成与交付分别见[升级指南](Upgrading-Existing-Projects-zh)和[团队工作流](Team-Workflow-zh)。自动安装可使用[Agent 指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-install.md)。
