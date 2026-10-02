# OpenFix V1.0 完成验收 - Checkpoint

## Current Checkpoint

- Current todo: 本轮表单/人物与世界书深链、恢复运行时保护和跨平台打包接线已验证并本地提交；正式 V1 仍需继续 §42 剩余实现及验收。
- Active slice: v1-authoring-and-restore-boundaries-20261003
- Completed todos:
- 本地提交 aa590c15039d669780e51d0193538473d9fb92cb 已完成；201 文件，提交后 OpenFix 工作区干净且只有主工作树。
- 359c8114a889a7e700fce48441ff2d4ac6ed0219：恢复/回滚保护配置运行时，统一平台名称匹配及 IPC 路径策略。
- ebae8a3c1939c50616996cc5390a48f1f80ddf45：保留六平台矩阵，补 Windows/Linux ARM64 Python 映射和全平台 fork wheel staging，修复安装脚本参数/退出检查。
- 49935a428a33223f6d95141e1487a311852b9db1：表单失败保护、异步提交/缓存隔离，以及人物/世界书共享深链选择与离页项目 metadata 生命周期。
- Evidence refs:
- FastCtx j-9g2cte: frontend lint/type-check、完整 desktop build 和 36 个合成浏览器用例全部通过。
- FastCtx j-mnfh77: desktop lint/type-check/build:main、24 passed / 1 POSIX-only skipped / 1 privileged symlink excluded，YAML/六映射/安装脚本静态检查通过。
- docs/aegis/work/2026-10-02-v1-completion/evidence-bundle-draft-v1-authoring-and-restore-boundaries-20261003.json
- Blocked on: 正式 V1 仍需真实 provider、干净 Windows 11 升级、native ARM64 依赖/首启、远端双架构发布和签名验收；大纲与故事记忆的同类 URL 重入属于下一轮仓库修复。
- Next step: 从最新 Git log/status 接续本地里程碑和最终记录；下一轮修复大纲/故事记忆 A → null → A 重入，核实列表外项目展示，再逐项执行外部验收。

## Recent Checkpoint History

## 2026-10-03 Authoring And Restore Terminal Evidence

- Scope / decision: 本轮完成原 slice 的源码修复与本机验证，本地提交获用户明确授权。仅使用既有 API、Query/store 和桌面 backup/restore owner；V1 正式状态仍是 `needs-verification`。
- Forms: profile 必须与 project id 匹配后才可写属性；错误可重试且标题/简介仍可编辑。共享 async dialog 等待完整提交链，防止项目页与 onboarding 重复创建；每次表单会话隔离，profile PUT 成功结果先写入权威 query cache，避免立即重开写回旧属性。
- Deep links: 以共享 hook 退役两个页面的竞争初始化 effect，保留 navigation/run/manual revision 与 same-id guard。已验证 metadata 仅为当前选择和当前 URL 提供列表条目；URL 变化保留仍选中的离页项目，manual 改选退役旧条目。按当前 id 绑定的 query 在页面重挂载后恢复 metadata，URL 校验经同一 query key 复用在途请求/缓存；metadata 恢复不调用选择 setter。
- Restore: 配置顶层运行时在 backup、restore、cleanup 和 rollback 共用平台匹配策略；普通目录仍递归 lstat 拒绝 symlink。真实 IPC 策略验证外部 runtime junction、拒绝指向数据根内其他子树的 runtime link 和其他重叠；Windows 保留不同大小写的 runtime 与用户数据，POSIX 匹配规则仍区分大小写。
- Distribution: 两个现有 workflow 的六个 native target 保留并在打包前无条件 staging Python/uv/fork wheel；增加两个 pinned ARM64 asset 映射。NSIS /D 最后、Windows verbatim/hidden 参数和启动/退出失败检查仅做静态审查，没有运行安装器或 packaged smoke。
- Verification: j-9g2cte 退出 0，frontend 432 文件 lint/type-check 零警告/错误、desktop 完整 build、28 deep-link + 8 form = 36 browser passed。j-mnfh77 退出 0，desktop 静态/主进程构建、24 desktop passed、1 POSIX-only skipped；另一个需 Windows symlink 权限的用例由命令显式排除。YAML parse、六平台集合/顺序/guards、六个编译后 asset resolver 映射、unsupported target 和 harness syntax 检查通过。保留既有大 chunk warning。
- Review corrections: 表单独立质量复核确认 profile cache 竞态，已用 savedProfile/cache cancellation 修复。深链独立质量复核确认列表外 metadata 在 URL 变化和 SPA 重挂载时丢失，均已修复并加用例。restore Claude re-review j-2cj918 PASS，确认 Windows keep matcher 修复；其早前声称 matcher 传播到深层目录的观察被当前递归调用读回纠正，不能把该观察当缺陷。
- Evidence limits: 重挂载用例覆盖暖缓存返回；冷缓存/单独挂起的 remount metadata 只由当前 query key/id guard 源码支持。没有新 packaged smoke、真实供应商、旧版覆盖升级、native ARM64 依赖/首启或远端发布/签名证据；Windows ARM64 binary dependencies 仍需实机验收。
- Cleanup: 仅停止本轮 Vite job j-bckuz9，19003 无监听；在核实路径位于 OpenFix 且无 reparse point 后删除 tmp/openfix-ui-boundaries-results（45 bytes）。保留证据日志/审查材料，未新建工作树或 smoke 环境。
- Workspace integrity: 沿用唯一 work record，以 aegis-workspace.py bundle --root . --work 2026-10-02-v1-completion 更新 proof bundle；check --root . 通过，生成 pack 指向本 slice sidecar。这是记录结构验证，不是正式 V1 GateDecision。
- Next repository slice: outline-page.tsx:73-85 与 story-memory-page.tsx:122-131 在 URL 变 null 时没有重置 applied ref，存在同类 A → null → A 重入缺口；本轮仅只读核实，没有修改或运行验收。其列表外项目展示继续核实，不宣称全部深链消费者已完成。

