# 快速开始：手工安装与项目初始化

SpecGit 的共享二进制、每个项目的初始化、Codex 等宿主的注册是三个独立步骤。只想在项目中使用命令行时，完成前两步即可。

## 1. 安装二进制

正式分发渠道是 [GitHub Releases](https://github.com/LeXwDeX/SpecGit/releases/latest)。按照[安装指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)，下载**同一稳定 Release** 的平台 ZIP、`SHA256SUMS` 和 `SHA256SUMS.sigstore.json`；先验证签名身份，再用签名清单核对 ZIP 的 SHA-256，最后解压并将 `specgit`（Windows 为 `specgit.exe`）放到用户级 PATH。支持 macOS arm64、Linux x64 glibc 和 Windows x64。正式包运行时无需 Node.js、npm 或 Rust。

如果要手工安装**自己检出的项目源码**，可在 macOS/Linux 上本地构建。此路径用于开发或验证检出的提交，不代替上述签名 Release 验证。先确认当前 Git 提交及工作区内容，再运行：

```sh
cd /path/to/SpecGit/runtime
cargo build --locked --release --bin specgit

mkdir -p "$HOME/.local/bin"
# 已有旧版时先备份；时间戳和 -n 避免覆盖已有备份。
if [ -f "$HOME/.local/bin/specgit" ]; then cp -np "$HOME/.local/bin/specgit" "$HOME/.local/bin/specgit.backup.$(date +%Y%m%d-%H%M%S)"; fi
install -m 755 target/release/specgit "$HOME/.local/bin/specgit"
cmp target/release/specgit "$HOME/.local/bin/specgit"
```

构建依赖 `runtime/rust-toolchain.toml` 指定的 Rust 工具链。无论使用哪种安装方式，都核对实际选中的命令；如果 PATH 中有旧版 shim 或另一个 `specgit`，先解决路径冲突：

```sh
command -v specgit
specgit --human --version
specgit --help
specgit --schema
```

## 2. 在目标项目内初始化

进入**目标 Git 仓库根目录**，先看工作区、远程仓库和已有声明。仓库操作需要 Git，以及已经认证的 `gh`（GitHub）或 `glab`（GitLab）；`--help` 成功不代表远端访问正常。

```sh
cd /path/to/your-project
git status --short --branch
git remote -v
ls -la .specgit.yaml AGENTS.md CLAUDE.md 2>/dev/null
```

下面是 GitHub、远程名为 `origin` 的示例。先检查能力和预览计划，再在预览适用且没有待处理冲突时执行最后一条写入命令：

```sh
specgit init --provider github --remote origin --check --json
specgit init --provider github --remote origin --dry-run --json
specgit init --provider github --remote origin --json
```

`--check` 只检查项目和原生能力；`--dry-run` 预览将写入的内容。两者都不初始化项目。多个 Git 远程存在时，用 `--remote` 指定真正的 forge 远程；只有一个且可自动识别时可以省略。不要仅凭示例假定目标分支是 `main`，让命令读取实际默认分支，或按已确定的项目要求传 `--target`。GitLab 使用 `--provider gitlab`；自建实例按实际 API 地址加 `--api-host`。

若命令报告原生能力未知或不支持，并要求明确运行方式，可选择手工观察，在**预览与实际执行**时都加 `--manual-observe`；也可以先由有权限的管理员配置或核实平台能力。不要跳过报告的冲突。初始化会维护项目本地的 `.specgit.yaml`、受管理的项目指导内容以及 Git 的本地排除记录；先审阅对现有 `AGENTS.md`、`CLAUDE.md` 的影响，保留非 SpecGit 内容。

执行后回读配置与状态：

```sh
cat .specgit.yaml
git status --short
specgit status --remote origin --json
specgit doctor --provider github --remote origin --json
```

已有 **v2** 项目应保留原声明，用相同的检查、预览和执行顺序刷新；不要直接覆盖手工配置。已有 **v1** 项目先按[显式迁移指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md)迁移，替换二进制本身不会迁移项目。旧版 `init --force`、`finish`、`bind` 已退役。

## 3. 按需注册宿主

项目初始化**不等于**宿主注册。只有决定给当前宿主安装集成时，才单独查看 `specgit setup --help` 并预览相应的 `--agent codex`、`--agent claude`、`--agent opencode` 或 `--agent generic` 选择。自 2.4 起 setup 永久只支持项目级：`--scope project` 是默认值也是唯一的 scope 取值，资产写入检出目录并使用 worktree 私有收据，hooks 直接调用已安装的共享二进制（无需先做全局 setup），已退役的全局选项（`--root`、`--provider`、`--api-host`、`--register-*`、各宿主根路径）会被拒绝。只安装二进制并初始化项目时，无需运行 `setup`。

参阅[老项目升级](Upgrading-Existing-Projects-zh)、[团队工作流](Team-Workflow-zh)和[CLI 参考](CLI-Reference-zh)。
