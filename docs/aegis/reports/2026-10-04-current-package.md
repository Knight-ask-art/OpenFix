# OpenFix 最新 Windows 包与 smoke 清理验收

## 基线与结果

产品根为 `新版本/OpenFix`，分支 `feature/branding`；本切片初始本地 HEAD 为 `bfec5d194932efaec3dc561309805d925501aa89`，clean、与 origin 同步、一个工作树。最终包绑定业务源码 HEAD **`f9d680b9f8157068571065dc92a3288ac52e4f4d`**，包含自然度增强和既有 Token 优化。工程版本仍为 **0.11.1**。

FastCtx **`j-oj5yw5` 退出 0**：构建、**26 项发布静态校验、64 项 packaged smoke** 全通过。本机合成链路信心 B；正式 V1 发布与真实小说质量另有未覆盖门槛，不能由这次成功推断已完成。

## 实测发现与修复

### smoke 安装登记残留

旧 `openfix-smoke-Q9rBYd` 已没有目录或卸载器，两处 HKCU OpenFix 登记仍指向它；HKLM 32/64 均无对应登记。根因为旧 harness 删除目录前未卸载。先 export 两个精确登记到 `tmp/stale-smoke-registration-20261004/`，再清理并读回；没有删除用户真实安装或数据。

提交 **`d9e63e850e53ac9e0a765cf9dac3bdf74fd718fd`**：

- `desktop/scripts/packaged-smoke-installation.mjs`：安装前检查登记，通过本次 installDir/卸载器确认 ownership，只执行 owned 卸载器，等待实际退出并确认登记清除。foreign、查询失败、卸载失败均保留现场；`--keep` 保留环境。
- `desktop/scripts/packaged-smoke.mjs`：接入安装/卸载生命周期。
- `desktop/tests/packaged-smoke-installation.test.mjs`：28 个 fake registry/process 回归；与原 NSIS preflight 13 项共 **41 passed**，`j-8zn3cb` 退出 0，desktop lint/typecheck 通过。

### 实际自动备份 EBUSY

首轮 `j-87fcyi` 在自动备份复制 Chromium 分区 `Network/Cookies` 时失败，退出 1。安装、主界面、创作/AI/DOCX、重启数据/凭据通过；owned 卸载与目录清理成功。保留有效失败记录。

提交 **`f9d680b9f8157068571065dc92a3288ac52e4f4d`**：

- `desktop/src/main/ipc.ts`：四个数据操作入口把真实 `sessionData` 传给现有策略 owner。
- `desktop/src/main/data-manager.ts`：只有 session root 实际位于数据树内时，精确排除 canonical session root 与 `openfic-*` 分区内的 Network、旧 Cookies、LevelDB LOCK。
- `desktop/src/main/runtime/tar-extract.ts`：测量与复制共用显式 source filter。
- `desktop/tests/main/data-manager-session-profile.test.mjs`：归档/还原、路径隔离、同名普通数据保护。
- `desktop/tests/main/auto-backup-ipc.test.mjs`、`auto-backup-runtime-continuity.test.mjs`：真实 sessionData 接线与保存暂停/后端恢复回归。

IndexedDB 保存 writing/prompt working copies 与 Agent 草稿，因此保留 `.log/.ldb/.sst/CURRENT/MANIFEST`、数据库、凭据和草稿；不排除整个 Partitions/IndexedDB，不把普通 EBUSY 改为通用忽略，核心 symlink/锁错误仍拒绝。自定义数据树中同名 Network/LOCK 不被误排除。

`j-4hts2w` 退出 0：build:main、相关 backup/integrity/Data Manager/automatic backup Node **80 passed / 1 POSIX-only skipped**，desktop lint/typecheck 通过。这不证明 live IndexedDB 具有事务一致的快照；备份前保存与短暂暂停仍是原策略。

## 当前包内容与运行验收

`j-oj5yw5` 依次执行 package、verify:release、内容核对和 packaged smoke：

