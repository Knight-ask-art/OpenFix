# OpenFix V1.0 完成验收 - Evidence

## 本机代码门禁（2026-10-02）

- Action: `uv run ruff check . && uv run ty check app && uv run pytest -q`，FastCtx job `j-7wzemr`
- Result: PASS；1870 tests passed in 161.13s
- Covered scope: backend lint、type check 与完整后端测试套件
- Uncovered scope: 外部模型服务提供商的真实用户调用验收
- Residual risk: 无本机测试失败；真实供应商行为尚未覆盖
- Confidence: B（本机后端目标及回归覆盖）

- Action: frontend `pnpm lint && pnpm type-check && pnpm build`，job `j-22wpo3`；desktop `pnpm lint && pnpm type-check`，job `j-x3n1fi`
- Result: PASS；前端 429 个文件 lint/type-aware lint 无错误，production build 成功；桌面 lint 与 TypeScript 检查退出码 0
- Covered scope: 前端与桌面源码静态检查及前端 production build
- Uncovered scope: 本机包在全新 Windows 11 安装和覆盖升级环境中的验收
- Residual risk: bundle 约 3.9 MB，tokenizer chunk 约 2.3 MB，存在体积 warning
- Confidence: B

## Windows 安装包与冒烟（2026-10-02）

- Action: `UV_CACHE_DIR=/tmp/openfix-v1-uv-cache-20261002 pnpm package`，job `j-7s61m5`
- Result: PASS；Windows x64 EXE 158037204 bytes、ZIP 188471980 bytes。SHA-256 分别为 `56af012211773a50bf3999b7a07f9c28d4edaaec57f025fe2d57c1f8a4ae9d0a`、`a3d24a66640818124253dc2eff6968b66e0202e3ed1b15712485f5862e49b447`
- Covered scope: 当前工作树构建 Windows 安装包和便携 ZIP
- Uncovered scope: 证书链验证的签名身份、实际 GitHub Release / Actions、干净 Windows 11 覆盖升级与数据保留
- Residual risk: 构建日志显示 signtool 阶段，但签名证书身份与验证状态尚未核实；不能据此声称包已签名
- Confidence: B（包构建与散列已复核，签名另列未验证）

- Action: `pnpm verify:release`，job `j-jihkxu`
- Result: PASS；产物、`latest.yml` 文件 / sha512 / size、wheel 版本、GitHub 更新源身份和 V1 前端路由标记全部通过
- Covered scope: 本机 Release 资产和配置静态不变量
- Uncovered scope: 远端 workflow 实际运行、真实 Release 发布与真实升级
- Residual risk: 静态不变量不能替代远端发布和 Windows 覆盖升级
- Confidence: B

- Action: `node scripts/packaged-smoke.mjs`，job `j-yo4yji`
- Result: PASS 37/37；隔离临时安装和 Electron profile，首启运行时安装、主窗口与后端、11 个 V1 路由、合成项目 / 大纲 / 人物 / 世界观 / 章节链路、Story Memory、一致性路由、DOCX 导出下载、Data Manager 自动备份以及临时目录清理均通过
- Covered scope: 当前 Windows 包中的无真实模型合成产品链路
- Uncovered scope: 模型真实调用、真实升级及跨机器数据迁移
- Residual risk: 合成项目不证明真实第三方模型行为
- Confidence: B

## 历史失败的更新结论

- Earlier action: packaged smoke job `j-w8ywhb` failed at auto-backup with `EPERM` because installer target and Electron profile overlapped
- Latest disposition: smoke paths were separated; the later job `j-yo4yji` completed 37/37 and removed its isolated temporary directory. The earlier failure is historical, not the current package result

## 未覆盖的 V1.0 正式发布门槛

- 真正的供应商模型调用与用户链路验收
- 干净 Windows 11 环境从旧版覆盖升级，确认原项目数据保留
- GitHub Actions 在远端真实执行、自有仓库 Release 资产发布
- Windows 代码签名证书身份、签名产物和证书链验证

这些门槛需要对应外部服务访问、签名身份或独立 Windows 环境；本机静态检查和合成冒烟不会替代它们。

## 最新续作切片（2026-10-02）

- Action: `uv run ruff check . && uv run ty check app && uv run pytest -q`，FastCtx job `j-qyjop2`
- Result: PASS；完整后端套件 1880 passed in 153.70s。随后本轮再次运行 ruff / ty，并对快照生成、隐藏历史、图上下文、persister、task projection、SessionRunner、SubagentRunner 7 个测试文件定向复跑，99 passed。
- Covered scope: 最新后端实现与回归、上下文快照用户文本泄漏哨兵、成功结果筛选和父 / 子会话快照隔离
- Uncovered scope: 真实外部模型调用、供应商级用户验收
- Residual risk: Claude Code 本轮无法登录，未取得新的 Claude 独立审查结果；不能用 API Key 状态或先前超预算调用代替复审
- Confidence: B（主代理检查源码并运行本机门禁；既有独立复核指出的参数标签缺口已修复并加入回归）

