# LLM Token 效率优化与本地交付 - Intent

## TaskIntentDraft

- Requested outcome: 基于当前本地 OpenFix 代码完成 Token 与上下文效率优化、验证，并将工作树内全部授权改动提交后仅推送到 origin/feature/branding。
- Goal: 减少重复和低价值输入 Token，同时保留小说连续性、人物认知边界与世界设定；以可观测数据和离线基准验证。
- Success evidence:
- 后端全量测试、Ruff/ty、前端和桌面质量检查、合成 benchmark；审查全工作树；本地提交成功；确认远端快进并推送 origin/feature/branding；明确报告未执行的真实 Provider 和 V1.0 发布门槛。
- Stop condition: 确认提交与 origin/feature/branding 推送后完成；若远端分歧、测试失败或推送结果不确定则 needs-verification。
- Non-goals:
- 不新增通用 Context/RAG/Memory 架构，不做实时供应商账单/质量评估，不做签名、发布或远端 Release。
- Scope: 仅 D:/Codex/projects/ai-novel/新版本/OpenFix 工作树；包含当前 Token 效率实现、所有用户授权的现有改动与必要计划/证据记录。
- Change kinds:
- implementation
- Risk hints:
- 既有未提交改动较多；保持全部现有改动，不 reset/clean，不 force push，不修改 upstream/OpenFic。

## BaselineReadSetHint

- feature/branding HEAD b2b2a8f687d3fa51b4c3a6e42db11f6dd40d71e5; origin/feature/branding 在 HEAD 后 25 提交；73 个已跟踪改动、22 个未跟踪路径；OPENFIX.md 与 2026-10-04-llm-token-efficiency.md。

## BaselineUsageDraft

- Required baseline refs:
- 新版本/AGENTS.md：OpenFix 边界、兼容性、隐私与测试规则
- OpenFix/OPENFIX.md §1-5：OpenFix 可写、OpenFic 上游只读；以本地实现为事实
- docs/aegis/plans/2026-10-04-llm-token-efficiency.md：当前代码审计、范围与验收
- feature/branding HEAD b2b2a8f；origin/feature/branding；开始时 73 tracked modified、22 untracked
- Delivered context refs:
- none
- Acknowledged before plan:
- 新版本/AGENTS.md
- OpenFix/OPENFIX.md
- docs/aegis/plans/2026-10-04-llm-token-efficiency.md
- 当前 git status/branch/remotes 与 origin ahead-25 状态
- Cited in plan:
- docs/aegis/plans/2026-10-04-llm-token-efficiency.md
- OPENFIX.md
- Missing refs:
- none
- Advisory decision: continue

## ImpactStatementDraft

- Compatibility boundary: 仅提交推送到 origin/feature/branding；保留 OpenFic upstream 为只读参照；保留当前 127.0.0.1:9000 前端开发服务器；本地源码交付不等于 V1.0 发布验收。
- Affected layers:
- backend/context, backend/audit, backend/retrieval, backend/storage, frontend, desktop, docs
- Owners:
- 当前协调者；仅本地 OpenFix 仓库。
- Invariants:
- 有效小说事实与上下文连续性优先；不改写远端基线；AI 创作行为仍由用户选择确认。
- Non-goals:
- 不新增通用 Context/RAG/Memory 架构，不做实时供应商账单/质量评估，不做签名、发布或远端 Release。

These records are Method Pack drafts / hints, not authoritative runtime decisions.