## 2026-10-03 Authoring And Restore Slice Cards

- TaskStartSnapshot: OpenFix `feature/branding`, HEAD `aa590c15039d669780e51d0193538473d9fb92cb`; source worktree was clean before this record update; one registered worktree. Coordinator owns staging/commits and shared evidence. User requested parallel Claude Code work; three implementers have disjoint file ownership and must not run shared builds while others are editing.
- Parent authority: source-change list §42 (create/import → character/world setup → writing → backups → upgrade with original data), V1 PRD, existing Phase 5 plan. Formal V1 remains unverified.
- Form slice: Goal preserve loaded profile values and submit each create/update transaction once. Files project-form-dialog, projects-page, onboarding-wizard, scoped locales and one focused E2E spec. CanonicalOwner is the shared dialog async submit lifecycle and the project-profile query result. PatchShape is an owner-level async boundary repair; pending=false is not proof that a profile loaded. Decision code-change; TDD off/skipped. Verify failed/delayed profile reads and delayed profile PUT on both entry points, plus lint/type/build.
- Deep-link slice: Goal resolve the explicit URL project regardless of the first 100 list entries and prevent preference restoration from overwriting URL/manual selection. Files character/world pages, one shared project-selection hook and one focused E2E spec. CanonicalOwner is initial project selection; the current two competing effects lack a shared async cancellation boundary. Decision code-change; retire duplicate initialization effects, preserve manual project choice and valid cached fallback. TDD off/skipped; verify delayed preference, URL project outside list, URL changes, invalid URL and manual selection.
- Restore slice: Goal retain the configured app runtime during verified user-data restore and rollback. Files data-manager, tar-extract, IPC and focused archive/data-manager regressions. CanonicalOwner is top-level copy/cleanup/rollback policy with configured runtime exclusion passed by IPC. Decision code-change; do not globally classify every directory named runtime as disposable or alter portable Python extraction/migration. TDD off/skipped; verify archives with/without an old runtime, rollback and normal user-data cleanup.
- Stop/unknown: reviewers and coordinator must verify each slice; no package smoke, new worktree, provider key use, push, tag, release or signature. Direct browser regressions use isolated synthetic data/API stubs and do not constitute real provider/full-release acceptance.
- Distribution follow-up owned by coordinator: retain all six existing desktop matrix targets, add the two verified ARM64 Python mappings, and make fork-wheel staging unconditional across the existing native runners. Live GitHub release metadata confirms CPython 3.13.14 / 20260623 standard Windows ARM64 (43,707,977 bytes) and Linux ARM64 (91,182,150 bytes) assets. Decision code-change at resolver and workflow producer owners; existing local resolver/build checks and workflow static validation do not prove native ARM64 startup or remote release.
- Harness follow-up owned by coordinator: the installer phase awaited exit without checking its code and did not observe spawn errors; Node's default Windows quoting violates NSIS's unquoted final /D rule for space-containing destinations. Decision code-change at the existing spawn/await owner: retain /D last, use Windows verbatim arguments and fail on startup/nonzero exit. Only syntax/static review is authorized here; do not execute the harness or any installer.

## Checkpoint Update

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

## DriftCheckDraft

- Scope status: 本轮 authoring/restore/distribution 源码门禁和针对性回归通过，已按用户授权分主题本地提交；仍继续完整 §42 目标。当前后端未改变，迁移唯一头保持 1028。
- Compatibility status: 保留 OpenFix 既有工作、唯一主工作树、外层 ai-novel 和只读 OpenFic。当前 source checks 不等同于当前安装包 runtime、真实 provider、干净升级或 ARM64 发布验收。
- Retirement status: 人物/世界书竞争初始化 effect 已退役；保留既有 API/store 合同和内部 openfic wheel。配置 runtime 仅在 backup/restore 顶层策略显式保护，普通子树仍检查 symlink；migration/portable 默认行为保留。未清理用户数据，继续遵守不重跑 packaged smoke 的指令。
- New risk signals:
- 上轮确认的表单、人物/世界书、asset mapping、fork wheel 和 restore runtime 缺口在本轮修复/验证；大纲与故事记忆的 URL 重入另列下一轮，不扩大此次提交范围。
- Windows 符号链接用例仍缺少本机权限；冷缓存 remount 没有专门 fixture，当前安装包不覆盖最新源码，Windows ARM64 binary dependencies/首启与真实供应商、升级、远端 release、签名仍待验收。
- Advisory decision: needs-verification