- Action: frontend `pnpm lint && pnpm type-check && pnpm build`；desktop `pnpm lint && pnpm type-check`
- Result: PASS；前端 429 个文件 lint / type-check 零错误，production build 成功；桌面端 lint 和两套 TypeScript 项目检查退出码 0
- Covered scope: 当前前端和桌面源代码静态检查、前端 production build
- Uncovered scope: 独立 Windows 11 升级与实际签名发布
- Residual risk: Vite 报告现有大 chunk warning（主入口约 3.87 MB，tokenizer chunk 约 2.33 MB）
- Confidence: B

- Action: 复算当前 `desktop/dist-electron` 产物散列，并再次运行 `pnpm verify:release`
- Result: PASS；setup EXE 158,039,308 bytes，SHA-256 `aedbb0cbc26421f8ff24d7d49382422d81cbf02a8b0c484d35daddc8d3bffb11`；ZIP 188,474,245 bytes，SHA-256 `3243b043d0d756dda39a4babf8ff6f5e171d352354c06f18c99fe29b33ae48c3`；`ALL CHECKS PASSED`
- Covered scope: 本机当前 Windows x64 产物存在性、更新清单、资产哈希 / size、wheel、OpenFix GitHub 更新源和 V1 bundle 标记
- Uncovered scope: 远端 Actions / Release、安装后自动更新、签名证书链
- Residual risk: 本机生成的包不能证明已签名；构建日志出现 signtool 步骤不构成签名证据
- Confidence: B

- Action: 当前安装包 `node scripts/packaged-smoke.mjs`，FastCtx job `j-5azsnl`
- Result: PASS；隔离安装与 Electron profile、首启运行时安装、主界面 / 后端连接、11 个 V1 路由、合成项目 / 人物 / 状态 / 世界设定 / 章节 / Story Memory / 一致性链路、DOCX 生成与下载、桌面自动备份、关闭进程与临时目录清理均通过
- Covered scope: 当前 Windows x64 包中的合成产品链路和资源清理
- Uncovered scope: 真实模型调用、真实覆盖升级、跨机器数据迁移
- Residual risk: 合成数据与本机 smoke 不代表 §42 的真实模型、签名 Release 或升级数据保留验收
- Confidence: B

- Action: whole-worktree `git diff --check`, followed by scoped `git diff --check -- OPENFIX.md docs/aegis/work/2026-10-02-v1-completion`
- Result: whole-worktree check exits 2 and flags trailing whitespace in four mixed-CRLF/LF backend files (`storage/repos/__init__.py`, `storage/services/chapter_service.py`, `project_service.py`, `world_info_service.py`); the scoped documentation check passes with no output
- Covered scope: confirms this record update adds no whitespace errors
- Uncovered scope: source files' line-ending normalization; it was intentionally not performed because it would broaden the existing diff
- Residual risk: the full working-tree diff check is not clean until those mixed-ending deltas are normalized or handled on a consistent-LF checkout
- Confidence: B

### 第五轮汇总时的发布状态（历史）

- 截至第五轮汇总时，代码、后端 / 前端 / 桌面本机门禁、Windows x64 产物静态校验和前一轮合成包冒烟（job `j-5azsnl`）有通过证据；当时最新 smoke 的业务链路通过但 cleanup 返回 `EPERM`，清理修复尚未完整重放。该段是历史状态；它曾引用 job `j-3km75p`，当前工作记录没有该 job 的 EvidenceBundleDraft。
- 当时 V1.0 正式发布为 `needs-verification`：供应商真实模型用户链路、干净 Windows 11 覆盖升级与数据保留、远端 GitHub Actions / Release、经证书链验证的 Windows 代码签名均未验收。
- 当时 Claude Code 复审尚未运行；用户后来明确 Claude Code 通过第三方 API 接入，不需要网页登录，后续复审已完成。登录不是当前 blocker。第五轮时没有提交、推送、创建 tag、签名或发布。

## EvidenceBundleDraft: packaged-smoke-v1-local-20261002

- Artifact key: packaged-smoke-v1-local-20261002
- Slice ID: packaged-smoke-v1-local-20261002
- Type: packaged-smoke
- Source: FastCtx job j-sm45t2; older Windows x64 package and harness revision; supersession recorded against the current source package
- Summary: Historical j-sm45t2 run exited 0 with 60 PASS checks on an earlier x64 package and earlier smoke harness. It remains valid for that exact attempt, but is superseded for current package acceptance: j-fpiwyo later tested a different package state, and the current source has since been rebuilt into new x64 artifacts without a smoke replay. Preserve its attempts and log; do not treat its cleanup claim as evidence for the current package.
- Verifier: Primary agent; original run log, later package chronology and current package hash checked
- Evidence status: superseded

## 本轮安装包冒烟续测与清理恢复（2026-10-02）

- Action: 扩展后的 `node scripts/packaged-smoke.mjs`，job `j-kaqbwp`
- Result: 安装、合成模型 Inline AI / Agent、一致性和重启持久化通过；Data Manager 检查失败，因为脚本连接到没有 preload 桥的 `app://openfic/` webview。手动 CDP 检查确认配置文件内仍有一个本地实例，而 webview 的 `window.openficDesktop` 不可用。
- Covered scope: 证明 Data Manager 失败来自 smoke 的 CDP target 选择；不表示桌面 IPC 功能失败。
- Uncovered scope: 当轮自动备份与临时目录清理未通过。
- Residual risk: 失败尝试的隔离目录一度因 Windows `EPERM` 未删除，之后在无相关应用进程时清理。
- Confidence: B（CDP target 与隔离配置结构已读回）

