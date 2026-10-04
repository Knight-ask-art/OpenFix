# OpenFix V1.0 完成验收 - Intent

## TaskIntentDraft

- Requested outcome: 按 V1.0 PRD 和源码改造清单第42节完成实现、回归与本机发布验收；正式发布所需的外部门槛单独列明
- Goal: 确保创作数据链路稳定、AI 可见性与索引新鲜度正确，AI 上下文面板反映本次真实模型输入，并完成本机打包验收
- Success evidence:
- 目标消费者回归测试通过，Story Memory 源创建更新删除与可见性切换后状态正确，上下文快照只含实际送模的安全来源元数据，前后端类型检查/构建及发布校验和安装包冒烟通过；外部发布门槛独立列明
- Stop condition: done: 全部本机门槛通过且无代码 blocker；blocked: 同一必要外部服务或环境阻塞连续复现三轮；needs-verification: 构建/测试未运行或外部 Windows 签名升级未验收；scope-exceeded: 需要真实发布/签名身份
- Non-goals:
- OpenFic 上游、真实发布/签名、清理项目既有改动、未排期的全书检查任务化
- Scope: 新版本/OpenFix 中 V1.0 残余实现与本机验收；不修改 OpenFic 上游；用户已明确授权完成后提交所有项目改动并推送自有 OpenFix 仓库，覆盖此前仅本地提交的限制；不创建 tag/Release 或使用正式签名身份。2026-10-04 验证包含自然度增强与 Token 优化的最新包，并修复 smoke 安装生命周期及实际自动备份文件锁。
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

## 当前切片：最新包与 smoke 安装清理（2026-10-04）

- 父验收：源码改造清单 §42 与打包路线 Phase 5。基线 `bfec5d194932efaec3dc561309805d925501aa89` / `feature/branding`，起始 clean、ahead/behind 0/0、一个工作树。
- 问题证据：旧 smoke `openfix-smoke-Q9rBYd` 目录和卸载器均已不存在，但 HKCU 的 OpenFix InstallLocation/UninstallString 两处登记仍指向它；HKLM 两个视图均无对应登记。
- 修复所有者：harness 的安装生命周期。现有 NSIS 注册、升级前保护与卸载删除登记逻辑正常；旧 harness 只停止进程和删除工作区，没有调用卸载器，是登记残留的复现机制。
- 因果拓扑：单一根因链（未卸载 → 残留登记 → 下次安装旧卸载器保护拒绝）。反证检查：NSIS 模板确实在卸载路径删除两处登记，旧工作区不存在，harness 无卸载调用；不把生产保护改为忽略缺失旧卸载器。
- 修改必要性：仅清理这次旧登记不能防止下一次 smoke 重现；选择 `code-change`。范围为原 smoke 的接线、小安装生命周期 helper 与 Node fake 回归，无新增产品 owner、依赖、migration 或 Provider。
- 复杂度：原 harness 1122 行已有软压力，选择提取 helper、原文件只接线；helper/test 保持单一职责。失效条件保留现场，`--keep` 保留安装。
- TDD 路由：Mode off / Decision skipped；用户明确要求补测试，按 owner 和实际安装/卸载接缝做比例验证，无 RED-first 要求。
- 验证：mock registry/process 回归、原 NSIS preflight 回归、syntax/lint/typecheck、当前 EXE 的隔离运行、owned 卸载登记与目录清理。每项读取实际终态，不以旧包或 Claude 报告代替。
- Claude Code `j-zdopbm` 因第三方网关 502 退出 1，没有修改或审核结论；协调者直接实现并验证。
- 清理：旧两处精确登记先 export 到 `tmp/stale-smoke-registration-20261004` 再删除，立即复查两 hives/views 均无 OpenFix 登记；未删除用户真实安装或项目数据。

## 同一切片的实际备份缺陷与收尾

- 首轮 `j-87fcyi` 的自动备份因 Chromium 分区 `Network/Cookies` 被占用而失败，退出 1；owned 卸载与目录清理成功。保留这次失败，不以之后成功改写原结果。
- 事实边界：原 IndexedDB 包含 writing/prompt working copies、Agent 输入草稿和偏好，不能排除整个 `Partitions` 或 `IndexedDB`。只在 canonical session root 及 `openfic-*` 分区内排除网络状态与 LevelDB 的进程 `LOCK`；保留实际数据库记录、正文、凭据、草稿以及自定义数据目录中的同名文件。
- CanonicalOwner 为现有 Data Manager、IPC 数据操作策略和 `copyTree`/`measureTreeSize`，范围是 3 个生产文件及 3 个回归文件。通用锁、symlink 仍拒绝；不新增 backup owner、依赖、migration 或静默 EBUSY 跳过。
- 提交 `d9e63e8`（smoke 生命周期）和 `f9d680b`（session backup policy）。Node 回归 41 passed 与 80 passed/1 POSIX-only skipped；desktop lint/typecheck/build:main 通过。
- 最新 `j-oj5yw5` 在源码 HEAD `f9d680b9f8157068571065dc92a3288ac52e4f4d` 打包、26 项发布静态校验、644 后端/733 前端逐字节核对、64 项合成 packaged smoke 全部通过，退出 0。附加核对 56 desktop dist 文件与 app.asar，以及 ZIP 的 frontend/wheel/asar/update 配置一致。
- 收尾独立验证：smoke Temp 目录、OpenFix 安装登记、本次进程均为 0，9224 已释放，原 9000 服务保留。精确删除展开目录和独立 UV 缓存共 395,950,853 bytes；交付资产清理前后 hash 一致。
- 本机切片 evidence-finalized / 信心 B；完整 V1 正式发布仍需真实模型、干净 Windows 11 历史升级与原数据、native ARM64、远端 Actions/Release 和签名验证。当前版本 0.11.1，安装包实测 NotSigned；本机成功不能关闭这些外部门槛。

## 当前切片：作者样本与指定真实模型（2026-10-04）

- 用户授权配置本地兼容网关、分析本人样本并采用项目文风；实测固定 `cline-pass/mimo-v2.6-flash` 与 `cline-pass/deepseek-v4.1-flash`。沿用当前 Notes/Skills/dispatch/加密凭据，只存候选，不覆盖原章。
- 本地切片基线 `edcd674f28054133e88e8f11ba4b7ffcac33feb2` / `feature/branding`，开始 clean、与远端同步，一个工作树；本轮末尾授权提交全部本轮成果并推送自有 OpenFix。
- 真实空正文引出的判定修复只涉及现有 SubagentRunner 和同 owner 测试：最新 HumanMessage 为回合边界，最新空 AI 不能回退旧正文，tool-call 前言不是最终答案，合法 text blocks 正常读取。分类为 `local-fix-without-new-responsibility`，不新增迁移、Provider 或工作流 owner。
- 方法、真实 Token 数字、失败和人工质量复核见 `docs/aegis/reports/2026-10-04-author-model-validation.md` 与对应 benchmark JSON。当前新包与原有 smoke 分开，保留不重跑 packaged smoke 的用户限制。
- 用户数据、原文、输出和凭据留在本地加密应用数据中，Git 只提交修复/测试/匿名报告。长篇质量、历史升级/native ARM64、远端 Release/签名仍为正式 V1 的未覆盖门槛。
