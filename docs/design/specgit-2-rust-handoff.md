# SpecGit 2.0 现有资产整理与实施交接

整理日期：2026-09-10。统一目标是 [轻量级 Rust 设计](specgit-2-rust-design.md)，历史来源见 [318 条 Issue 和 F01–F48 映射](specgit-2-rust-history.md)。用户要求先整理已有工作，再新开任务继续实现；本交接不会将文档交付等同于产品完成。

## 1. 接手时必须理解的变化

用户最新决定覆盖旧版设计中的重型控制器：

- Issue 管理、多 Issue 汇聚到一个 PR/MR 是核心；Agent 监督实现、观察问题并修复。
- GitHub/GitLab 负责原生 CI、保护、自动合并和自动关闭 Issue。SpecGit 只在 init 检查项目能力；不支持或未知让用户选择。
- 合并后仍有未关闭 Issue，hook 通知 Agent。Agent 补关可选；默认只通知，并且必须符合现有授权。
- CLI 只作参考方向：按真实收益择用，C01–C12 不是必须全套实现的规范。优先用好已有参数、JSON、错误与恢复；schema 自省、通用 stdin/dry-run 等有具体需要再加。
- 每项功能和业务线按职责解耦。初始化、Issue 管理、PR/MR 聚合、观察、宿主通知各自拥有规则/状态和小接口；按主设计 §3.1.1 验证独立演进与典型扩展的修改范围。
- Rust 核心移除 finish/acceptance、merge、promotion、scope、repair/closure worker 和跨 head receipt 引擎；保留必要的原生观察与可靠性。

已有类型化 Assessment 修复和 adapter 拆分不是白做：保留正确分层和类型经验，把边界收窄到 observation。不得再为满足旧 F25/F29/F38/F48 而继续扩充已被用户移出的职责。

## 2. Git 与 PR 资产快照

以下通过原生 Git 与认证 `gh` 核对；表中 PR 在整理时都是 OPEN、DRAFT。提交是交接锚点，接手后仍须刷新，不能将表中的状态当永久事实。