- Action: 修正 target 后再运行当前 Windows x64 安装包，job `j-svnx64`
- Result: 59 条安装、V1 路由、合成项目 / 人物 / 世界设定 / 章节、Inline AI 候选保护、Agent 假模型回复、一致性、DOCX 导出、重启数据与凭据持久化、自动备份断言全部 PASS；但清理隔离 profile 返回 `EPERM`。本次脚本误将清理失败排除在失败列表外，因此其 `SMOKE PASSED` 文字不代表清理通过。
- Covered scope: 当前安装包的合成产品链路和 Data Manager 已生成非空自动备份；重启后项目正文、模型记录、Agent 对话及加密假模型凭据可继续使用。
- Uncovered scope: 真实供应商调用、旧版覆盖升级、签名与远端 Release；最后一次 cleanup 改动后的完整 smoke 回放。
- Residual risk: 安装包 smoke 清理完整闭环尚未重放。该次输出共 59 条产品 / IPC 断言通过，但终态清理失败。
- Confidence: C（产品合成链路目标证据较强；清理检查未通过）

- Action: 核实 `C:/Users/20969/AppData/Local/Temp/openfix-smoke-2SfMGg` 解析到精确预期目录、确认无 OpenFix / Electron / Python 进程后，以 `fs.rmSync` `maxRetries=40`、`retryDelay=500` 重试删除
- Result: PASS；遗留合成 profile 已删除，用时约 37 秒。
- Covered scope: 回收本轮 `j-svnx64` 留下的隔离 Temp 目录。
- Uncovered scope: 不能替代在完整 packaged smoke 中重新验收修订后的 cleanup 断言。
- Residual risk: smoke 脚本的最终版本尚未完整重放。
- Confidence: B（精确路径、进程清单与删除后不存在均已核实）

- Action: 更新 `desktop/scripts/packaged-smoke.mjs`，使用 40 次 / 500 ms 清理重试，并通过 `check()` 把清理结果纳入失败集合；运行 `node --check`、`pnpm exec eslint scripts/packaged-smoke.mjs`、该文件的 `git diff --check` 与目标目录不存在检查
- Result: PASS；静态检查和真实残留目录清理通过。完整 packaged smoke 未在该代码修改后重跑。
- Covered scope: smoke harness 最终代码语法 / lint / 局部 whitespace 与清理复用行为。
- Uncovered scope: 最终脚本完整安装、运行、自动备份及清理闭环。
- Residual risk: 本机 packaged smoke 仍为 `needs-verification`；完整 V1.0 正式发布还需真实模型、签名、远端 Release 和干净 Windows 11 升级验收。
- Confidence: C

## 当前 Windows x64 包 smoke 与临时目录收尾（2026-10-02）

- Action: 核对当前 `desktop/dist-electron` 产物并执行 packaged smoke job `j-8wrmht`
- Result: EXE `OpenFix-0.11.1-win-x86_64-setup.exe` 为 158,042,666 bytes，SHA-256 `2891da7d7cece1f41f1c601d610d6636e1295242c7c24345a254b13fd6a24044`；ZIP 为 188,477,926 bytes，SHA-256 `2132f7534b788b0c8f39fcf5879fd2c0c2ef5db3b9d338cacabe431ccbc1f955`。`pnpm verify:release` 当轮通过；EXE Authenticode 状态为 `NotSigned`。`j-8wrmht` 退出码 1，必须保留失败结论。
- Covered scope: 当前包的隔离安装、后端连接、合成项目 / AI 候选保护 / 一致性 / Agent / DOCX、重启后数据与加密凭据保留、非空自动备份均有 PASS 记录。
- Uncovered scope: 当前 smoke 未全绿；真实供应商用户链路、干净 Windows 11 旧版覆盖升级与原数据保留、远端 GitHub Actions / Release、签名身份及证书链仍未验收。
- Residual risk: 旧检查未从 CDP `/json` 列表找到首启 `app://openfic` target。同期 backend log 中有 settings / dashboard / model / project 和 socket 请求，说明该检查未能判定 webview 是否加载；当前诊断尚不构成产品 UI 失败或通过证据。backend log 中 `/openapi.json` 响应耗时 8,163.65 ms，而 smoke `httpJson` 默认超时为 8,000 ms，导致 0 路由 / marker 断言是假失败。
- Confidence: C（该包 smoke 结果明确失败；OpenAPI 超时根因有直接日志与源码证据；UI readiness 的 CDP 观测缺口仍需新 probe 验证）
- Evidence refs: `C:/Users/20969/.fastctx/jobs/j-8wrmht/output.log`; sidecar `evidence-bundle-draft-packaged-smoke-current-exe-2891da7-20261002.json`; `desktop/scripts/packaged-smoke.mjs`; 当前产物 SHA-256 复算结果。

