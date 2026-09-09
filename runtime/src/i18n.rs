//! Presentation changes prose only; machine codes, identifiers and keys are stable.
use crate::{
    config::Language,
    diagnostic::{Code, Diagnostic},
    report::Report,
};
pub fn diagnostic(d: &mut Diagnostic, language: Language) {
    if language != Language::Zh {
        return;
    }
    let (message, remedy) = match d.code {
        Code::InvalidInput | Code::InputLimit => (
            "输入不符合命令或配置约束。",
            "检查字段、类型、重复键、模板选择和大小范围，然后重试。",
        ),
        Code::EvidenceRejected => (
            "当前原生证据尚未满足交付条件。",
            "修复报告中的阻塞项后重新检查。",
        ),
        Code::MigrationRequired => (
            "检测到旧版项目声明，需要明确迁移。",
            "使用旧版 CLI，或执行迁移操作；不要直接覆盖现有配置。",
        ),
        Code::AuthenticationFailed => (
            "所选原生 CLI 会话未通过身份验证。",
            "通过 gh auth login 或 glab auth login 登录所选主机后重试。",
        ),
        Code::PermissionDenied => (
            "当前会话没有读取或修改该资源的权限。",
            "检查原生平台上该操作的权限；不要把缺少证据视为通过。",
        ),
        Code::AmbiguousNotFound => (
            "资源不存在或当前会话无权访问。",
            "先核对项目身份和访问权限，再判断资源是否缺失。",
        ),
        Code::NetworkFailed | Code::RateLimited | Code::Timeout => (
            "网络、限流或超时使当前证据不可用。",
            "检查原生 CLI 的网络状态或等待限流解除后重试。",
        ),
        Code::IdentityMismatch | Code::ConcurrentEdit => (
            "项目身份、配置或文件在检查后发生变化。",
            "保留当前内容，重新检查后再明确执行操作。",
        ),
        Code::OwnershipConflict | Code::UnsafePath | Code::RollbackConflict => (
            "无法证明文件归属或安全恢复条件。",
            "保留用户修改和事务备份，检查路径、权限和恢复记录。",
        ),
        Code::LockBusy => ("另一个事务持有文件锁。", "等待当前事务结束后重试。"),
        Code::MissingExecutable | Code::UnsupportedOperation | Code::UnsupportedProvider => (
            "当前原生命令缺失或不支持所需操作。",
            "检查所选 Git、gh 或 glab 版本，并通过 doctor 重新验证。",
        ),
        Code::MissingProject => (
            "当前目录不是可用的 Git 工作区。",
            "切换到项目工作区；账号探测可使用 account-only。",
        ),
        Code::AmbiguousRemote | Code::AmbiguousRequest => (
            "存在多个候选远端或请求，无法确定唯一关联。",
            "明确选择所需远端或整理请求关联后重试。",
        ),
        Code::Cancelled => ("操作已中断。", "准备好后明确重试。"),
        Code::MalformedResponse | Code::OutputLimit => (
            "原生证据不完整、格式无效或超出读取范围。",
            "检查原生平台响应；缺失和未经检查的证据不能视为通过。",
        ),
        Code::ProcessFailed | Code::IoFailed => (
            "原生命令或本地文件操作失败。",
            "通过原生 CLI 或本地文件权限定位原因；保留现有内容。",
        ),
    };
    d.message = message.into();
    d.remedy = remedy.into();
}
pub fn report(report: &mut Report, language: Language) {
    for d in &mut report.diagnostics {
        diagnostic(d, language);
    }
    if let Some(probes) = report
        .evidence
        .get_mut("probes")
        .and_then(serde_json::Value::as_array_mut)
    {
        for probe in probes {
            if let Some(value) = probe.get_mut("diagnostic")
                && let Ok(mut d) = serde_json::from_value::<Diagnostic>(value.clone())
            {
                diagnostic(&mut d, language);
                if let Ok(v) = serde_json::to_value(d) {
                    *value = v;
                }
            }
        }
    }
}
