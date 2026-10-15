# Repository Guidelines

## 项目事实

SpecGit 2 是 Rust 库和原生 CLI。它管理规格 Issue，汇聚原生 PR/MR，并观察平台状态。
Agent 负责实施和修复。GitHub/GitLab 负责 CI、评审、分支保护、实际合并和常规 Issue 关闭。
Rust 核心、watch 和 hooks 不执行合并、关闭 Issue、删除分支或平台设置管理。

产品版本以 `runtime/Cargo.toml` 为准，并与根 `package.json` 保持一致。
已安装 CLI 的能力以其 `--help` 和 `--schema` 为准。
历史设计文档用于解释设计，不用于证明当前实现或验证结果。

根 Node 工作区是私有工程工具，负责仓库验证。
v1 TypeScript 运行时、Vitest、npm 发布和旧 acceptance controller 已退役。
不要恢复旧命令作为 v2 的开发或交付路径。
当前公开分发渠道仅为 GitHub Releases，提供三个平台的原生 ZIP、校验清单和签名。

## 仓库结构

- `runtime/src/`：类型化库、CLI、Git/平台/宿主适配器。
- `runtime/tests/`：公共接口、架构约束和真实子进程回归测试。
- `runtime/assets/`：随运行时分发的 Skill 和生成指导文本。
- `runtime/schemas/`：声明与报告的 JSON schema。
- `runtime/REFERENCE.md`：原生命令、输入、输出和恢复契约。
- `runtime/distribution/`：原生安装、签名 ZIP 发行及分发验证。
- `runtime/scripts/`：可恢复编译和已安装运行时验证。
- `scripts/`：Node 仓库元数据、文档及工作流安全检查。
- `docs/architecture.md`：模块职责、目标依赖图和修改要求。
- `docs/ci-scope.md`：文档与产品验证范围。

## 协作与安全

必须采用多 Agent 协作，默认以 sol 为主。
sol 负责调度、方案、编码和会审。
luna 负责简单任务、探索、文档和重复任务。
astra 只做交付前终审，审查最终方案和最终代码；纯文档任务审查最终文档。
分配任务时明确文件或模块负责人。不得撤销其他 Agent 或用户的改动。

安全审计限于模型层分析，排查业务与代码漏洞，并执行可预见的安全处理。
不使用外部 DayBreak 工具。保留必要的安全检查和错误边界。
保留无关的未提交文件和本地资产。

代码定位优先使用 codebase-memory MCP 图工具。
会话开始或压缩后先确认项目与索引状态，默认采用 Tier 2 核验。
先定位符号，再追踪相关调用并读取源码；检查分页和每个证据文件的索引覆盖。
覆盖缺失、过期或图结果与源码不符时，直接读取相关源码。
无记录缺口不等于完整覆盖。委派时传递证据、覆盖范围和未解问题。

输出使用短句和常用词。同一概念使用同一名称。
保留关键条件、例外和不确定性，删除套话和重复说明。

## 二次开发约束

### 模块与接口

- 产品逻辑保持在 Rust 运行时。Node 脚本继续用于工程验证和分发工具。
- 按[架构职责](docs/architecture.md)放置代码。纯规则模块不得依赖文件、网络或进程 I/O。
  Git 交互属于 `project`，平台只读访问属于 `forge_read`，显式原生写入属于 `native_delivery`。
  Issue 与 PR/MR 写入使用各自的能力接口。
- 保持模块依赖无环。修改依赖关系时，同步架构图和 `runtime/tests/architecture.rs`。
  兼容入口优先用别名或 re-export，不复制规则实现。
- `main` 保持为进程入口。业务层传递类型化数据，不解析自己的 JSON 报告。
- 修改 CLI 参数、输入、输出或副作用时，同步命令定义及其生成的帮助和 schema。
  同步受影响的原生参考、schema、分发资产和契约测试。
  普通机器输出保持一份 JSON 文档；hook 和 guard 保持各自协议。
- 不静默破坏公共接口。兼容性变化须在所选 Issue 中说明影响、迁移方式和验收条件。

### 进程、资产与权限

- 外部命令通过 `process::Request` 使用绝对可执行路径、明确工作目录和 argv 参数数组。
  不把远端正文或用户输入拼进 shell 命令。
  保留输入、输出和时间上限；超限、超时或取消后回收所拥有的进程树。
- 本地集成只写所属项目资产和 Git 元数据中的状态。
  刷新、卸载和回滚先核对标记、所有权记录、当前内容及权限；加锁后重新核对。
  使用原子替换和原生事务恢复。刷新覆盖已确认受管的标准正文，保留块外人工编辑、其他 hook 和无关目录；卸载和回滚保留后续编辑。