- Action: 收窄修复 `desktop/scripts/packaged-smoke.mjs`
- Result: readiness 改为从壳页面检查嵌入式 webview 的 URL / loading，OpenAPI 请求 timeout 提高到 30 秒，EPERM / EBUSY / ENOTEMPTY 时额外进行两轮延迟清理。`node --check`、`desktop/node_modules/.bin/eslint scripts/packaged-smoke.mjs`、目标文件 `git diff --check` 均退出 0。未将新 smoke harness 重新打包或回放。
- Covered scope: 修复 OpenAPI timeout 假失败；首启 UI 读取不再依赖 CDP `/json` 暴露独立 guest target；给短暂 Windows 文件锁提供有界重试。
- Uncovered scope: 新 readiness probe、重试后的清理断言与当前安装包的完整产品链路均未重新执行。
- Residual risk: 不得将本次静态检查计作 packaged smoke 通过。
- Confidence: B（脚本诊断边界与语法 / lint / whitespace 已复核；运行行为待验证）

- Action: 清理旧 smoke Temp 目录 `openfix-smoke-ii8UD4`、`openfix-smoke-UXsCz6`、`openfix-smoke-JUEQH5`
- Result: 在排除本次清理进程并确认无其它引用进程后删除；再次检查三条路径均不存在。共回收 3,370,651,107 bytes（约 3.37 GB）。
- Covered scope: 旧 smoke 安装体、运行环境与隔离 profile 不再占用 Temp 存储。
- Uncovered scope: 当前脚本未来产生的目录清理仍需由完整 smoke 的最终断言验收。
- Residual risk: 新 smoke 可能再次遇到 Windows 临时文件锁；当前脚本已增加有界延迟重试，但未回放。
- Confidence: B（目标为 Temp 下精确白名单目录；删除后复核均 absent）

### 前次 V1.0 状态（j-fpiwyo 回放前）

- 当时当前 EXE hash `2891da7d7cece1f41f1c601d610d6636e1295242c7c24345a254b13fd6a24044` 的修订 harness 回放 `j-gepsnv` 因 fresh-profile 运行时安装超过 15 分钟上限退出；前端和后端未就绪，不能据此断言后端路由或产品 UI 有缺陷。该 smoke 状态后来由下方 30 分钟有界回放 `j-fpiwyo` 更新；正式发布仍为 `needs-verification`。
- 当时 Claude Code 复审未完成；用户随后确认第三方 API 接入不依赖网页登录，之后的审计与复审已完成。真实供应商、干净 Windows 11 覆盖升级与数据保留、真实远端 Release、签名身份及证书链仍需对应外部条件。此处没有提交、推送、tag、签名或发布。

## EvidenceBundleDraft: packaged-smoke-current-exe-2891da7-20261002

- Artifact key: packaged-smoke-current-exe-2891da7-20261002
- Slice ID: packaged-smoke-current-exe-2891da7-20261002
- Type: packaged-smoke
- Source: FastCtx job j-8wrmht output log; prior x64 EXE hash 2891da7d7cece1f41f1c601d610d6636e1295242c7c24345a254b13fd6a24044; current source package has newer hashes
- Summary: The historical j-8wrmht attempt exited 1 with UI observation inconclusive, a confirmed 8-second OpenAPI harness timeout and cleanup EPERM. j-fpiwyo later replayed that same old package hash successfully with 63 synthetic checks. The current source has since been rebuilt into a new x64 package and this old-hash bundle is superseded for current package acceptance; retain the original failed attempt details.
- Verifier: Primary agent; failed attempt log, later same-hash replay and current package chronology checked
- Evidence status: superseded

## 修订后 packaged-smoke harness 的当前包回放（2026-10-02）

- Action: 在确认 9224 端口空闲、当前 EXE / ZIP hash 与失败包记录一致、Temp 盘约 90 GB 可用且没有运行中 smoke job 后，单次执行 `node scripts/packaged-smoke.mjs --port=9224`，job `j-gepsnv`。
- Result: 静默安装和 CDP 端口通过。fresh profile 首启进入「安装 OpenFix」运行时安装步骤，15 分钟等待超时；没有观察到 `app://openfic` 主界面或后端 `connect.log`。后续 API、合成写作、重启持久化和自动备份检查因运行时未就绪而失败；这些结果不能证明未到达的产品路由本身失败。job 退出码 1。
- Covered scope: 当前 EXE 的隔离静默安装、桌面壳 CDP 启动、失败后的有界关闭和 workspace 自动清理。
- Uncovered scope: 首启运行时安装最终是否能完成；当前 package 的 V1 API、合成创作主链路、重启持久化与备份；真实供应商、旧版覆盖升级、签名及远端 Release。
- Residual risk: 日志停在 wheel 依赖安装阶段，本轮证据不能确定耗时来自网络、文件解包 / 编译、主机 I/O 或安装器缺陷；不扩大为产品根因结论。后续不得不经诊断就重复 smoke。
- Cleanup: workspace `C:/Users/20969/AppData/Local/Temp/openfix-smoke-R0dyMV` 首次删除遇到 `EPERM`，脚本延迟重试后报告清理 PASS；随后复核 Temp 没有 `openfix-smoke-*` 目录，且无命令行引用该路径的进程。
- Confidence: C（退出与清理结果直接可见；运行时安装根因及最终是否成功未知）。
- Evidence refs: `C:/Users/20969/.fastctx/jobs/j-gepsnv/output.log`; sidecar `evidence-bundle-draft-packaged-smoke-harness-replay-20261002.json`; `desktop/src/main/runtime/openfic.ts:413-499`; post-run Temp and process checks.

