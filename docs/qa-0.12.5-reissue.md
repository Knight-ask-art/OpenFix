# OpenFix 0.12.5 重发修复记录

## Audit 与范围

2026-10-24，基线 `e310c35`，分支 `feature/branding`，开始时工作区干净。工程为本地 `新版本/OpenFix` Python/FastAPI Fork。

真实试写暴露的是两类问题：模型输出与复审可能不遵守事实、动作和场景约束；确定性的字数、测量次数、交付版本也没有全部落到执行边界。私人正文与运行轨迹保留在本地忽略目录，不放入公开测试或日志。

已有能力可复用：measure_text 确定性计数和哈希、writing_loop_guard、ReAct 工具配对与保护停止、子 Agent 请求 JSON、原始作者要求交接、章级人物状态读取、现有审批/Diff/Revision、桌面内置 wheel 内容指纹。

当前缺口：连续失败保护会在达标后重置；跨不同文本只有显式系列才识别无进展；最终自由文本没有与测量版本强绑定；作者自然语言预算不是可执行合同；uv 安装的镜像/证书重试无法隔离坏缓存。

Decision: code-change。仅加可选结构化写作约束及其执行/交付验证，扩展现有 uv 安装入口，补相关质量提示与回归测试。不靠关键词识别伤势动作，不新建候选库、RAG 或工作流引擎，不更改私人小说与 Canon，不改数据库 Schema。

### 实现切片

1. Claude Code：桌面 uv 安装缓存隔离与有界回退，独立模块/窄接线及 Node 回归。
2. Claude Code：可选写作约束（范围、测量/修订预算、精确交付），复用 dispatch/request JSON 和现有保护停止；新增模块承载规则，Runtime 只保留必要接线，回归覆盖旧调用和恢复边界。
3. 主代理：Writer/Reviewer/Actor/Plan 与相关既有 Skill 协议同步、独立审查与修复、隔离数据验证、构建、包核验、提交推送与同号重发。

TDD Mode: off，采用修复后比例适当的回归验证；本次明确补测试，不将旧测试通过记录当成新证据。

## 发布边界

保留显示版本0.12.5，修复源码必须形成新的提交。发布前重新生成 wheel、Windows x64/ARM64安装包、blockmap、便携包及更新清单，核验远端资产与源码 tag。已安装旧0.12.5不应被声称可凭相同 semver 自动发现重发；同号重新安装后由既有 wheel 内容指纹识别后端变化。

## 已完成实现

### 可选写作合同

`dispatch_subagent` 仅为 writer/actor 接受 `writing_contract`：`goal`、可选 `min_words/max_words`、`max_revisions`（默认2，允许0，上限10）。合同保存在原有 `request_json`，无数据库迁移；旧请求省略字段仍走原路径，损坏持久化合同失败，不降级为无限制任务。

ReAct 在工具准备/执行前按完整历史中的声明顺序分配测量额度。首测加修订为本轮上限，工具错误和并行调用也占额度，工具 range/series 和一度达标不重置。超额调用仍生成配对的失败 ToolMessage，全部工具结果收齐后保护停止，不再请求模型。

子请求完成边界独立验证最后测量的真实调用/结果、原始字数口径、字符数和 UTF-8 SHA-256，最终全文须逐字一致，包括标题、空白与标点。失败完成为 error，不能注册为成功交接来源；原始历史保留。没有额外自动纠错循环，不自动截断、保存、重写或删除正文。

### Prompt 与质量规则

Plan/Build 尊重作者章节和篇幅要求，对单个需核验完整候选派发合同；Writer/Actor 的合同交付只含最后实测全文，已保存回执场景与未保存全文场景分别说明。Reviewer 不再目测估字，受力、工具、期限与场景推断必须带来源，证据不足标未验证。既有 story-quality 增加按需 reference，未激活时不注入完整案例。

### 桌面安装缓存

默认 `runtimeDir/uv-cache`，显式 `UV_CACHE_DIR` 保留并规范 Windows 大小写键；明确缓存失败才创建唯一新目录，重试一次。网络、TLS、可执行文件权限错误不会被误归缓存损坏。旧应用缓存和用户显式缓存均不删除；镜像/系统证书重试继续复用。

## 独立审查与边界