- 保持读取与写入分离。声明、dry-run、通知和建议不产生写入授权。
  不完整读取、未知能力和过期检查不能作为成功或后续写入的依据。
  事件确认只记录传输收据，不证明用户已读或交付完成。
- 必要的 `unsafe` 限于操作系统进程边界，并说明所有权和安全条件。
  保留 Rust/Clippy 安全 lint，不靠扩大超时或跳过 Windows 测试掩盖缺陷。

### 回归与指导文本

- 为行为变化补充能复现真实场景的回归测试。平台协议 fixture 不得只复述适配器实现。
  涉及安装、进程或宿主接口时，验证实际入口及相关失败恢复路径。
- 使用锁文件和固定工具链。依赖、版本或发行格式变化须同步受影响的元数据和验证。
- SpecGit 标记块由 init/setup 管理。手工项目约束放在标记块之外。
  修改生成指导时更新对应源码、`runtime/assets/` 和测试，保持生成文本简短。

## 工作与交付

本仓库已有用户持续授权：产品变更应主动完成完整交付流程，再正式发布。
Agent 自行创建或采用完整 Issue、创建或更新 PR/MR、准备版本、提交和推送、标记 ready、
跟进 CI 与评审、原生合并、必要补关及正式发布，不在这些步骤之间重复索要授权。
这不免除任何约束：发布前须完成适用验证与终审，确认当前 head 的必需检查成功、
目标分支已合并且全部应关闭的关联 Issue 已关闭，再通过独立发布检查并回读产物。
遇到失败或证据不足，先修复或补齐证据；不得跳过检查、弱化平台保护或用旧 head 的结果代替。
用户当次明确的范围限制、暂停或不发布要求优先；只读审计和纯文档任务不触发产品发布。

1. 加载 specgit-native Skill，读取 `.specgit.yaml`、共享 CLI 的 `--help` 和 `--schema`。
2. 修改已跟踪的产品输入前，先用 `specgit issue --inspect` 查重。
   选择包含 Why / Scope / Approach / Acceptance 的完整相关 Issue，保留其原生 ID。
   只读审计不需要 Issue；纯文档遵循下方短路径及已安装 hook 的 checkpoint 要求。
3. 按范围实施和验证。提交使用 Conventional Commit 前缀，PR/MR 目标为 `main`。
   使用[PR 模板](.github/PULL_REQUEST_TEMPLATE.md)，保留用户正文和全部关闭引用。
4. Issue/PR 写入先做 `--dry-run`，机器输出使用 `--json`。
   写入、ready、推送、合并、补关和发布须处于已有用户授权范围内。
   会话授权在原范围内持续有效，不因流程进入下一步而重复询问。
5. 用 `specgit pr --status` 和有界 `specgit watch` 获取当前证据。
   退出码 0 只表示操作成功。交付完成须回读确认目标分支合并及全部关联 Issue 关闭。
   不得弱化平台保护或跳过必需验证。合并不代表发布完成。

已有 PR/MR 正文不同于拟写正文时，更新选项仅提供 dry-run 预览。
在原生平台核对并发变化后编辑，再刷新 `pr --status`。
恢复步骤见[原生参考](runtime/REFERENCE.md)和 specgit-native Skill。

## 自举与项目集成

所有仓库和 worktree 的操作共用一个用户级 SpecGit CLI。
用 `command -v specgit` 定位，并用 `specgit --human --version` 确认版本。
不得安装项目内的操作用 CLI。隔离构建和安装验证产物仅用于测试，不替换共享 PATH 入口。
每个参与项目使用 `specgit init` 初始化。

项目集成仅限项目级。setup 不安装全局宿主资产或全局观察状态。唯一的用户级资产是用户显式运行 `specgit skill --user` 安装的 Skill 文件，`specgit update` 只刷新已受管的该文件。
项目 hooks 直接引用共享 CLI。官方 OpenCode 只安装项目指导和 Skill。
`--opencode-claude-hooks` 仅用于支持该协议的自定义 OpenCode。
安装记录不证明生效；须验证真实阻止行为与上下文交付。

checkpoint 是所选 Issue 的本地记录，属于原分支和 worktree。
独立工作使用独立 worktree，不移动或丢弃其他任务的 checkpoint。
hooks 和 Git guard 只在已安装并实际运行时检查本地上下文，不是通用文件写入沙箱。
本地 init/setup 是维护，不是交付，也不授予平台写入权限。