## 30 分钟修订 harness 的当前包回放（2026-10-02）

- Action: 对 SHA-256 `2891da7d7cece1f41f1c601d610d6636e1295242c7c24345a254b13fd6a24044` 的当前 x64 setup 包仅回放一次，FastCtx job `j-fpiwyo`；ZIP SHA-256 `2132f7534b788b0c8f39fcf5879fd2c0c2ef5db3b9d338cacabe431ccbc1f955`。smoke 安装等待上限 30 分钟，PIP / UV cache 指向本次隔离 workspace。
- Result: 退出码 0，完整日志 63 项 PASS / `SMOKE PASSED`。首次运行时依赖安装约 18 分钟后完成；前端主界面和后端连接、11 个 V1 API、合成写作 / Inline AI 候选保护与接受、Story Memory、一致性结果原文定位 / AI 分析、Agent、本地模型、DOCX、重启后的项目正文 / 模型记录 / Agent 对话 / 加密凭据保留、非空自动备份均通过。
- Covered scope: 当前 Windows x64 包在本机隔离环境中的 synthetic V1 主链路、首次运行时安装、重启持久化、自动备份和 smoke 自动清理。
- Uncovered scope: 真实供应商模型用户链路、干净 Windows 11 旧版覆盖升级及原数据保留、真实远端 GitHub Actions / Release、签名身份与证书链。Claude Code 复审不属于该次 smoke；后续已通过第三方 API 完成只读审计。
- Cleanup: 脚本第一次删除遇到 `EPERM`，一次延迟重试后报告 PASS。复核 `openfix-smoke-Q9rBYd` 不存在、无 OpenFix / Python 进程引用该目录、调试端口 `19544` 已释放、Temp 下没有 `openfix-smoke-*` 目录；C 盘可用空间约 97 GB。之前清理的三个旧 smoke 目录已回收约 3.37 GB。
- Supersedes: `j-gepsnv` 的 15 分钟运行时安装超时仍是该次有效失败记录，但不再代表当前安装包 smoke 的最终状态；它没有到达的业务步骤不能算产品失败。
- Residual risk: 本次模型为本地 OpenAI-compatible synthetic 服务，没有真实供应商调用；当前 Windows smoke 也没有覆盖旧版本升级、签名和远端 release。
- Confidence: B（完整日志、退出码、当前产物 hash 和清理后进程 / 目录 / 磁盘检查均已核实；外部门槛未覆盖）。
- Evidence refs: `C:/Users/20969/.fastctx/jobs/j-fpiwyo/output.log`; sidecar `evidence-bundle-draft-packaged-smoke-harness-replay-20261002.json`; current setup / ZIP SHA-256; post-run Temp、process、port 和 disk checks。

## 当前 V1.0 状态

- 历史包 `j-fpiwyo` 的 synthetic smoke 通过，但它只适用于当时的包 hash 与 harness。当前源码已重新构建为新的 x64 包并通过发布静态校验；该新包没有运行 smoke，因此不能视为已完成安装包运行验收。V1.0 正式验收保持 `needs-verification`，等待真实供应商、干净 Windows 11 旧版覆盖升级、远端 Release、Windows 签名身份及证书链。
- 本轮没有提交、推送、创建 tag、签名或发布；当前 Windows Temp 下没有 `openfix-smoke-*` 临时 workspace。

## 旧 smoke 临时资源回收与 Claude Code 复核状态（2026-10-02）

- Action: 检查 Windows `%LOCALAPPDATA%/Temp` 下的 `openfix-smoke-*` 目录与文件，并检查当前 FastCtx running jobs。
- Result: 未发现旧 smoke 安装目录或 profile；没有运行中的 OpenFix `packaged-smoke.mjs` job。本轮没有重新安装或运行 smoke。
- Action: 清除 5 个已完成打包任务使用的隔离缓存：`/tmp/openfix-v1-uv-cache`、`/tmp/openfix-v1-uv-cache-20261002`、`/tmp/openfix-v1-uv-cache-20261002-context`、`/tmp/openfix-v1-uv-cache-20261002-runtime-consistency`、`/tmp/openfix-context-snapshot-uv-cache`。
- Result: PASS；逐个检查清理后路径均不存在，依据此前 `du` 记录约回收 73 MB。保留独立测试数据库、日志和品牌图片。
- Action: 源码复核 `desktop/scripts/packaged-smoke.mjs` workspace 清理分支；读取 Phase 5 更新配置与 workflow 中的仓库身份、架构资产名、Windows 内置 wheel、上游 PyPI / Docker 发布 guard。
- Result: 未发现由本轮直接检查确认的新静态接线缺口。当前包 smoke 的 63 项 PASS 仍沿用 job `j-fpiwyo`，没有重跑。
- Action: Claude Code CLI `2.1.280` 无写入最小调用返回 `READY`；提交窄范围只读审查 job `j-7g0itq`，仅审 Phase 5 / smoke 清理相关 7 个文件。
- Result: job `j-7g0itq` 退出码 0，输出 `No confirmed blocker in this slice.`；审查仅限上述 7 个 Phase 5 / smoke 文件，不构成全仓库复审。未修改代码、未运行测试或构建。
- Current V1.0 status: `needs-verification`。真实供应商用户链路、干净 Windows 11 覆盖升级及数据保留、远端 GitHub Actions / Release、Windows 签名身份与证书链仍未完成；遵守 Phase 5 限制，没有 tag、push、Release、sign 或 commit。