* Claude Code 实际参与两个实现任务和测试任务；前两轮后端任务触及回合上限，测试初稿也有错误，未作为成功证据。主代理收敛实现、复核并运行决定性测试；CLI 后端返回的模型标识为 `deepseek-v4.1-flash`，不冒称由 Anthropic 模型完成。
* 合同适用于当前持久化子 Agent 请求轮。新的 notify 用户请求开始新轮，审批恢复不重置；不是父子树共享预算，也不提供永久限制反复 notify 的机制。
* 通用 ReAct 同时传 `inject_queue` 的运行中注入路径未纳入此合同支持；当前 SubagentRunner 不使用该队列。
* 合同核验最终交付，不是数据库事务。若此前已通过原有获授权写工具保存，最终失败不会回滚保存。正式正文/Canon 仍由既有审批控制。
* 数据库中用户自定义 Prompt 优先于 YAML 默认值，重发不会强行覆盖；使用自定义版本者需自行合并新规则。未新增数据库迁移。
* 动作安全、人物认知、讲义密度仍需真实模型审稿与人工复核；本轮不宣称文学质量提升百分比，也不把合成回归当作新三章试写验收。

## 真实验证

源码冻结提交：`71377c3`。后端测试和 wheel 启动使用独立 `OPENFIC_DATA_DIR`，没有使用正式小说数据库。

| 范围 | 实际命令（对应子目录） | 结果 |
| --- | --- | --- |
| 后端完整回归 | `.venv/Scripts/python.exe -m pytest tests -q` | 2924 passed，479.85s |
| 合同、工具 schema 与 Prompt 定向回归 | `pytest` 指定四个合同测试、test_registry、test_chapter_acceptance_prompts | 104 passed，3.72s |
| 后端应用 lint | `.venv/Scripts/ruff.exe check app` | 通过 |
| 后端应用类型 | `.venv/Scripts/ty.exe check app` | 通过 |
| 桌面 Node 回归 | `node --experimental-vm-modules --test tests/main/*.test.mjs tests/scripts/*.test.mjs` | 155 passed，2 skipped，0 failed |
| 桌面主进程、renderer 类型 | `tsc -p tsconfig.main.json --noEmit`、`tsc -p tsconfig.renderer.json --noEmit` | 通过 |
| 桌面 lint | `node node_modules/eslint/bin/eslint.js . --ext .js,.jsx,.mjs,.ts,.tsx,.mts` | 通过 |
| 前端类型与 lint | `oxlint . --type-aware --type-check` | 0 warnings，0 errors |
| 前端与启动页构建 | 前端 `vp build` + `generate-precachelist.mjs`；桌面 `vp build` 和 `tsc -p tsconfig.main.json` | 通过 |
| 新 wheel 隔离启动 | 从新 wheel 解包导入 app，启动 TestClient；GET health、GET / | 200 / 200，版本0.12.5 |
| 新 wheel 合同验收 | 真实 measure_text 配对、精确全文、测后加字 | 原稿通过，测后加字拒绝 |

桌面跳过项分别为宿主机缺少创建符号链接权限，以及 Windows 不适用的 POSIX 大小写敏感测试。主进程续启的7项初次因测试 linker 缺声明失败，补齐严格 synthetic 依赖后实际通过；未放宽真实文件、网络或进程边界。后端全量首次发现合同字段缺 schema 描述，修复后重新完整运行得出上表结果。

类型门禁范围为后端 `app`；额外尝试的全仓 `ty check --project backend` 包含 tests 与 hatch 构建环境的类型诊断，不宣称全仓所有 Python 文件类型零诊断。

wheel 从已跟踪后端源码与新增合同模块的隔离 staging 构建，复用本轮新构建 frontend/dist；验证695份源输入并逐个核对 app 文件与 wheel 字节，避免 pnpm 在非交互运行前尝试重装依赖。两种架构复用本机已缓存 Electron43.4.0，重核解包 electron.exe 与对应缓存 ZIP 字节一致。

## 本地发布包核验

Windows x64 / ARM64 的 NSIS、便携 ZIP 和 blockmap 已重新生成，三份更新清单也已重新计算。`verify-release.mjs` 普通及 `--prepared-update-assets` 两种模式均为 ALL CHECKS PASSED。

补充解包核验两种架构的 ZIP CRC、OpenFix.exe PE machine、前端 index、app-update.yml、uv 压缩资源与内置 wheel；两份 app.asar 内 openfic.js、uv-cache.js 与本轮 TypeScript 编译输出逐字一致。wheel SHA-256：`7633c495fc94295237ec257547e459ca953389da42beaa45f12778732e11b1b7`。待上传资产为9个，未使用上一次打包产物。

本轮未在 ARM64 真机运行，也未在用户现有安装上执行覆盖安装或新增小说试写。发布资产替换与在线发现结果待公开后回读记录；本地通过不等于已公开。