若 SpecGit 缺陷阻碍 Issue 选择，先记录命令、版本、退出码和诊断。
在已有授权下，用认证的原生 gh/glab 查重并创建或认领完整 Issue，再回读 ID 和正文。
可恢复时用该精确 ID 继续 SpecGit。
仅当同一缺陷仍阻碍其关联修复时，才可记录单任务 checkpoint 例外，修复后恢复正常检查。
不得全局禁用 guard，也不得绕过授权、平台保护、验证、评审、合并、关闭或发布要求。

## 验证要求

README、Wiki、普通文档和手工项目指导采用[文档短路径](docs/ci-scope.md#documentation-short-path)：
评审相关内容，并运行 `node scripts/ci-metadata-check.mjs`。
仅在缺少依赖时运行 `pnpm install --frozen-lockfile --ignore-scripts`，不需要 Rust 重建。

可执行工作流、随运行时分发的参考、schema、模板和脚本属于产品输入，即使用 Markdown 编写。
未知路径按产品验证处理；不得用忽略规则缩小验证范围。
产品修改使用 `runtime/rust-toolchain.toml` 固定的工具链，并运行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node scripts/ci-metadata-check.mjs
cd runtime
cargo fmt --all --check
cargo clippy --locked --all-targets --features test-fixtures -- -D warnings
cargo test --locked --all-targets --features test-fixtures
```

安装或发行变更还须执行相关原生分发测试。
CI 在 GitHub-hosted `ubuntu-24.04`、`macos-15`、`windows-2025` 上验证
Linux x64、macOS arm64、Windows x64 的源码和已安装入口。
`Required verification` 汇总适用检查；`SpecGit Acceptance` 要求其成功且 PR 已 ready、目标为 main。
本地编译、旧 head 或其他平台的成功不替代当前 head 的适用验证。

发布是独立阶段，使用手动触发且仅面向 main 的签名 GitHub Release 流程；上述持续授权覆盖本仓库的该阶段。
发布验证与开发 CI 各有范围，不能互相替代。
具体要求见[CI 范围](docs/ci-scope.md)和[原生发行流程](runtime/distribution/README.md)。

<!-- specgit:v2:start -->
## SpecGit 2

Runtime: 2.11.1. Declaration: `.specgit.yaml` (v2, local configuration).

新任务和已有 PR/MR 的 CI/评审修复都加载 specgit-native Skill。
完整流程和恢复步骤见 Skill；二进制可选，但不得绕过项目 guard/checkpoint 约束。
在授权范围内主动使用原生 gh/glab。GitHub 免费/付费计划、账号类型和仓库可见性，以及 GitLab 社区/商业层级，都是背景信息，不证明项目或当前身份的实际能力；套餐限制、权限不足和未知分开报告；403/404 不足以定因。细节见 Skill。
Milestone 可选；Issue 承载规格和工作台账；PR/MR 集成变更，不代表版本；Release 需要独立授权。
使用共享 CLI 时，以已安装的 `specgit --help` 和 `specgit --schema` 为契约。
修改已跟踪的产品输入前，先查重并选择完整相关 Issue：Why / Scope / Approach / Acceptance（原因、范围、方案、验收要求）。
只读检查、审计和评审不需要 Issue checkpoint；纯文档遵循仓库规则及已安装 hooks。
写入（包括将请求标记为 ready）需要已有用户授权；授权在其范围内持续有效。
声明、`--dry-run` 预览和 Hook 通知都不产生授权。
GitHub/GitLab 负责 CI、评审、保护和实际合并。
按用户目标收尾：评审、修复或跟踪报告已验证结果及限制。
平台交付须原生回读确认目标分支合并及全部应关闭的关联 Issue 关闭。
全部更新后运行 status/doctor，读回生成的 Skill/指导，再次 dry-run 检查收敛；init dry-run 只列计划路径，不报告逐项是否改变。阻塞恢复见 Skill。
已授权刷新时，由 CLI 覆盖所有权已核实的受管文件和完整唯一块内的编辑正文；保留块外字节、配置、checkpoint 和其他 hooks。所有权未知或标记损坏/重复仍冲突。不要手写、恢复旧块或额外手工备份；使用 CLI 恢复。卸载/回滚保留后续编辑。

Declared rules: `{"agent":{"close_issues_after_merge":false,"native_auto_merge":false},"issue_template":"builtin","language":"zh","pr_template":"builtin","validation":{"bodies":false,"labels":"off","titles":false}}`
<!-- specgit:v2:sha256 6238ce781505e9a9b66db5ff4a54138586ddbaf6682dca0678f561a8398118eb -->
<!-- specgit:v2:end -->