## 最新本机切片：Phase 5 更新清单门禁与 smoke 缓存隔离（2026-10-02）

- Scope: 仅修改 `desktop/scripts/verify-release.mjs`、`.github/workflows/package.yml` 与 `desktop/scripts/packaged-smoke.mjs` 的本机验收接线；保留工作树既有未提交改动。
- Release verifier: `--prepared-update-assets` 检查合并清单中的 x86_64 / aarch64 安装包与 `x64` / `arm64` 兼容查询别名、x86_64 默认 path，以及两份架构清单的版本、资产存在性、SHA-512 和大小；workflow 在 `prepare-windows-update.mjs` 后、`gh release upload` 前调用。
- Smoke storage: 首启和重启均使用唯一 smoke workspace 下的 `package-cache` 作为 `PIP_CACHE_DIR` / `UV_CACHE_DIR`；原有退出进程确认、workspace 清理及 `--keep` 行为不变。没有运行 smoke。
- Verification: `git diff --check -- .github/workflows/package.yml desktop/scripts/verify-release.mjs desktop/scripts/packaged-smoke.mjs`、`node --check desktop/scripts/verify-release.mjs`、`node --check desktop/scripts/packaged-smoke.mjs`、`pnpm exec eslint scripts/verify-release.mjs`、`pnpm exec eslint scripts/packaged-smoke.mjs` 通过。`pnpm verify:release` 对本机当前 x64 包输出 `ALL CHECKS PASSED`。
- Independent reviews: Claude Code job `j-ivjtur` 静态对照 verifier、清单生成器和 workflow，未发现确认 blocker；`j-3ec9i7` 复核 smoke workspace 清理边界并发现首启共享缓存漏点，该点已修复；`j-3cmqmu` 指出证据 sidecar 过时字段和双架构模式未运行的记录缺失，已同步当前 checkpoint / sidecar。
- Limits: 本机只有 x64 包，`dist-electron` 中没有 aarch64 资产或 `latest-win-*` 清单，因此 `--prepared-update-assets` 正向执行未做；真实 GitHub Actions / Release 未执行。环境未找到可用的 actionlint / YAML lint 工具。当前 x64 smoke 的 63 项 PASS 仍来自此前 job `j-fpiwyo`，未由本轮改动重新验证。
- Cleanup: 本次复核 `%LOCALAPPDATA%/Temp` 下没有 `openfix-smoke-*`，`/tmp` 下此前已删除的 5 个 smoke 专用 UV cache 前缀也没有残留；没有删除共享缓存、当前安装包、证据日志或数据库。
- Remaining V1.0 gates: 真实供应商模型用户链路；干净 Windows 11 上从旧版覆盖升级并保留数据；远端 GitHub Actions / Release 与双架构资产门禁；Windows 签名身份及证书链。正式状态仍为 `needs-verification`；没有提交、推送、创建 tag、签名或发布。

## 续作核对（2026-10-02）

- 用户说明 Claude Code 通过第三方 API 接入，不以网页登录作为前置条件；因此历史 checkpoint 中“Claude Code 暂时无法登录”只描述当时情况，不是当前 blocker。已可正常启动 Claude Code CLI 审阅任务。
- 复核此前一份只读审计对 PRD §20 的结论：当前工作树已实现问题卡“查看原文”与“AI 分析”。前端将服务端定位的 sources 片段展开显示，并调用 /projects/{projectId}/consistency/analyze；后端路由调服务端重新定位正文证据后再调用模型。既有测试验证只返回正文中真实存在的来源片段，以及分析请求包含服务端定位的正文上下文。参考 frontend/src/features/consistency/components/issue-card.tsx:144-214、frontend/src/features/consistency/lib/consistency-api.ts:69-84、backend/app/api/routers/consistency.py:93-137、backend/app/core/consistency/service.py:154-183,424-489、backend/tests/api/test_consistency.py:480-535。该审计缺口结论不适用于当前工作树。
- packaged-smoke 的 smokeSpawnEnv 修改由 j-3ezp8j 完成，并由 j-iaoai4、j-krhw96 作了静态只读复核。缓存环境现在在首启和重启 spawn 上由脚本显式指向本次 workspace；j-fpiwyo 的 63 项 PASS 发生在该脚本修订之前，因此不能用来证明新环境注入经过 runtime 回放。本轮遵照用户要求未重跑 smoke。
- Phase 5 双架构 prepared-assets 模式在本机没有 aarch64 资产或架构清单，正向路径未执行；现有 pnpm verify:release 只覆盖本机 x64 产物静态校验。
- Claude Code 审计 j-j8to3s 已完成：确认当前工作树的一致性原文与 AI 分析功能存在，其他 V1.0 本地需求静态覆盖与现有记录一致；全书一致性仍为同步分段模型调用，规模较大时有超时风险，任务化超出当前明确范围。
- Claude Code 审计 j-883m9x 已完成，确认两项 Phase 5 发布接线缺口：release workflow 之前没有运行完整 package verifier；本地 package script 未阻止 electron-builder 自动发布。已在 .github/workflows/package.yml 的 Windows x64 打包 / 命名后、资产上传前增加 pnpm verify:release，并在 desktop/package.json 的 package script 增加 --publish never。既有双架构 prepared-assets 门禁保持在 workflow 上传前。
- Fresh verification: 目标文件 git diff --check 通过；本机 x64 pnpm verify:release 输出 ALL CHECKS PASSED。未运行测试、构建或 smoke；没有运行 GitHub Actions、发布或签名。
- 同一审阅确认无 publisherName 时 electron-updater 不执行 Authenticode publisher 验证；当前包为未签名，证书身份、签名产物和证书链仍是外部发布门槛，本轮没有绕过签名约束。
- Story Memory 隐藏 / 新鲜度审计 j-g2iu09 与 Phase 5 变更的 spec review j-v4r5bc 均已完成；Story Memory 缺陷修复与回归证据见下节，Phase 5 修改的质量复核 job j-1equ2e 也已通过。审查结论不会替代供应商、升级或远端发布验收。
- 正式 V1.0 状态保持 needs-verification：真实供应商用户链路、干净 Windows 11 旧版覆盖升级及原数据保留、真实 GitHub Actions / 双架构 Release、Windows 签名身份与证书链尚未验收。没有提交、推送、创建 tag、签名或发布。

