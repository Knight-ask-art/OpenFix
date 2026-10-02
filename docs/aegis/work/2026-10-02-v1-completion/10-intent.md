# OpenFix V1.0 完成验收 - Intent

## TaskIntentDraft

- Requested outcome: 按 V1.0 PRD 和源码改造清单第42节完成实现、回归与本机发布验收；正式发布所需的外部门槛单独列明
- Goal: 确保创作数据链路稳定、AI 可见性与索引新鲜度正确，AI 上下文面板反映本次真实模型输入，并完成本机打包验收
- Success evidence:
- 目标消费者回归测试通过，Story Memory 源创建更新删除与可见性切换后状态正确，上下文快照只含实际送模的安全来源元数据，前后端类型检查/构建及发布校验和安装包冒烟通过；外部发布门槛独立列明
- Stop condition: done: 全部本机门槛通过且无代码 blocker；blocked: 同一必要外部服务或环境阻塞连续复现三轮；needs-verification: 构建/测试未运行或外部 Windows 签名升级未验收；scope-exceeded: 需要真实发布/签名身份
- Non-goals:
- OpenFic 上游、真实发布/签名、清理项目既有改动、未排期的全书检查任务化
- Scope: 新版本/OpenFix 中 V1.0 残余实现与本机验收；不修改 OpenFic 上游；2026-10-03 用户明确授权本地里程碑提交；不创建 tag/Release，不签名/推送
- Change kinds:
- bugfix
- Risk hints:
- 中高：多个 AI 消费者、检索 freshness 与现有未提交工作树

## BaselineReadSetHint

- 新版本/docs/02-prd-v1.md §§17-20,33
- 新版本/docs/03-source-change-list.md §42
- OPENFIX.md §§240-302
- HEAD 958efb79c103b05cc9a59405a16bbce2e714d1cd / feature/branding

## BaselineUsageDraft

- Required baseline refs:
- 新版本/docs/02-prd-v1.md §§17-20,33
- 新版本/docs/03-source-change-list.md §42
- OPENFIX.md §§240-302
- HEAD 958efb79c103b05cc9a59405a16bbce2e714d1cd / feature/branding
- Delivered context refs:
- none
- Acknowledged before plan:
- 新版本/docs/02-prd-v1.md §§17-20,33
- 新版本/docs/03-source-change-list.md §42
- OPENFIX.md §§240-302
- HEAD 958efb79c103b05cc9a59405a16bbce2e714d1cd / feature/branding
- Cited in plan:
- 新版本/docs/02-prd-v1.md §§17-20,33
- 新版本/docs/03-source-change-list.md §42
- OPENFIX.md §§240-302
- HEAD 958efb79c103b05cc9a59405a16bbce2e714d1cd / feature/branding
- Missing refs:
- none
- Advisory decision: continue

## ImpactStatementDraft

- Compatibility boundary: 复用既有 RetrievalIndex 与 Story Memory API；只在必要时追加向后兼容迁移；保留既有未提交 V1 改动
- Affected layers:
- backend retrieval / context / storage / agent; frontend story-memory status; desktop release verification
- Owners:
- world_entry_meta_service and Story Memory index/status/search owners
- Invariants:
- ai_visible=false 即刻对模型生效；stale index 不可向 Agent 提供旧数据；source snapshot 改变后不得显示 ready
- Non-goals:
- OpenFic 上游、真实发布/签名、清理项目既有改动、未排期的全书检查任务化

These records are Method Pack drafts / hints, not authoritative runtime decisions.
