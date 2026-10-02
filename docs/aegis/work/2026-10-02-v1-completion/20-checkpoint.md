# OpenFix V1.0 完成验收 - Checkpoint

## Current Checkpoint

- Current todo: 按用户最新授权保存 OpenFix 当前 V1.0 开发里程碑；源码门禁通过，正式 V1.0 仍有仓库缺口及外部验收门槛。
- Active slice: v1-local-commit-20261003
- Completed todos:
- 修复迁移链测试的陈旧 1027 断言并明确校验 1028 的父迁移；目标 3 passed，Ruff 与 ty 通过，后端完整套件 1889 passed。
- 前端 lint/type-check 通过；桌面 lint/type-check/build 通过，包含前端 production build。Windows 自带 tar 下 archive/data-manager 12 passed；符号链接用例因本机权限不足未覆盖。
- 核对提交候选路径、凭据模式、CRLF-aware whitespace 与已有 x64 release 资产静态门禁；授权范围为 OpenFix 的当前 V1 开发进度。
- Evidence refs:
- C:/Users/20969/.fastctx/jobs/j-taig3r/output.log
- C:/Users/20969/.fastctx/jobs/j-v44ehv/output.log
- C:/Users/20969/.fastctx/jobs/j-9za1x2/output.log
- Windows native tar: node --test excluding the privileged symbolic-link case => 12 passed; pnpm verify:release => ALL CHECKS PASSED
- Blocked on: 正式验收仍需真实 provider、干净 Windows 11 旧版升级、远端双架构 Actions/Release、签名身份和当前包运行证据；仓库内项目属性失败保护、项目页及 onboarding 的 profile PUT 在途重复创建保护、人物 / 世界书深链选择、ARM64 runtime、各平台 fork wheel 和恢复运行时保留仍待处理，当前可以继续推进。
- Next step: 先通过最新 git log/status 核对本地里程碑提交；继续修复仓库内剩余项并对照 §42 验收，保留不重跑 packaged smoke 的用户限制。

## Recent Checkpoint History

## Checkpoint Update

- Current todo: Phase 5 release tag/package version guard is implemented, independently reviewed, and locally verified; formal V1.0 remains needs-verification.
- Active slice: phase5-release-version-guard-20261003
- Completed todos:
- Corrected the stale Claude Code authentication stop condition and aligned the historical smoke sidecar artifact key with its filename; retained the original timeline and marked login as historical.
- Added fail-closed release-tag version validation: GitHub Actions requires OPENFIX_RELEASE_VERSION and compares it with desktop/package.json in both package and prepared-assets verifier modes; both Release jobs inherit the value from the tag-derived context output.
- Claude Code spec re-review and code-quality review passed; node --check, scoped git diff --check, and pnpm --dir desktop verify:release all passed.
- Evidence refs:
- C:/Users/20969/.fastctx/jobs/j-4q6ypv/output.log
- C:/Users/20969/.fastctx/jobs/j-n8hvfy/output.log
- C:/Users/20969/.fastctx/jobs/j-uuw63c/output.log
- node --check desktop/scripts/verify-release.mjs; git diff --check scoped paths; pnpm --dir desktop verify:release => ALL CHECKS PASSED
- Blocked on: Formal V1.0 still needs real provider user flow, clean Windows 11 upgrade with retained data, remote GitHub Actions and dual-architecture Release, verified Windows signing identity/certificate chain, and current-source x64 package runtime proof; preserve the explicit instruction not to rerun packaged smoke.
- Next step: Keep formal status at needs-verification. Resume each external gate only when its real provider, clean upgrade host, remote dual-architecture release path, and signing identity are available; preserve the current no-smoke instruction unless the user changes it.
## Checkpoint Update

- Current todo: Phase 5 release tag/package version guard is implemented, independently reviewed, and locally verified; formal V1.0 remains needs-verification.
- Active slice: phase5-release-version-guard-20261003
- Completed todos:
- Corrected the stale Claude Code authentication stop condition and aligned the historical smoke sidecar artifact key with its filename; retained the original timeline and marked login as historical.
- Added fail-closed release-tag version validation: GitHub Actions requires OPENFIX_RELEASE_VERSION and compares it with desktop/package.json in both package and prepared-assets verifier modes; both Release jobs inherit the value from the tag-derived context output.
- Claude Code spec re-review and code-quality review passed; node --check, scoped git diff --check, and pnpm --dir desktop verify:release all passed.
- Evidence refs:
- C:/Users/20969/.fastctx/jobs/j-9fca6d/output.log
- C:/Users/20969/.fastctx/jobs/j-n8hvfy/output.log
- C:/Users/20969/.fastctx/jobs/j-uuw63c/output.log
- node --check desktop/scripts/verify-release.mjs; git diff --check scoped paths; pnpm --dir desktop verify:release => ALL CHECKS PASSED
- Blocked on: The latest current-source x64 package has no smoke evidence; do not rerun packaged smoke under the existing user instruction.
- Next step: Keep formal status at needs-verification. Resume each external gate only when its real provider, clean upgrade host, remote dual-architecture release path, and signing identity are available; preserve the current no-smoke instruction unless the user changes it.
## Checkpoint Update

