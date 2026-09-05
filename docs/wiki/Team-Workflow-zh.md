# 团队工作流

## 约定项目策略

`spec_git/policy.yaml` 保存团队要求的精确 check 名称，以及可选语言、标签、模板、
正文校验和合并自动化。`validation.titles`、`validation.labels`、
`validation.bodies` 分别启用对应规则。策略属于团队契约，不能为了让失败变绿而
削弱原本正确的检查。

可使用稳定的检查汇总名称，只有所有适用工作通过时才能成功。有意为空的必需检查
列表表示不要求业务 CI，平台验收仍保留。GitHub 通过分支保护要求 SpecGit Acceptance，
不要把它加入自己的 `required_checks`，造成自我等待。

## 按改动选择验证

| 改动 | 适用工作 |
| --- | --- |
| README、Wiki 或普通手写指导 | 一次相关内容复查与轻量检查 |
| CLI、生成器、schema、可执行 workflow 或分发 skill | 适用的产品测试与评审 |
| 文档与程序混合 | 按完整交付执行产品验证 |
| 已明确授权的软件包发布 | 在交付检查之外执行发布门禁 |

SpecGit 源仓库的纯说明修改使用 `node scripts/ci-metadata-check.mjs`，不构建产品，
也不进入反复代码评审。合并前仍保留轻量远程元数据检查与验收。接入项目自行决定
业务 CI 范围。小修改应排除已有的无关脏文件和顺手扩展的改进。

## 交付与收尾

每个可独立验证的 WHY 创建或复用一个 Issue，补全 PR/MR 正文，保留全部关闭引用，
然后推送最终复查过的改动。将请求标记为可评审，再对当前 head 执行
`specgit finish --json`。等待中的检查只需等待，普通文档修改不代表授权 npm 发布。

自动合并及目标分支只能由用户决定。启用后，可信完成工作流在 CI 后继续；
`specgit pr --merge --json` 以最新证据恢复中断的收尾。确认合并后才能关闭 Issue，
确认所有 Issue 关闭后才能报告完成。

对已确认的独立终态故障创建修复 Issue，同一原因复用已有条目。草稿请求、等待中
的 CI 和已过时 head 不构成新修复任务。原有无关缺陷应单独说明，不能自动扩大本次修改。

[团队契约](https://github.com/LeXwDeX/SpecGit/blob/main/docs/team-workflow.md) · [English](Team-Workflow)
