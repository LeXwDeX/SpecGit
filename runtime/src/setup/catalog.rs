//! Pure installation guidance. Catalog entries describe choices, never live evidence.
use serde::Serialize;
use std::fmt::Write;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallationId {
    ProjectSkill,
    InstructionEntry,
    SessionContext,
    ToolContext,
    GitGuard,
    Observation,
    LocalExclusions,
    PrivateState,
}
impl InstallationId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProjectSkill => "project_skill",
            Self::InstructionEntry => "instruction_entry",
            Self::SessionContext => "session_context",
            Self::ToolContext => "tool_context",
            Self::GitGuard => "git_guard",
            Self::Observation => "observation",
            Self::LocalExclusions => "local_exclusions",
            Self::PrivateState => "private_state",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Requirement {
    Recommended,
    Optional,
    Conditional,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandMode {
    Preview,
    Apply,
    Read,
    Invoke,
    Observe,
}

#[derive(Debug, Serialize)]
pub struct InstallationCommand {
    /// Arguments, including the executable. Placeholder values must be replaced.
    pub argv: Vec<&'static str>,
    pub mode: CommandMode,
    pub side_effects: &'static str,
    pub requires_project: bool,
    pub requires_network: bool,
}

#[derive(Debug, Serialize)]
pub struct Verification {
    pub written: &'static str,
    pub loading: &'static str,
    pub effect: &'static str,
}

#[derive(Debug, Serialize)]
pub struct Lifecycle {
    pub refresh: &'static str,
    pub remove: &'static str,
    pub rollback: &'static str,
}

#[derive(Debug, Serialize)]
pub struct InstallationItem {
    pub id: InstallationId,
    pub purpose: &'static str,
    pub requirement: Requirement,
    pub scope: &'static str,
    pub owner: &'static str,
    pub bundle: Option<&'static str>,
    pub locations: Vec<&'static str>,
    pub recommendations: Vec<&'static str>,
    pub conditions: Vec<&'static str>,
    pub depends_on: Vec<InstallationId>,
    pub commands: Vec<InstallationCommand>,
    pub protocol: &'static str,
    pub verification: Verification,
    pub fallback: &'static str,
    pub lifecycle: Lifecycle,
}

#[derive(Debug, Serialize)]
pub struct InstallationBundle {
    pub id: &'static str,
    pub members: Vec<InstallationId>,
    pub selection: &'static str,
}

#[derive(Debug, Serialize)]
pub struct InstallationCatalog {
    pub catalog_version: u32,
    pub runtime_version: &'static str,
    pub compatibility: Compatibility,
    pub entrypoints: Vec<InstallationCommand>,
    pub host_discovery: &'static str,
    pub installation_verification: &'static str,
    pub side_effects: &'static str,
    pub boundaries: Vec<&'static str>,
    pub bundles: Vec<InstallationBundle>,
    pub items: Vec<InstallationItem>,
}

#[derive(Debug, Serialize)]
pub struct Compatibility {
    pub catalog_contract: &'static str,
    pub runtime_contract: &'static str,
    pub existing_installations: &'static str,
}

fn command(
    argv: &[&'static str],
    mode: CommandMode,
    side_effects: &'static str,
    requires_network: bool,
) -> InstallationCommand {
    InstallationCommand {
        argv: argv.to_vec(),
        mode,
        side_effects,
        requires_project: true,
        requires_network,
    }
}

fn baseline_commands() -> Vec<InstallationCommand> {
    vec![
        command(
            &["specgit", "setup", "--dry-run", "--json"],
            CommandMode::Preview,
            "只读计划；不创建目录、锁或资产。",
            false,
        ),
        command(
            &["specgit", "setup", "--json"],
            CommandMode::Apply,
            "安装或刷新受管 shared_baseline；新安装不添加 hooks，刷新保留已记录选择；同时维护所需私有状态和精确本地排除。",
            false,
        ),
        command(
            &["specgit", "doctor", "--offline", "--json"],
            CommandMode::Read,
            "只读本地静态检查；不认证、不调用平台、不证明宿主加载或真实行为。",
            false,
        ),
    ]
}

fn baseline_lifecycle() -> Lifecycle {
    Lifecycle {
        refresh: "SpecGit setup 刷新已核实所有权的整个 bundle；保留唯一完整标记块之外的人工内容。",
        remove: "先 specgit setup --uninstall --dry-run，再显式 specgit setup --uninstall；移除本 worktree 全部已记录 integration，不能按本清单 capability 独立卸载。保留后续编辑与共享消费者仍需的资产。",
        rollback: "specgit setup --rollback <transaction> 按原生事务证据恢复；内容、权限或共享消费者冲突须先解决。",
    }
}

fn host_item(id: InstallationId, event: &'static str, purpose: &'static str) -> InstallationItem {
    InstallationItem {
        id,
        purpose,
        requirement: Requirement::Optional,
        scope: "项目内宿主事件映射",
        owner: "Agent 维护自定义宿主配置与胶水；SpecGit 仅管理已记录的原生安装资产。",
        bundle: None,
        locations: vec!["宿主实际支持的项目级事件配置；自定义路径由 Agent 记录"],
        recommendations: vec![
            "先核实宿主版本、项目配置入口、事件输入及输出处理，再连接共享 CLI；不依赖品牌名单推断能力。",
        ],
        conditions: vec![
            "宿主明确支持该事件及原生命令协议；用户已授予项目访问与宿主信任。",
            "仅支持 SessionStart 与 PreToolUse 上下文事件；不支持 PostToolUse、Stop 或异步唤醒，checkpoint 强制检查仅在真实 Git commit/push。",
        ],
        depends_on: vec![
            InstallationId::ProjectSkill,
            InstallationId::InstructionEntry,
        ],
        commands: vec![command(
            &["specgit", "hook", "--event", event],
            CommandMode::Invoke,
            "消费宿主 stdin JSON 并返回原生事件协议；按需写本 worktree hook-context 去重状态；不执行 checkpoint 强制检查，不写平台。",
            false,
        )],
        protocol: "stdin JSON 上限 1 MiB、读取限时 2 秒；普通事件处理限时 2.5 秒。输出使用已安装原生事件契约，不是普通 report；退出码与响应须查 hook --help、--schema 和原生参考。",
        verification: Verification {
            written: "回读事件配置和绝对 CLI 路径；Agent 记录自定义文件及维护责任。",
            loading: "开启真实新会话，确认宿主加载项目配置并触发目标事件。",
            effect: "用真实事件确认简短规则、Skill 入口或按需上下文已送达；doctor 不验证自定义胶水，映射不证明实际加载或执行。",
        },
        fallback: "宿主不支持时，Agent 在新会话、压缩或恢复后按需重读固定 Skill 和项目指导，并手动执行相关命令。",
        lifecycle: Lifecycle {
            refresh: "Agent 维护自定义映射；原生 setup 只刷新其已有收据证明的资产。",
            remove: "Agent 按自身记录删除自定义胶水；原生 setup --uninstall 只移除自身受管资产，保留其他 hooks。",
            rollback: "自定义胶水由 Agent 依据记录恢复；SpecGit 事务不管理任意宿主路径。",
        },
    }
}

/// Return an offline capability catalog. No project or host is inspected.
pub fn catalog() -> InstallationCatalog {
    let mut items = vec![
        InstallationItem {
            id: InstallationId::ProjectSkill,
            purpose: "为跨工具 Agent 提供固定、可重读的 SpecGit 工作流入口。",
            requirement: Requirement::Recommended,
            scope: "项目内共享指导",
            owner: "SpecGit managed",
            bundle: Some("shared_baseline"),
            locations: vec![".agents/skills/specgit-native/SKILL.md"],
            recommendations: vec![
                "与根 AGENTS.md 一起安装；在新会话、压缩或恢复后按需重读；文件存在不等于宿主已加载。",
            ],
            conditions: vec![
                "本地资产安装需要 Git worktree 与可核实的资产所有权；setup 可在没有声明时准备本地资产。Issue/平台工作流另需 init 生成或恢复项目声明。",
            ],
            depends_on: vec![],
            commands: baseline_commands(),
            protocol: "UTF-8 Skill 文本；固定入口，不要求宿主自动发现。",
            verification: Verification {
                written: "回读固定 Skill、收据与 setup dry-run；检查受管内容和权限。",
                loading: "确认 Agent 实际读取当前项目 Skill。",
                effect: "用真实任务确认 Issue 选择、验证与交付约束被遵循；文件收据不证明执行。",
            },
            fallback: "Agent 直接读取固定路径；宿主没有自动 Skill 发现能力不阻止原生 CLI。",
            lifecycle: baseline_lifecycle(),
        },
        InstallationItem {
            id: InstallationId::InstructionEntry,
            purpose: "在根项目指导中提供稳定的 Skill 指针与项目边界。",
            requirement: Requirement::Recommended,
            scope: "项目内共享指导",
            owner: "SpecGit managed block; manual content owned by project",
            bundle: Some("shared_baseline"),
            locations: vec!["AGENTS.md 中唯一完整 SpecGit 项目标记块"],
            recommendations: vec![
                "随 project_skill 作为 shared_baseline 安装；手工项目约束放在标记块外。",
            ],
            conditions: vec!["所有权已核实；标记损坏、重复或来源未知时先解决冲突。"],
            depends_on: vec![InstallationId::ProjectSkill],
            commands: baseline_commands(),
            protocol: "UTF-8 项目指导；稳定入口指向固定 Skill，不代表宿主信任授权。",
            verification: Verification {
                written: "回读标记块与块外人工内容；再次 dry-run 确认计划收敛。",
                loading: "确认宿主或 Agent 读取根项目指导。",
                effect: "确认 Agent 从该入口读取 Skill；安装不证明运行行为。",
            },
            fallback: "Agent 直接读取 AGENTS.md 和固定 Skill，不要求可选宿主桥接。",
            lifecycle: baseline_lifecycle(),
        },
        host_item(
            InstallationId::SessionContext,
            "SessionStart",
            "在 SessionStart 交付简短项目规则与固定 Skill 入口。",
        ),
        host_item(
            InstallationId::ToolContext,
            "PreToolUse",
            "在 PreToolUse 按需交付项目上下文，不执行 checkpoint 强制检查。",
        ),
    ];
    items.extend([
        InstallationItem {
            id: InstallationId::GitGuard,
            purpose: "在真实 Git pre-commit/pre-push 入口检查本地 Issue checkpoint。",
            requirement: Requirement::Optional,
            scope: "有效 Git hooks 目录；linked worktree 可能共享 hooks",
            owner: "SpecGit managed blocks; worktree receipts or retained setup ownership in shared Git metadata",
            bundle: None,
            locations: vec!["Git 解析出的有效 hooksPath/pre-commit", "Git 解析出的有效 hooksPath/pre-push", "独立 guard：worktree 私有 Git 元数据/specgit-v2/guard-hooks.json", "setup 管理的 guard：worktree 私有 Git 元数据/specgit-v2/setup-guard-hooks.json", "setup owner 退役且仍有消费者时：common Git 元数据/specgit-v2/shared-setup-guard/<hook-identity>/（见原生参考）"],
            recommendations: vec!["先 preview；保持已有 shell hook 正文和第三方 hooks；由原生计划核实当前所有者、共享保留记录和消费者后维护。"],
            conditions: vec!["共享 CLI 可执行；真实 Git 操作会调用有效 hooks。", "路径、收据、内容和权限符合原生计划；不支持的脚本或未知所有权冲突须先解决。"],
            depends_on: vec![InstallationId::PrivateState],
            commands: vec![
                command(&["specgit", "guard", "--install", "--dry-run", "--json"], CommandMode::Preview, "只读安装计划与共享消费者信息。", false),
                command(&["specgit", "guard", "--install", "--json"], CommandMode::Apply, "写受管 Git hook 块、worktree 收据与资产事务。", false),
                command(&["specgit", "guard", "--uninstall", "--dry-run", "--json"], CommandMode::Preview, "只读卸载计划；有共享消费者时报告保留。", false),
                command(&["specgit", "guard", "--uninstall", "--json"], CommandMode::Apply, "卸载自身受管块；共享消费者仍依赖时保留块和收据。", false),
            ],
            protocol: "由 Git 调用共享 CLI guard --stage；pre-push 使用 Git ref 更新 stdin。使用实际 guard 契约与退出码；不执行平台合并或关闭 Issue。",
            verification: Verification {
                written: "回读有效 hook_root、两个 hook、当前 worktree 或固定共享目录的 guard 收据及 doctor 本地证据。",
                loading: "确认实际 Git hooksPath、可执行权限和共享 CLI 路径。",
                effect: "在隔离场景运行真实 Git 操作，验证缺失 checkpoint 时阻止及有效 checkpoint 时放行。",
            },
            fallback: "未安装或未触发时由 Agent 在相关 Git 操作前手动检查 Issue；若项目明确要求 guard，须完成安装与真实验证，提示词不能代替该验收。guard 不构成通用文件写入沙箱。",
            lifecycle: Lifecycle {
                refresh: "guard --install 在核实所有权后刷新；apply 加锁并复核计划快照。",
                remove: "guard --uninstall 保留人工正文、第三方 hook 与仍被 sibling 消费的共享块；退役 setup guard 的共享保留记录由最后消费者的 setup 卸载清理。",
                rollback: "保留并检查原生事务恢复证据；当前无独立 guard rollback 命令，不手写旧块或猜测所有权。",
            },
        },
        InstallationItem {
            id: InstallationId::Observation,
            purpose: "有界观察原生 PR/MR checks 或 lifecycle，并恢复事件传输收据。",
            requirement: Requirement::Optional,
            scope: "项目与 worktree 内观察状态",
            owner: "SpecGit manages observation state; Agent owns scheduling and host delivery glue",
            bundle: None,
            locations: vec!["worktree 私有 Git 元数据/specgit-v2 下的观察状态"],
            recommendations: vec!["优先有界 watch；保留 request/session/goal 以显式恢复；把实际完成、传输收据和用户已读区分开。"],
            conditions: vec!["项目声明有效；原生 request ID 与 session 明确；联网刷新须有有效平台只读凭据。", "自动观察使用显式有界 watch/inbox；不使用宿主 PostToolUse、Stop 或异步唤醒。"],
            depends_on: vec![InstallationId::PrivateState],
            commands: vec![
                command(&["specgit", "watch", "--request", "<request>", "--session", "<session>", "--goal", "checks", "--timeout-seconds", "60", "--json"], CommandMode::Observe, "只读平台状态；写项目内有界订阅与事件状态，不写远端。", true),
                command(&["specgit", "inbox", "--request", "<request>", "--session", "<session>", "--goal", "checks", "--no-refresh", "--json"], CommandMode::Read, "读本地收据 ID；缓存终态不是当前远端完成证据。", false),
            ],
            protocol: "普通单份 JSON report；goal 为 checks 或 lifecycle。timeout-seconds 为 1..86400，poll-seconds 为 1..3600；非 once 观察期限须不短于轮询间隔。检查当前 head 与报告状态，退出 0 仅说明操作成功。",
            verification: Verification {
                written: "检查 request/session/goal 和本地事件状态，不以目录存在作为活跃订阅证据。",
                loading: "确认调度器或 Agent 实际调用 watch/inbox，并遵守有界停止条件。",
                effect: "回读当前 head 的原生状态与事件；交付须另证目标分支合并及全部相关 Issue 关闭。",
            },
            fallback: "显式再次运行有界 watch 或由 Agent 使用原生 CLI 只读回查；没有宿主自动唤醒。",
            lifecycle: Lifecycle {
                refresh: "用同一 request/session/goal 按原生恢复契约刷新；停止条件明确。",
                remove: "取消或结束只处理所属订阅；项目移除先核实相关状态，不删除其他 worktree 资产。",
                rollback: "不把旧观察缓存恢复为当前平台证据；事件确认只记录传输收据。",
            },
        },
        InstallationItem {
            id: InstallationId::LocalExclusions,
            purpose: "让精确的本地集成资产保持本地，不干扰 Git index。",
            requirement: Requirement::Conditional,
            scope: "仓库 Git info/exclude；linked worktree 可能共享",
            owner: "SpecGit managed exact exclusion block",
            bundle: None,
            locations: vec!["Git 解析出的 info/exclude 中受管精确块", "精确排除 /.specgit.yaml", "按实际选择精确排除 /.agents/skills/specgit-native/SKILL.md 与已有兼容路径 /.claude/skills/specgit-native/SKILL.md；不忽略整份 AGENTS.md、CLAUDE.md 或其他混合人工指导文件"],
            recommendations: vec!["由 init/setup 管理精确排除；不增加宽泛忽略规则，不移除已跟踪文件。"],
            conditions: vec!["所选项目资产需要本地排除；所有权、内容和共享消费者可核实。"],
            depends_on: vec![],
            commands: baseline_commands(),
            protocol: "精确 Git 本地排除文本；不执行 git rm、index 修改或平台写入。",
            verification: Verification {
                written: "回读精确标记块并保留块外字节。",
                loading: "用 Git 实际忽略规则检查验证精确目标。",
                effect: "确认 index 与已跟踪内容不变，无关路径未被宽泛忽略。",
            },
            fallback: "先解决所有权冲突；不能为通过检查而增加全局或宽泛排除。",
            lifecycle: Lifecycle {
                refresh: "init/setup 按原生资产事务维护精确块。",
                remove: "项目移除与回滚核实 sibling consumer；仍有消费者时保留共享排除。",
                rollback: "按原生事务恢复并保留后续人工编辑与其他排除规则。",
            },
        },
        InstallationItem {
            id: InstallationId::PrivateState,
            purpose: "保存 worktree 配置、checkpoint、项目收据、事务和观察状态，以及仍被消费的退役 setup guard 所有权。",
            requirement: Requirement::Conditional,
            scope: "worktree 私有 Git 元数据；退役 setup guard 证据保存在固定共享 Git 目录；不是可复制的授权令牌",
            owner: "SpecGit managed state",
            bundle: None,
            locations: vec!["Git 解析出的 worktree 私有元数据/specgit-v2", "退役但仍被消费的 setup guard：common Git 元数据/specgit-v2/shared-setup-guard/<hook-identity>"],
            recommendations: vec!["由相应命令按需建立；checkpoint 留在原分支和 worktree，独立任务使用独立 worktree。"],
            conditions: vec!["本地操作实际需要相应状态；私有目录、收据或声明不会扩展用户授权。"],
            depends_on: vec![],
            commands: vec![command(&["specgit", "status", "--json"], CommandMode::Read, "读取本地声明、选择和集成状态；不证明平台交付完成。", false)],
            protocol: "有界原生配置和资产事务；锁后重验，原子写入，遇到未完成事务先恢复。",
            verification: Verification {
                written: "读取原生命令返回的路径、所有权和事务证据。",
                loading: "确认实际项目、分支、worktree 和共享 CLI 版本。",
                effect: "在真实入口验证相关状态与失败恢复；目录存在不证明功能已运行。",
            },
            fallback: "缺失或冲突时按原生诊断恢复原始声明或事务；不复制其他任务 checkpoint 或手写收据。",
            lifecycle: Lifecycle {
                refresh: "由拥有状态的原生命令维护；setup 不重建其他任务 checkpoint。",
                remove: "按对应 remove/uninstall 的完整预览与所有权要求执行；保留无关资产及后续编辑。",
                rollback: "使用对应原生事务恢复入口；不把未知文件或旧收据视为写入权限。",
            },
        },
    ]);
    InstallationCatalog {
        catalog_version: 1,
        runtime_version: env!("CARGO_PKG_VERSION"),
        compatibility: Compatibility {
            catalog_contract: "catalog_version=1；稳定 item IDs，新增字段或能力以当前运行时清单为准。",
            runtime_contract: "本清单描述当前运行时的原生事件与安装契约；runtime_version 是实际编译版本。当前共享 CLI --help/--schema 是可执行契约，不用清单名称证明旧二进制支持新参数。",
            existing_installations: "保留已有受管选择、旧 named-host 入口与可证明所有权的收据兼容路径；必要时按原生计划迁移；未知版本、权限或所有权冲突不自动认领。",
        },
        entrypoints: vec![
            InstallationCommand {
                argv: vec!["specgit", "setup", "--catalog", "--json"],
                mode: CommandMode::Read,
                side_effects: "离线返回本目录；不读取项目或发现宿主，不写资产。",
                requires_project: false,
                requires_network: false,
            },
            command(
                &["specgit", "init", "--dry-run", "--json"],
                CommandMode::Preview,
                "预览项目声明与工作流初始化；原生能力探测可能联网。",
                true,
            ),
            command(
                &["specgit", "init", "--json"],
                CommandMode::Apply,
                "创建或恢复项目声明、固定指导入口与所需本地状态；不授予平台写入权限。",
                true,
            ),
            InstallationCommand {
                argv: vec!["specgit", "skill", "--user", "--dry-run", "--json"],
                mode: CommandMode::Preview,
                side_effects: "显式预览用户级 Skill；不创建目录或文件，不安装全局 hooks。",
                requires_project: false,
                requires_network: false,
            },
            InstallationCommand {
                argv: vec!["specgit", "skill", "--user", "--json"],
                mode: CommandMode::Apply,
                side_effects: "显式安装用户级受管 Skill；用户级刷新或移除仅管理该 Skill，不含项目资产或全局观察状态。",
                requires_project: false,
                requires_network: false,
            },
        ],
        host_discovery: "not_performed",
        installation_verification: "not_performed",
        side_effects: "none",
        boundaries: vec![
            "本清单离线且不读取项目、宿主或网络；推荐不代表已安装、已信任、已加载或已验证。",
            "公共集成是项目内跨工具入口。共享 runtime 单独安装；唯一显式用户级 Skill 入口是 specgit skill --user，位置为用户目录 .agents/skills/specgit-native/SKILL.md；--refresh-only 仅刷新已有受管文件，--remove 仅移除未编辑的受管文件，先配合 --dry-run 预览；不安装全局 hooks 或全局观察状态。",
            "shared_baseline 是 project_skill 与 instruction_entry 的完整 bundle；默认新装 setup 不添加 hooks；已有收据刷新保留旧选择。",
            "旧 named-host 选择与已有收据保留兼容路径；刷新仅迁移有所有权证据的旧受管资产，未知资产不认领，不推断任意新宿主能力。",
            "worktree checkpoint、项目收据和观察状态私有；hooks 与 info/exclude 可能共享。setup owner 退役时保留共享 guard 证据，最后 consumer 退出时清理；卸载和回滚须核实 sibling consumers。",
            "既有会话授权在原范围内持续；目录、声明、收据、dry-run 和事件通知都不扩权；宿主项目访问及信任须另验。",
            "依赖缺失或项目必需项只阻止受影响操作；可选宿主配置缺失不应阻止无关的原生 CLI 或 CI。",
            "CLI、CI 与离线读取可独立使用；联网平台观察需要实际凭据，套餐或品牌名称不证明能力。",
            "保持原有资产、第三方 hooks、块外人工内容和并发修改；未知所有权、损坏标记或权限冲突须保留现场并解决。",
            "精确本地 exclude 不改 Git index，不把已跟踪文件变成未跟踪，不扩大忽略范围。",
            "固定 Skill 入口供新会话、压缩和恢复后按需重读；Agent 维护自定义宿主胶水并记录其位置，SpecGit doctor 不验证该胶水或真实宿主行为。",
            "SessionStart 提供短规则与 Skill 入口；PreToolUse 仅按需上下文；checkpoint 强制检查只在真实 Git commit/push。PostToolUse、Stop 与异步唤醒不受支持。",
            "commands.argv 是参数数组；尖括号值必须替换，不能直接拼接 shell；执行前以当前共享 CLI --help/--schema 与原生参考核实条件。",
        ],
        bundles: vec![InstallationBundle {
            id: "shared_baseline",
            members: vec![
                InstallationId::ProjectSkill,
                InstallationId::InstructionEntry,
            ],
            selection: "setup 默认完整安装；两个成员不是独立文件开关。",
        }],
        items,
    }
}

pub fn report() -> crate::report::Report {
    crate::report::Report::success(
        "setup",
        "catalog",
        serde_json::json!({ "installation_catalog": catalog() }),
    )
}

/// Render the same typed catalog without replacing ordinary reports with JSON text.
pub fn human() -> String {
    let catalog = catalog();
    let mut out = format!(
        "SpecGit {} 安装能力清单 v{}\n宿主发现与安装验证：未执行；本命令无副作用。\n",
        catalog.runtime_version, catalog.catalog_version
    );
    let _ = writeln!(
        out,
        "兼容：{}\n运行时：{}\n已有安装：{}",
        catalog.compatibility.catalog_contract,
        catalog.compatibility.runtime_contract,
        catalog.compatibility.existing_installations
    );
    for entry in &catalog.entrypoints {
        let _ = writeln!(
            out,
            "入口：{}\n  {}；需要项目：{}；需要网络：{}",
            entry.argv.join(" "),
            entry.side_effects,
            entry.requires_project,
            entry.requires_network
        );
    }
    for boundary in &catalog.boundaries {
        let _ = writeln!(out, "• {boundary}");
    }
    for item in &catalog.items {
        let requirement = match item.requirement {
            Requirement::Recommended => "推荐",
            Requirement::Optional => "可选",
            Requirement::Conditional => "按条件需要",
        };
        let _ = writeln!(
            out,
            "\n{} [{requirement}]：{}",
            item.id.as_str(),
            item.purpose
        );
        let _ = writeln!(out, "  范围：{}；维护：{}", item.scope, item.owner);
        if let Some(bundle) = item.bundle {
            let _ = writeln!(out, "  安装单元：{bundle}（完整 bundle）");
        }
        let _ = writeln!(out, "  位置：{}", item.locations.join("；"));
        if !item.depends_on.is_empty() {
            let dependencies: Vec<_> = item.depends_on.iter().map(|id| id.as_str()).collect();
            let _ = writeln!(out, "  依赖：{}", dependencies.join("、"));
        }
        for condition in &item.conditions {
            let _ = writeln!(out, "  条件：{condition}");
        }
        for recommendation in &item.recommendations {
            let _ = writeln!(out, "  建议：{recommendation}");
        }
        for command in &item.commands {
            let mode = match command.mode {
                CommandMode::Preview => "预览",
                CommandMode::Apply => "执行",
                CommandMode::Read => "读取",
                CommandMode::Invoke => "事件调用",
                CommandMode::Observe => "有界观察",
            };
            let network = if command.requires_network {
                "需要网络"
            } else {
                "无需网络"
            };
            let _ = writeln!(
                out,
                "  {mode}：{}（{network}）\n    {}",
                command.argv.join(" "),
                command.side_effects
            );
        }
        let _ = writeln!(out, "  协议：{}", item.protocol);
        let _ = writeln!(
            out,
            "  验证写入：{}\n  验证加载：{}\n  验证效果：{}",
            item.verification.written, item.verification.loading, item.verification.effect
        );
        let _ = writeln!(
            out,
            "  回退：{}\n  刷新：{}\n  移除：{}\n  回滚：{}",
            item.fallback, item.lifecycle.refresh, item.lifecycle.remove, item.lifecycle.rollback
        );
    }
    out
}