- Current todo: 所有可在本机完成的后端回归、前端和桌面构建、当前 x64 打包与发布静态校验已通过；当前包未运行 smoke，正式 V1.0 保持 needs-verification
- Active slice: v1-current-source-build-20261002
- Completed todos:
- Story Memory 隐藏笔记可见性修复及 freshness 回归通过；33 个目标测试和 1 个一致性 stale-context 测试通过，Claude Code 两阶段复核通过
- 后端 ruff、ty 和完整 pytest 套件通过，1884 passed
- 前端 lint、type-check、production build 通过；429 个文件零 lint/type 错误，保留大 chunk warning；桌面 lint、TypeScript 检查和 build 通过
- 当前工作树打包得到 Windows x64 EXE 与 ZIP，pnpm verify:release 对新包输出 ALL CHECKS PASSED
- 旧 smoke sidecar 标记为 superseded 并与真实时间线对齐；没有重跑 smoke，当前 package cache 和旧 smoke temp/cache 路径复核清理
- Evidence refs:
- docs/aegis/work/2026-10-02-v1-completion/evidence-bundle-draft-v1-current-source-build-20261002.json
- docs/aegis/work/2026-10-02-v1-completion/evidence-bundle-draft-story-memory-hidden-note-visibility-20261002.json
- docs/aegis/work/2026-10-02-v1-completion/90-evidence.md
- OPENFIX.md
- FastCtx jobs j-ygbcaf, j-hgt5fn, j-ex6kxv, j-g2uxy0, j-fmp9ly, j-vrh34h
- Blocked on: 真实供应商用户链路、干净 Windows 11 旧版覆盖升级及数据保留、远端 GitHub Actions / 双架构 Release、Windows 签名身份和证书链仍需外部环境或权限；本机缺少 aarch64 发布资产。
- Next step: 完成本地证据结构与工作树差异核对后，保持正式状态为 needs-verification，等待真实 provider 配置与可用验证窗口、干净 Windows 11 升级环境、远端 Actions/Release 权限及有效签名身份。按用户要求不重跑 packaged smoke，不执行 tag、push、Release、sign 或 commit。
## Checkpoint Update

- Current todo: 本机可执行的 V1.0 残余修复、回归与记录同步已完成；等待外部验收条件后继续，正式状态保持 needs-verification
- Active slice: v1-external-acceptance-gates-20261002
- Completed todos:
- 隐藏笔记 Story Memory 修复完成，目标回归 33 passed、一致性 freshness 回归 1 passed；Ruff、ty、targeted diff check 通过，Claude Code spec 与 quality 两阶段审阅均 PASS
- OPENFIX 与 evidence/checkpoint/sidecar 已同步；Aegis workspace check 与目标文档 diff check 均通过
- Evidence refs:
- docs/aegis/work/2026-10-02-v1-completion/evidence-bundle-draft-story-memory-hidden-note-visibility-20261002.json
- OPENFIX.md
- docs/aegis/work/2026-10-02-v1-completion/90-evidence.md
- python aegis-workspace.py check --root .: PASS
- Blocked on: 真实供应商用户链路、干净 Windows 11 旧版覆盖升级及数据保留、远端 GitHub Actions / 双架构 Release、Windows 签名身份与证书链仍需要对应环境、权限或证书；本机没有 aarch64 更新资产。
- Next step: 收到真实 provider 配置与允许的验证窗口、干净 Windows 11 升级环境、远端 GitHub Actions / Release 权限及有效签名身份后，再逐项执行 §42 外部门槛；当前不重跑 packaged smoke，不执行 tag、push、Release、sign 或 commit。
## Checkpoint Update

- Current todo: 完成 V1.0 本机证据同步与 workspace 结构检查；正式状态保持 needs-verification，等待外部验收门槛
- Active slice: v1-final-readiness-and-evidence-sync-20261002
- Completed todos:
- 修复 Story Memory 隐藏笔记泄漏：构建 / 计数显式排除隐藏笔记，搜索 hydration 实时拦截；规格与代码质量复核均 PASS
- Evidence refs:
- docs/aegis/work/2026-10-02-v1-completion/evidence-bundle-draft-story-memory-hidden-note-visibility-20261002.json
- C:/Users/20969/.fastctx/jobs/j-5tua8z/output.log
- C:/Users/20969/.fastctx/jobs/j-7j40k6/output.log
- C:/Users/20969/.fastctx/jobs/j-6w3k25/output.log
- C:/Users/20969/.fastctx/jobs/j-1equ2e/output.log
- Blocked on: 真实供应商用户链路、干净 Windows 11 旧版覆盖升级及数据保留、远端 GitHub Actions / 双架构 Release、Windows 签名身份与证书链仍待实际环境验收；本机无 aarch64 更新资产。Claude Code 第三方 API 接入正常，登录不是 blocker。
- Next step: 完成 docs/aegis/work 记录、OPENFIX.md 与目标 whitespace 检查；随后只保留 needs-verification 状态并列明所需外部验收证据，不执行 smoke 重跑、tag、push、Release、签名或 commit。

## DriftCheckDraft

- Scope status: 当前源码验证通过并获用户明确本地提交授权；保存 V1 开发里程碑，仍继续完整 §42 目标。迁移唯一头已随跨卷回滚修复更新为 1028。
- Compatibility status: 保留 OpenFix 既有工作、唯一主工作树、外层 ai-novel 和只读 OpenFic。当前 source checks 不等同于当前安装包 runtime、真实 provider、干净升级或 ARM64 发布验收。
- Retirement status: 仅同步迁移链测试与当前验收记录；未新增运行时实现或兼容分支，未清理用户数据。继续遵守不重跑 packaged smoke 的指令。
- New risk signals:
- 当前源码已确认项目属性查询失败后的写入保护缺口、项目页及 onboarding 的 profile PUT 在途重复创建窗口、人物 / 世界书项目深链选择缺口及 ARM64 Python asset 支持缺口；非 Windows fork wheel 和 restore runtime 保护继续按原计划修复，不能只等待外部条件。
- Windows 符号链接用例缺少本机权限，当前 x64 包未覆盖最新源码；外部供应商、升级、远端 release、签名和双架构环境仍待验收。
- Advisory decision: needs-verification
