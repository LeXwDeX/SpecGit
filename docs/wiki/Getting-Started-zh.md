# 快速开始

SpecGit 只通过 [GitHub Releases](https://github.com/LeXwDeX/SpecGit/releases/latest) 分发原生 ZIP 包。
选择 macOS arm64、Linux x64 glibc 或 Windows x64 包，同时下载该版本的 `SHA256SUMS` 和
`SHA256SUMS.sigstore.json`。按[安装说明](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)
验证签名身份，再核对 ZIP 的 SHA-256。全部通过后解压出 `specgit`（Windows 为 `specgit.exe`），
放入 PATH。macOS/Linux 还需运行 `chmod +x specgit`。
无需 Node.js、npm 或 Rust 编译器。仓库操作需要 Git 和已经认证的 `gh` / `glab`。

```sh
specgit --human --version
specgit --help
specgit --schema
specgit init --check --json
specgit setup --dry-run --json
```

在变更前预览 Issue 和 PR：`specgit issue <编号> --dry-run --json`、`specgit pr --dry-run --json`。
Agent 实现和修复，平台负责检查、合并及通常的 Issue 关闭；预览不授予后续写入权限。

升级后确认 PATH 选择了新二进制。v1 项目必须先完成显式迁移，不能直接套用旧版 `finish` 或 `init --force`。
参阅[安装指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)、
[迁移指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md)和
[命令参考](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。