## Story Memory 隐藏笔记可见性修复（2026-10-02）

- Finding: Claude Code audit `j-g2iu09` traced hidden notes through the unfiltered Story Memory builder, fingerprint, search hydration, and consistency context. Hidden notes were already excluded by ordinary Agent note tools and mention candidates, but the Story Memory owner used the repository default `include_hidden=True`.
- Repair: `backend/app/retrieval/story_memory.py` explicitly passes `include_hidden=False` for indexed note documents and status counts. This changes the canonical document fingerprint when an indexed note becomes hidden, so `story_memory_index_is_fresh` reports stale and consistency falls back instead of using old Story Memory text. `backend/app/agent_runtime/tools/impls/memory/search_story_memory.py` rejects a hidden note during hydration even if the index is incorrectly reported fresh. Generic repository defaults and other callers are unchanged.
- Regression tests: `backend/tests/retrieval/test_story_memory.py::test_hidden_note_excluded_from_story_memory_and_invalidates_fingerprint` verifies the visible-to-hidden transition, count exclusion, fingerprint change, stale status, and a serialized content sentinel. `backend/tests/agent_runtime/tools/test_search_story_memory.py::test_search_story_memory_drops_currently_hidden_note` forces a fresh-index result and verifies both empty results and absence of a leaked text sentinel.
- Action: `uv run pytest -q tests/retrieval/test_story_memory.py tests/agent_runtime/tools/test_search_story_memory.py`, FastCtx job `j-5tua8z`.
- Result: PASS; **33 passed in 3.80s**.
- Additional consumer check: `uv run pytest -q tests/api/test_consistency.py::test_story_memory_context_drops_results_when_index_goes_stale`.
- Result: PASS; **1 passed in 0.08s**. The existing consistency consumer discards the retrieved context when freshness changes during retrieval.
- Static verification: `uv run ruff check` on the four target source/test files, `uv run ty check app`, and `git diff --check` on the tracked Story Memory source and test file all passed.
- Independent review: Claude Code spec review `j-7j40k6` PASS; code-quality review `j-6w3k25` PASS. Phase 5 spec review `j-v4r5bc` and code-quality review `j-1equ2e` also PASS.
- Covered scope: source filtering, status counts, fingerprint staleness, Agent search hydration guard, consistency stale-index gate, and targeted backend regression suite.
- Uncovered scope: no full packaged smoke rerun; no real model provider call, clean Windows 11 old-version upgrade, remote GitHub Actions / dual-architecture Release, or verified signing identity / certificate chain.
- Residual risk: V1.0 formal acceptance remains `needs-verification` until the external gates above are exercised. No commit, push, tag, signature, or release was performed.

## EvidenceBundleDraft: story-memory-hidden-note-visibility-20261002

- Artifact key: story-memory-hidden-note-visibility-20261002
- Slice ID: story-memory-hidden-note-visibility-20261002
- Type: regression
- Source: FastCtx job j-5tua8z for the two Story Memory suites (33 passed); standalone pytest tests/api/test_consistency.py::test_story_memory_context_drops_results_when_index_goes_stale (1 passed); Claude Code spec review j-7j40k6; Claude Code code-quality review j-6w3k25; uv run ruff check on four target files; uv run ty check app; git diff --check on tracked Story Memory source and test files
- Summary: Hidden notes are excluded from Story Memory document construction and status counts. Hiding a previously indexed note changes the source fingerprint and reports stale; Agent search hydration independently drops hidden notes even when freshness is forced true. The two target Story Memory test modules pass 33 tests, and the consistency stale-context regression passes one test. Ruff, ty, and tracked target diff check pass. Consistency remains protected by freshness checks before and after retrieval. External V1.0 gates remain open.
- Verifier: Primary agent with independent Claude Code spec and code-quality reviews
- Evidence status: evidence-finalized