- 后端 **644** 个 `.py/.yaml/.yml` 与 wheel 逐字节一致，含 narrative-deslop、style-profile、Style Card、Context budget/metrics。
- 前端 **733** 个 artifacts 与 packaged resources 逐字节一致。
- 独立 `verify_delivery.mjs` 核对 **56** 个 desktop dist 文件与 app.asar 一致，含 data-manager/ipc/tar-extract；packaged wheel 与本地 wheel 一致。
- `verify_portable.py` 核对 ZIP 内 733 个前端文件、app.asar、wheel、app-update.yml 与当前构建一致。
- app.asar SHA-256：`a0794e7457d38346572fd83477274751fd060dfa0e7564a27ceb042e37af0785`。

64 项 smoke 覆盖：静默隔离安装、运行时首次安装、主界面/后端、V1 API、项目/属性/人物/状态/世界设定/大纲/章节正文、loopback OpenAI-compatible 模型、Inline candidate/accept、Agent 运行、一致性原文定位/分析、DOCX、重启数据/模型/Agent 对话/加密凭据、非空自动备份、owned 停机/卸载/登记和目录清理。

它使用合成数据与本地 fake model，不是第三方模型质量或小说盲评。

收尾另运行 `j-ltrge5`：Ruff、ty、自然度/Style Profile/完整 Context/Skill tools/Agent 与 Skill API 定向 **250 passed / 5.98s**，退出 0。自然度实现阶段完整后端 **2139 passed**、前端 452 文件 lint/typecheck、完整 desktop build 已通过；收尾没有重复全量后端。

## 当前交付资产

| 资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe` | 158,052,978 | `a968b1113488e67f767d473c48ad9c51f811415d7cb35df075fdc775d80c525b` |
| `desktop/dist-electron/OpenFix-0.11.1-win-x86_64.zip` | 188,491,061 | `8958ec5fdf55bbc3fba1477ee29516b9539fa11ead75c50a0fd2e63f0008cadb` |
| `desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe.blockmap` | 166,508 | `cd67618981a2bf66f3ba9c4c420e3b516abe9fc8a51a2e85f90d12e0e06cda7d` |
| `desktop/dist-electron/latest.yml` | 368 | `0cf470f91be59c5372dc0330890c2d80e5b2d699a89932d44cf228581fdf620b` |
| `desktop/backend-wheel/openfic-0.11.1-py3-none-any.whl` | 30,837,641 | `aa680c6c6eaa2483dd2968d4e67d8ba8e2a0fd3949c8bb423ca360edcc6b05c1` |

Authenticode 实际只读结果：**NotSigned、无 signer certificate、无 timestamp certificate**。signtool 构建步骤不是签名证据。

## 存储与清理

本轮 `openfix-smoke-RPW20E` 和最终 `openfix-smoke-SvhQsK` 均已由 owned 卸载/清理退出。独立读取实际 Windows 进程、监听端口、Temp 和 HKCU/HKLM 32/64 两类登记：owned process **0**、9224 listener **0**、smoke directory **0**、OpenFix registrations **0**。原 9000 开发服务 listener **1**，保留。

清理前验证精确路径属于工作区、realpath 无跳转、整树无 symlink、无引用进程；随后只删除本轮生成的：

- `desktop/dist-electron/win-unpacked`：394,198,230 bytes。
- `tmp/v1-latest-package-20261004/uv-cache`：1,752,623 bytes。

合计 **395,950,853 bytes**，清理后确认不存在。5 个交付文件的大小/hash 在清理前后完全一致。未清共享缓存、项目数据或交付文件，维持一个工作树。

小证据保留在 `tmp/v1-latest-package-20261004/`：contents/delivery/portable/signature/cleanup readback JSON 和核对脚本；原失败与最终 job 日志保留。

## 验收边界

仍未覆盖真实第三方模型小说质量、干净 Windows 11 从历史版本升级及原数据、native ARM64 首启、远端 Actions/双架构 Release、正式签名身份和证书链。GitHub 的默认分支为 main；本轮源码推送目标为既有 `feature/branding`，不等同 main 合入或 Release。

本机切片 **evidence-finalized**、信心 **B**；整体 V1 **needs-verification**。唯一续作记录继续为 `docs/aegis/work/2026-10-02-v1-completion`。Aegis bundle/check 只验证记录结构。