| 资产 | 已核对提交 | 当前用途与处理 |
| --- | --- | --- |
| [PR #525](https://github.com/LeXwDeX/SpecGit/pull/525)，`feat/512-rust-native-delivery` | `3eb47278459db71a5d29ddd1b25ee1bfa15ca23c` | 最完整 Rust 候选；已有 Issue/PR、观察、迁移、分发和旧控制器。优先在保留提交历史的前提下继续同 WHY 工作，不平行重写第二套。 |
| [PR #529](https://github.com/LeXwDeX/SpecGit/pull/529)，`ci/528-selfhosted-ci-validation` | `ca7ecf96a86d0e8a0067eb595d57fe91fd4e63f2` | 全仓自有 runner 路由/调度依赖。接手推送前先确认自己的候选也具备全部正确路由。 |
| [PR #522](https://github.com/LeXwDeX/SpecGit/pull/522)，`feat/511-rust-project-init` | `ebd89f0f91910112383d3e429f0cbcf6ec23f2ae` | init 候选历史。其绝对禁止人工补关和平台设置写入的旧范围按新设计调整；不擅自合并。 |
| [PR #519](https://github.com/LeXwDeX/SpecGit/pull/519)，`feat/510-rust-global-hooks` | `c67b3e0b2067832a17cd2bd7ee98b22f72ee55f3` | 全局 hooks 与安全资产更新候选；检查已进入 #525 的具体提交，避免重复搬运。 |
| [PR #496](https://github.com/LeXwDeX/SpecGit/pull/496)，`feat/473-verified-input-reuse` | `92f69ece65768a06e7f78d624980c2bffb2d6673` | 旧 TypeScript/复用方案，保留历史和用户工作目录；不得继续移植已退役 receipt 控制。 |
| [PR #538](https://github.com/LeXwDeX/SpecGit/pull/538)，`docs/537-rust-2-design-and-lessons` | 文档提交见本 PR head | 本次统一设计、历史映射和交接。基于 #529 的自有 runner 提交；相对 main 的整个 PR 含该产品依赖，不宣称整个 PR 只有文档。 |
| 旧设计 #507 / PR #508 | `b3bf9c07b2f79e9fccecca6805d23f80b2ff3c1d` | 296 条历史与 48 项旧要求的冻结来源；由新设计明确覆盖，不删除历史。 |

主工作目录在整理时仍是旧 #496 分支，保持干净且未切换。多个旧临时 worktree 的文件目录已不在，但 Git 仍保留它们的分支/提交和注册；这不证明代码丢失，也不授权删除/prune。不要在旧路径不存在时把空目录当作最新候选。

新任务使用隔离 worktree/checkout，先核对上述对象与远端；根据已存在的提交继续工作，保留旧分支与所有关闭引用，不重置共享工作目录、不强推。如果 Git 的旧 worktree 注册阻止检出，可以用新的隔离 checkout 保留原分支/提交历史，不为省事删除所有注册。

当前默认分支仍可能运行旧托管 completion，不能仅凭候选 YAML 使用自有 runner 就认为所有触发链已迁移。沿用 [仓库记录的过渡方式](../ci-scope.md)：草稿提交带 `[skip ci]`，需要产品验证时手动 dispatch 已核对路由的 **CI** 分支；核对默认分支 `workflow_run` 触发条件，不启动旧托管 completion。本次文档提交同样保留该标记，不把被跳过的自动检查当作验收。

## 3. 源码资产与收敛方向

本次确认了 `3eb47278` 的 `runtime/src/lib.rs`、`runtime/src/main.rs`、Cargo 配置和完整 runtime 文件清单。以下“存在”只表示候选源码资产存在，不表示这些模块已满足新设计或完成了完整源码审计。

| 候选路径/模块 | 可复用内容 | 后续动作 |
| --- | --- | --- |
| `runtime/src/process/`、`project.rs`、`native_file.rs` | 进程与系统边界、路径/Git 身份 | 保留 Windows/Unix 与取消回收回归，按新调用面减冗余 |
| `config.rs`、`init.rs`、`probe.rs`、`native_settings.rs` | 配置解析和原生能力事实 | init 收窄为检查/确认；删平台设置写操作和自有验收配置 |
| `spec.rs`、`templates.rs`、`issue.rs`、`pr.rs`、`selection.rs` | 规格、模板、显式创建/采用、原生关联 | 分清规格、Issue 和请求聚合的规则/状态；保留无假提交、正文并发及恢复，按需要改善调用 |
| `forge/`、`native_delivery.rs` | GitHub/GitLab 协议读取与 Issue/PR 操作 | 具体 adapter 自持协议；缩小写接口，不导入命令层类型 |
| `assessment.rs`、`delivery_model.rs`、`observation.rs` | 已做的类型化事实与输出分离 | 仅保留事实、来源、未知与纯展示归一化；删除准入判定和 merge 消费方 |
| `native_checks.rs`、`native_requirements.rs` | 旧 attempt/来源诊断经验 | 按当前消息读取所需保留；不继续实现完整 CI DAG/保护要求解析 |
| `finish.rs`、`merge.rs`、`promotion.rs` | 旧目标实现与回归来源 | 从新 CLI 与运行时执行链退役；逐条标注测试去向 |
| `watch.rs`、`watch_store.rs`、`hook.rs`、`setup.rs` | 有界观察、事件去重/交付、用户级集成 | 只读；补 merged-open 可选 Agent 补关提示；实际宿主收信验证 |
| `assets.rs`、`migrate.rs`、`migration_assets.rs`、`migration_remote.rs` | 归属清点、备份、条件恢复 | 保留用户保护；移除隐藏远端管理员控制，由 Agent 执行获授权原生迁移操作 |
| `report.rs`、`diagnostic.rs`、`i18n.rs`、`main.rs` | 统一输出与入口 | 入口负责解析/组合/渲染，业务留在各模块；额外 CLI 能力按收益选用 |
| `runtime/tests/` 与 npm 包装资产 | 进程、资产、Issue/PR、hook、安装候选回归 | 依据 L01–L18 和实际采用能力验证，业务模块可独立测，不强制 C01–C12 全选 |

图谱限制：本次主仓库图谱 generation 为 `2026-09-08T22:31:58Z`，对应旧 #496 分支；对 runtime 的检索无结果，覆盖查询显示路径 missing。已用确切 Git 对象的直接源码/文件清单作上述有限核对，未将“图谱无结果”解释成源码不存在。新任务先确认自身项目/generation，再对实际修改和证据路径查覆盖；过时/缺失范围直接读取。

## 4. 现有 tracker 工作如何继续

以下是接手的范围对照，不创建平行的第二个 programme。先在对应 Issue 写明生效的新范围、设计链接和旧条款被替代的部分，再开始产品修改。保留历史正文/证据与 Closes 引用，不以范围变化静默关闭未完成工作。

| 现有 Issue | 本次后的有效工作 |
| --- | --- |
| [#493](https://github.com/LeXwDeX/SpecGit/issues/493) | 总工程协调按 L01–L18 和 318 条历史，加入功能/业务线解耦；C01–C12 仅为可选参考，不开发 programme runtime。 |
| [#535](https://github.com/LeXwDeX/SpecGit/issues/535) | 优先完成 typed observation 与输出分离，移除本地 acceptance/merge 消费者；不能继续按旧纯验收器范围扩张。 |
| [#536](https://github.com/LeXwDeX/SpecGit/issues/536) | 保留具体 forge adapter 的协议隔离；Issue/PR 写与观察读分离，移出 merge/promotion/settings write。 |
| [#511](https://github.com/LeXwDeX/SpecGit/issues/511) | 最小 init 配置、真实只读能力、用户确认；配置不能自动升级会话授权。 |
| [#512](https://github.com/LeXwDeX/SpecGit/issues/512) | 规格 Issue、多对一聚合、正文/身份/恢复；解耦规格与请求业务，CLI 改善按实际调用需要选择。 |
| [#510](https://github.com/LeXwDeX/SpecGit/issues/510)、[#492](https://github.com/LeXwDeX/SpecGit/issues/492) | Hook/宿主交付、有界观察、Agent 修复与可选补关通知；hook 不执行写入。 |
| [#513](https://github.com/LeXwDeX/SpecGit/issues/513) | 安全迁移和新旧执行链清点，保留所有用户资产及旧未合并 PR。 |
| [#473](https://github.com/LeXwDeX/SpecGit/issues/473) | 原生 CI 调度效率与真实调用成本，取消自有跨 head receipt/reuse 控制。 |
| [#477](https://github.com/LeXwDeX/SpecGit/issues/477) | 仅保留普通原生关联需要；不实现独立 promotion 命令/算法。 |
| [#474](https://github.com/LeXwDeX/SpecGit/issues/474) | 真实 Windows 同工作量性能与完整保留用例记账。 |
| [#514](https://github.com/LeXwDeX/SpecGit/issues/514) | 公共 npm 原生安装与资格验证；自有 runner 的实际认证路径待解决，真实发布仍需另行授权。 |
| [#527](https://github.com/LeXwDeX/SpecGit/issues/527)、[#528](https://github.com/LeXwDeX/SpecGit/issues/528)、[#530](https://github.com/LeXwDeX/SpecGit/issues/530) | 自有 runner 与 locale 修复依赖；全仓路由核对，不使用 hosted fallback。 |
| #521、#523、#524、#526、#531–#534 | 已记录的 Rust/Windows/资产修复逐个查看候选和当前回归；旧成功或 Issue 打开都不直接等于当前实现结论。 |

基础 #509、权限 #515、测试 #518/#520 在整理时已经关闭；不重开它们充当新任务占位。若新范围有独立、尚无 Issue 的 WHY，按现行 SpecGit 契约先查重并绑定再修改；不要把全部工作塞进一个无法独立验收的修复项。

## 5. 已知证据状态与缺口

截至本次读取，PR #525 head `3eb47278` 的原生 rollup 显示：

- TypeScript 三平台、Lint & Type Check、Metadata contracts、Nix、Package verification，以及 Rust Linux/macOS 为 SUCCESS。
- [Rust Windows](https://github.com/LeXwDeX/SpecGit/actions/runs/34353248252/job/102472086717) 为 FAILURE；[Required verification](https://github.com/LeXwDeX/SpecGit/actions/runs/34353248252/job/102481737441) 和 [CI 内 Acceptance](https://github.com/LeXwDeX/SpecGit/actions/runs/34353248252/job/102481818332) 为 FAILURE。
- [Dependency Review](https://github.com/LeXwDeX/SpecGit/actions/runs/34353247996/job/102471597948) 为 FAILURE。这里只确认结果，不凭旧诊断猜测这次失败原因；接手读取对应日志后复用同 WHY 修复。

PR #529 head `ca7ecf96` 的本次 `statusCheckRollup` 是空列表；不能把曾见到的手动运行绿灯当成该字段当前有完整验收。依赖验证需直接核对适用 run 与实际 head。

这些结果属于旧范围候选，既不证明新的轻量级设计实现完毕，也不能丢弃其中可信的基础回归。后续必须补当前轻量级安装入口、GitHub/GitLab 完整流程、可选 Agent 补关、真实宿主交付、支持平台安装、同工作量性能和发布能力证据。

上一开发任务已因额度中断而停止，不能继续对用户描述为正在执行。新任务接手后，父任务的三小时质量检查应改为跟踪新任务，按四层和新清单检查实际增量；旧 prompt 中的“继续 pure Assessment/merge/promotion、不得另建任务”等条款已过时。

## 6. 实施顺序与交付边界

1. 恢复隔离工作位置，刷新 Git/PR/Issue；确认旧任务不并发编辑，读取设计和本交接，准备已有 Issue 的范围修订。
2. 在保留原关联和同 WHY PR 的前提下收敛架构；先明确功能/业务线的规则与状态归属，解决 #535/#536 的新边界，再改 init 和 Issue/PR。CLI 建议择用，不能为实现整套范式拖延业务。
3. 接上 hook/Agent 的修复、原生自动合并与可选补关流程；验证 Rust 核心只读观察、没有 merge/close/delete 路径。
4. 完成迁移、安装和真实平台验证；按 L01–L18、已采用的具体能力与历史去向补缺口，父任务独立按架构/框架/业务代码/产品业务复核；未采用的 CLI 参考不算缺陷。

用户授权实现、必要提交推送和自有 runner CI。当前仓库交付 PR 保持草稿，不自动合并、不公开发布、不改变源库可见性、不购买额度、不削弱检查。产品设计中的“原生自动合并能力”不等于授权现在合并 SpecGit 自身尚未验收的 PR。已有授权的测试 fixture 可验证原生合并；新增真实外部写入仍需明确对象与相应授权。

本次整理不修改原生保护、CI 策略或产品代码，不清理旧 worktree 注册，不关闭历史 Issue，不发布新包。后续任务完成具体工作后，报告实际修改、关键验证、剩余证据与明确阻塞，不能只回复“计划已理解”。