## EvidenceBundleDraft: v1-current-source-build-20261002

- Artifact key: v1-current-source-build-20261002
- Slice ID: v1-current-source-build-20261002
- Type: local-verification
- Source: FastCtx jobs j-ygbcaf, j-hgt5fn, j-ex6kxv, j-g2uxy0, j-fmp9ly and j-vrh34h; current OpenFix working tree and x64 dist-electron artifacts
- Summary: Fresh current-worktree local gates passed: backend Ruff, ty and full pytest suite (1884 passed); frontend lint and type-check on 429 files plus production build; desktop lint, both TypeScript checks and desktop build. pnpm package produced current-source Windows x64 EXE (158042781 bytes, SHA-256 01294e379ea45c995575e83d9e87d4d89632e2784d83ad2a6994bad1dc3925df) and ZIP (188478015 bytes, SHA-256 ff9a8570fdfb2369943ccdebebda9010cdb4aa257f7944b62ba29e6bce036b08). pnpm verify:release then passed all x64 artifact, manifest, wheel, feed identity and V1 bundle marker checks. Frontend builds retain the existing large-chunk warning. The first packaging attempt failed before Electron Builder because the shared uv cache hit its temporary-file limit; the isolated-cache retry passed and its 2.1 MB task cache was removed. No packaged smoke was rerun, so the new package runtime is not smoke-accepted. Real provider, clean Windows 11 upgrade, remote GitHub Actions and dual-architecture release, and signing identity/certificate-chain validation remain unverified.
- Verifier: Primary agent; full FastCtx logs, return codes, output artifacts, hashes, cleanup and release-verifier result checked
- Evidence status: evidence-finalized

## EvidenceBundleDraft: packaged-smoke-harness-replay-20261002

- Artifact key: packaged-smoke-harness-replay-20261002
- Slice ID: packaged-smoke-harness-replay-20261002
- Type: packaged-smoke
- Source: FastCtx jobs j-gepsnv and j-fpiwyo on historical EXE hash 2891da7d7cece1f41f1c601d610d6636e1295242c7c24345a254b13fd6a24044; current source package has newer hashes
- Summary: The 30-minute replay j-fpiwyo passed 63 synthetic checks on the recorded historical EXE hash, while the earlier 15-minute j-gepsnv attempt timed out during runtime installation. Later smoke harness cache-environment changes and current-source packaging occurred after these runs. The run remains evidence for its exact package and harness only and is superseded for current package acceptance; the newly generated x64 artifacts have not been smoke-tested.
- Verifier: Primary agent; original attempt logs, later harness changes and current package hashes checked
- Evidence status: superseded

## EvidenceBundleDraft: phase5-release-version-guard-20261003

- Artifact key: phase5-release-version-guard-20261003
- Slice ID: phase5-release-version-guard-20261003
- Type: release-verification
- Source: FastCtx job j-4q6ypv implementation report; j-n8hvfy spec re-review; j-uuw63c code-quality review; coordinator node --check, scoped git diff --check, and pnpm --dir desktop verify:release.
- Summary: Added fail-closed tag/package version validation to the two GitHub Release verifier call sites, with OPENFIX_RELEASE_VERSION sourced at job level from needs.context.outputs.version. GitHub Actions fails when the expected version is blank; local verifier behavior without the variable is unchanged. Independent spec and quality reviews passed. node --check, scoped git diff --check, and local x64 pnpm verify:release passed with ALL CHECKS PASSED. No tests, build, smoke, GitHub Actions, tag, release, signing, or remote update was run. The guard mismatch/missing-input branch and dual-architecture positive path remain unexecuted.
- Verifier: Primary agent; current source diff and verification output checked after independent Claude Code reviews.
- Evidence status: evidence-finalized

## EvidenceBundleDraft: v1-local-commit-20261003

- Artifact key: v1-local-commit-20261003
- Slice ID: v1-local-commit-20261003
- Type: local-verification
- Source: FastCtx j-taig3r (migration target/Ruff/ty/full pytest), j-v44ehv (frontend lint/type), j-9za1x2 (desktop lint/type/build phases); native Windows tar archive/data-manager rerun; pnpm verify:release; current candidate manifest and CRLF-aware diff check.
- Summary: User explicitly authorized a local OpenFix milestone commit. Updated the migration-chain regression to verify the 1028 single head and its 1027 parent. Target tests pass 3; Ruff and ty pass; full backend suite passes 1889. Frontend lint/type-check passes on 429 files. Desktop lint/type-check/build passes, including production frontend and setup/main builds. With Windows system tar first in PATH, archive/data-manager tests pass 12; the symbolic-link test is excluded because this Windows account lacks symlink privilege. Existing x64 release assets pass the static release verifier; no package or packaged smoke is rerun. Candidate path and common-token scans find no secrets, databases, generated packages or temporary caches. Source-only checks do not close project profile error-state protection, ARM64 runtime support, non-Windows fork-wheel inclusion or restore runtime preservation; real-provider, clean-upgrade, remote release and signing gates remain open.
- Verifier: Primary coordinator read complete verification results and current source; milestone verification only, not full V1 acceptance.
- Evidence status: evidence-finalized
