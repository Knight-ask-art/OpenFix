# 自研版本工作目录

本目录是本项目——基于 OpenFic Fork 的自研产品——的代码目录。

**所有自己开发的代码都放在这里。**

---

## 1. 与 OpenFic 目录的区别

| 目录 | 内容 | 是否修改 |
| --- | --- | --- |
| `OpenFic/` | OpenFic 上游原版源码，用作参考与同步来源 | 不修改 |
| `OpenFix/` | 自研版本代码，本产品的正式工程 | 主要开发区域 |
| `docs/` | 产品与工程文档 | 随需求变更更新 |

`OpenFic/` 是只读的上游参照物。开发、调试、打包都发生在 `OpenFix/` 内。

**不要直接在 `OpenFic/` 里改代码。** 否则以后无法区分哪些是上游改动、哪些是自己的改动，也就无法合并上游更新。

---

## 2. 这个目录放什么

Fork 后的完整工程：

```text
OpenFix/
├── frontend/       React 前端
├── backend/        FastAPI 后端
├── desktop/        Electron 桌面壳
└── .github/        自动构建与发布
```

以及本项目新增的部分：

* 新 Feature（`frontend/src/features/` 下的 home、outline、inline-ai、story-memory、consistency、onboarding 等）
* 新后端模块（`backend/app/core/`、`backend/app/api/routers/` 下的 inline_ai、consistency、outlines 等）
* 品牌资源、打包配置、自动更新配置
* 测试与构建脚本

---

## 3. 推荐的落地方式

按 [docs/04 部署形态与 Fork 路线](../docs/04-fork-and-packaging-roadmap.md) 第 10 节，建议：

```bash
# 1. 在 GitHub 上 Fork OpenFic，然后把自己的仓库克隆到这里
git clone https://github.com/你的用户名/你的项目.git OpenFix

# 2. 把官方仓库加为 upstream，用于后续同步
cd OpenFix
git remote add upstream https://github.com/syrizelink/OpenFic.git
git remote -v
```

```text
origin    → 你自己的仓库
upstream  → OpenFic 官方
```

这样官方修 Bug 之后，仍然可以把上游更新合并进来，而不必重写。

分支策略见 [docs/03 源码级改造与开发清单](../docs/03-source-change-list.md) 第 44 节。

---

## 4. 开发时必须遵守的约束

本目录内的所有代码修改都受根目录 [`AGENTS.md`](../AGENTS.md) 约束，重点包括：

* 优先扩展，而不是重写；优先隐藏，而不是删除
* 禁止大规模修改 `backend/app/agent_runtime/`、`backend/app/models/`、`backend/app/socket/`、`desktop/src/main/runtime/`、`backend/app/storage/revision*`
* 不重复造已有能力（Backup、Import、Export、RAG、Updater 等都已存在）
* 界面禁止 Emoji
* AI 修改正文必须经过 Diff 与用户确认
* 每个任务保持最小 Diff，保持与 upstream 的可合并性

产品与需求依据见 [`docs/`](../docs/README.md)。

---

## 5. 当前状态

已从 `OpenFic/` 本地克隆到本目录，分支 `feature/branding`。

用户可见品牌已改为 OpenFix（`appId: com.openfix.app`）。桌面版本号仍为 `0.11.1`，因为 Runtime 仍会 `pip install openfic==${app.getVersion()}`。Phase 5 更新源与 Windows Release 资产链路现已配置为 `Knight-ask-art/OpenFix`；真实 Release、签名与安装后升级尚未验收。

OpenFix 自有标识首轮设计已落地：以打开的书页和校订符号组成透明 PNG 图标，侧栏、登录页、favicon、PWA 与桌面打包配置统一引用 `frontend/public/openfix-logo.png`。应用内运行时、桌面安装包和平台图标效果仍待点验。

**[docs/04](../docs/04-fork-and-packaging-roadmap.md) Phase 1（Fork + 本机跑通）已结束。** 开发模式可启动。自有仓库 `origin` 已接入：`https://github.com/Knight-ask-art/OpenFix`（2026-09-23 由 OpenFic 改名而来），分支均已推送。

**TASK-002（Sidebar / Navigation）已完成**（分支 `feature/navigation`）：一级导航改为首页 / 写作 / 大纲 / 人物 / 世界；Prompt Chains 与 Dashboard 从一级导航隐藏，路由 `/prompt-chains`、`/dashboard` 保留可用；`/outline` 为占位页（`frontend/src/features/outline/`）。已通过 lint / type-check / build 及浏览器冒烟。

下一刀：V0.1 安装包验收（[docs/03](../docs/03-source-change-list.md) 第 37 节），随后 TASK-003（Home）。

**V0.1 安装包已产出并通过本机冒烟**（2026-09-23，分支 `feature/navigation`）：

* 产物：`desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe`（约 120 MB）与同名 `.zip`。
* 打包修复：`electron-builder.yml` 显式将 `publish` 指向禁用端点，避免 electron-builder 从上游 repository 字段推断出 OpenFic 官方 GitHub 更新源。
* 本机验证：静默安装成功、首次启动窗口正常加载实例配置页、开发模式主流程已通过浏览器冒烟。
* 待人工验收：在干净的 Windows 11 虚拟机 / 电脑上安装，走完「实例配置 → 首次联网创建后端运行环境 → 模型配置 → 写作 → 重启数据保留」全链路。
* 已知限制：版本号保持 `0.11.1`（Runtime 依赖 `pip install openfic==${app.getVersion()}`，与 [docs/03](../docs/03-source-change-list.md) 第 37 节的 0.1.0 命名不符，Phase 3 后端 Fork 时解耦）；自动更新尚未接入自有仓库。

**Phase 3 最小实现完成——安装包不再依赖 PyPI 官方 openfic 包**（分支 `fix/packaged-backend-and-layout`）：

* 发现问题：V0.4 包首启验证时，Runtime 仍 `pip install openfic==0.11.1`（PyPI 官方 wheel），导致安装包前端的新页面（大纲/故事记忆/检查/Inline AI）全部 404。
* 修复：`scripts/build-backend-wheel.mjs` 用 `uv build` 把自研 backend 构建成 wheel 并 staging 到 `desktop/backend-wheel/`；electron-builder 经 extraResources 打进 `resources/backend-wheel/`；Runtime 启动安装时优先 `pip install <内置wheel>`（无 wheel 回退 PyPI），wheel 模式下索引探测不再要求 openfic 包存在（镜像测速仍用于拉取依赖）。包名与版本保持 `openfic 0.11.1`，CLI 入口/版本校验逻辑零改动。
* 净装验证：全新安装 → 首启向导 → 本地运行时创建（「安装 OpenFix」步骤从数分钟降到 37 秒）→ 后端 openapi 含 outlines / story-memory / consistency / inline-ai 全部 146 路由 → 大纲节点创建、story-memory 状态、consistency 校验行为均正确。
* 新安装包：`desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe`（149.3 MB，SHA256 `536D2CD69BBA1DC0D11CE619C890DB2E6C39044131B8D41FA6B4F63F21A4E18E`）。
* 完整 Phase 3（改名自有包 `novelflow-core` 之类）仍推迟，不在本刀。
* 复核又发现并修复三个缺陷（`60712a1`）：① **升级路径失效**——存量用户 venv 里是官方同版本 wheel，版本号相同则永远不重装，新接口继续 404；改为安装后写 `.openfix-bundled-backend` 标记，标记缺失/不匹配即判定运行时不完整并强制重装（venv 重建时同步删除标记）；② wheel 选择忽略版本号，按 `openfic-<expectedVersion>-*.whl` 精确匹配；③ `latest.yml` 仍写改名前的 `x64` 文件名，接自动更新后必 404，改为随产物改名同步修正，并清掉脚本里写死的 `OpenFic-` 前缀。
* 修复后安装包：`desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe`（149.3 MB，SHA256 `959A8AC086108C9729F544B2B67159465EC03B360C243795107A09C3FF72861C`）；验证：净装从 wheel 安装、删除标记后重启触发重装、二次启动无重复重装、openapi 146 路由含全部新接口。

**TASK-003（Home Dashboard）已完成**（分支 `feature/home`，已合并入 `feature/navigation` → `feature/branding`）：

* `/` 改为首页（`frontend/src/features/home/`）：继续写作卡、今日 / 本周写作字数（复用 `GET /dashboard/writing`）、最近项目列表；项目库完整功能移至 `/projects`，路由保留。
* 「写作」导航指向最近打开的项目；`/projects` 归入「首页」高亮范围。
* 已通过 lint / type-check / build 与浏览器冒烟（空状态、有项目状态、新建项目、进入写作、返回首页）。

**TASK-004（Settings 普通 / 高级模式）已完成**（分支 `feature/settings`，已合并入 `feature/branding`）：

* 设置类目打上 `basic / advanced` 分层；普通模式仅显示通用、个性化、编辑器、提供商、模型五项。
* 高级模式下其余类目收进可折叠「高级」分组，并提供「提示词链」「AI 使用情况」快捷入口（跳转时自动关闭设置弹窗）。
* 「显示 / 隐藏高级设置」状态存 localStorage（`openfix.settings.advancedMode`），移动端列表同步过滤；未改后端 schema。
* 已通过 lint / type-check / build 与浏览器冒烟（普通模式、切高级、持久化、快捷入口跳转、收回普通模式）。

**TASK-005（Inline AI）已完成**（分支 `feature/inline-ai`，已合并入 `feature/branding`）：

* 后端新增 `POST /api/v1/inline-ai/transform`（`app/api/routers/inline_ai.py` + `app/core/inline_ai/`）：10 种改写动作，复用 `resolve_background_llm`（`light_model` 策略）与 `LLMClient.generate`；**仅返回建议，不写章节**；校验选区长度（8000 字符）、自定义指令、章节归属。
* 前端新增 `frontend/src/features/inline-ai/`：选中文本出现「AI 改写」触发器 → 动作菜单（9 预设 + 自定义）→ 请求中 → Diff 结果面板（`diff` 包行级对比）→ 接受 / 拒绝。接受前校验选中文本未变化，否则提示冲突且不改正文；`chapter-editor.tsx` 仅新增 9 行集成，受 `isAgentLocked` 守卫。
* 测试：后端 7 个新 API 测试 + 全量 1726 个测试通过；前端 lint / type-check / build 通过；浏览器冒烟（触发器、菜单、请求体、400 错误 toast、Escape 关闭、重新选中恢复）通过。
* 未覆盖：真实模型成功路径的接受/拒绝交互（无 API Key，后端成功路径已由 fake-model 测试覆盖），待配置模型后人工验收。

**TASK-006（AI Diff / Accept / Reject 产品化完善）已完成**（分支 `feature/inline-ai-diff`，已合并入 `feature/branding`）：

* Inline AI 调用接入审计日志（`category=editor`、`operation=inline_ai_<action>`），token 用量与错误均进入「AI 使用情况」Dashboard。
* Diff 升级为两级：行级配对 + 行内字符级高亮（`diffChars`），单段落改写可以看清具体改动字符；超长行（>4000 字符）自动退回整行对比。
* 结果面板支持 Enter 接受（捕获阶段拦截，防 ProseMirror 抢键）、底部显示「Enter 接受 · Esc 拒绝」提示。
* **真实端到端验收通过**：本地假 OpenAI 兼容服务 + `openai-compatible` provider 配置 `light_model`，完整走通「选中 → 润色 → 字符级 Diff → Enter 接受 → 自动保存落库 → Dashboard 审计记录（tokens=30, success）」；错误路径（401）同样正确落审计。
* 测试：后端全量 1726+ 通过（成功测试增加审计断言并拦截审计队列，避免测试污染本地库）；前端 lint / type-check / build 通过。
* 验收经验：provider_type 必须用 `openai-compatible` 才会使用自定义 base_url（`openai` 类型直连官方端点）。

**TASK-008（DOCX Import）已完成**（分支 `feature/docx-import`，已合并入 `feature/branding`）：

* 新增 `backend/app/core/docx_parser.py`（python-docx）：Heading 1 → 卷、Heading 2+ → 章；无 Heading 文档回退到现有 TXT 章节规则；手动字数切分复用纯文本路径。
* 导入管线、路由文案、测试扩展；前端导入对话框 `accept` 加 `.docx`，格式提示更新（zh-CN/en）。
* 测试：7 个新 docx 单测 + API 冒烟（preview/confirm/落库验证）通过；后端全量 1733 通过。

**TASK-009（DOCX Export）已完成**（分支 `feature/docx-export`，已合并入 `feature/branding`）：

* 导出 API 加 `format: "txt" | "docx"`（默认 txt，向后兼容）：贯穿 plan、payload、文件路径、清理、下载 MIME 与摘要。
* 新增 `chapter_export/docx_writer.py`：卷 = Heading 1、章 = Heading 2（与导入解析对称），`doc.save` 放线程避免阻塞事件循环。
* 前端导出弹窗加 TXT / Word 格式选择器（zh-CN/en）。
* 测试：2 个新 API 测试（docx 往返 + 非法格式 422）；E2E 冒烟（创建任务 → succeeded → 下载 36KB docx → 读回断言标题层级）通过；后端全量 1735 通过。

**TASK-010（Auto Backup）已完成**（分支 `feature/auto-backup`，已合并入 `feature/branding`）：

* 桌面 config 新增 `autoBackup`（enabled / dir / keep，含校验与归一化），存 localStorage 等价的 config.json，无数据库改动。
* 新增 `desktop/src/main/auto-backup.ts`：每日间隔判断、时间戳 tar.gz 命名、按保留数量轮换，复用 `backupDataDir`。
* `registerIpc` 启动调度器（启动 2 分钟后首查、每 30 分钟检查），自动备份走与手动备份相同的配置变更队列与后端重启流程；新增 `autoBackupNow` IPC。
* 数据管理页新增自动备份卡片：启用开关、目录选择、保留份数、立即备份按钮（zh-CN/en）。
* 验证：核心逻辑 6 项 Electron 内断言全过（命名格式、24h 判断、空目录、轮换、无关文件保留）；desktop tsc main/renderer、eslint、vp build 通过。完整 UI 交互待打包版人工点验。

**TASK-007（Outline 系统）已完成**（分支 `feature/outline`，已合并入 `feature/branding`）：

* 数据库：新增 `outlines` 表（migration `1022_create_outlines.py`，自引用 `parent_id` + `sort_order`，层级 book/arc/volume/chapter，可选卷/章关联）；已验证空库从 1001 完整升级到 1022。
* 后端：`/projects/{id}/outlines` REST API（list / create / update / 级联 delete），service 层校验层级顺序、跨项目父节点、防环；模型注册进测试 registry。
* 前端：`/outline` 占位页替换为真实工作台——项目选择器（记住上次项目）、递归大纲树（逐节点添加子级、自动展开选中）、右侧编辑器（标题 / 层级 / 内容、脏检查保存）、删除前确认含子节点数；i18n zh-CN/en。
* 测试：7 个新 API 测试；后端全量 **1742 通过**；前端 lint / type-check / build 通过；浏览器端到端冒烟（建节点、编辑、保存、加子节点、持久化回查）通过。
* 暂未做：拖拽排序（API 已支持 `sort_order`，UI 未接）、大纲节点关联具体章节 / 卷的下拉选择、AI 生成大纲。

**TASK-011（Story Memory 多数据源）已完成**（分支 `feature/story-memory`，已合并入 `feature/branding`）：

* 未造第二套 RAG：新增 `retrieval/story_memory.py` 复用 `OpenFicRetrievalService` 与 contract 机制，把**人物、世界设定、大纲、笔记**统一索引到 `story_memory:<project_id>` 独立 LanceDB 表（正文沿用既有 `chapters:*` 增量索引）。
* 新后台任务类型 `story_memory_rebuild`（复用 embedding client 构建逻辑，模型变更时中止防错索引）。
* API：`GET/POST /projects/{id}/story-memory/status|rebuild`；前端新增 `features/story-memory/` 页面（项目选择、五类计数卡、状态徽章、重建按钮 + 2s 轮询）与一级导航「故事记忆」。
* 测试：5 个新后端测试；全量 **1747 通过**；前端三连 + desktop tsc/eslint/build 过；**端到端 E2E**：假 OpenAI 兼容 embedding 服务 → UI 点重建 → job ready → 共享引擎查询「剑冢」命中 world_entry（0.989）/character/outline。
* 范围说明：Agent 检索工具暂不消费 story memory（`search_chapters` 仍只查正文），接入统一 Agent Context 属后续；项目删除不清理索引表，与上游 chapter 索引行为一致。

**品牌残留核查（OpenFic → OpenFix）**：桌面安装向导「安装」步骤与启动进度「更新后端」步骤此前因 i18n 键拼写不一致（`installOpenFic` / `updateOpenFicMessage` vs JSON 的 `OpenFix` 拼写）在界面上直接显示含旧名的原始键——已修复（commit `ae53817`）。全面盘点结论：其余 `OpenFic` / `openfic` 字样均为**非用户可见**的内部标识或真实名称（`openfic.db` 数据文件名、`~/.openfic` CLI 默认目录、PyPI `openfic` 包与其 CLI、`persist:openfic-*` 分区、`openfic:*` IPC 事件名、`X-OpenFic-Shutdown-Token`、`OpenFicRetrievalService` 类名），改动会破坏数据兼容或 upstream 可合并性，统一留待 Phase 3 后端 Fork 处理；用户可见文案（窗口标题、HTML title、托盘、设置、About、安装包名）均已是 OpenFix。`runtime/openfic.ts` 日志文案含「OpenFic 运行环境」字样，属 AGENTS 保护区且描述对象是 PyPI 包本身，本轮按约束不动。

**TASK-012（Consistency Checker）已完成**（分支 `feature/consistency`，已合并入 `feature/branding`）：

* `backend/app/core/consistency/`：优先通过 story memory 索引检索相关设定（不可用时退回人物+大纲清单），提示词强制审慎表述（「可能存在问题」而非断言冲突），模型输出解析为受约束 Issue（severity ∈ info/warning/high、证据≤3 条截断、json_repair 容错）。
* `POST /projects/{id}/consistency/check` 仅返回建议不触碰正文；结果暂不持久化（v1 无状态）。
* 前端 `features/consistency/`：项目+章节选择器、Issue 卡（徽章/证据引用/建议/忽略/恢复）、重新检查、底部免责说明；一级导航新增「检查」。
* 测试：7 个新后端测试；全量 **1754 通过**；前端三连过；**端到端**：假对话+假向量模型双通道 → story memory 就绪 → UI 点「开始检查」→ 结果卡显示「可能存在问题 · 人物年龄」+ 双证据 + 建议、上下文来源标注「故事记忆检索」（证明消费了 TASK-011 索引）→ 忽略/恢复可用。
* 暂未做：检查任务化（长章节同步等待）、结果持久化与问题处理状态跟踪、按卷/全书批量检查。

**TASK-013（Onboarding）已完成**（分支 `feature/onboarding`，已合并入 `feature/branding`）：

* `frontend/src/features/onboarding/`：首页首挂向导——欢迎 → 三条路径（创建新小说：复用项目表单并直达写作页；导入已有小说：复用导入对话框；从灵感开始：直达大纲页）→ 可选「连接 AI」说明页（推荐提供商、设置入口、明示不连 AI 也能写作，符合 PRD §27）。
* 完成标记存 localStorage；已有项目或已配置 chat 模型的老用户自动静默跳过（内置 embedding/rerank 不算已配置）。
* 纯前端，无后端改动；lint / type-check / build 通过；浏览器 E2E：新用户全流程（创建项目 → 跳转写作页）、flag 清除后自动跳过回归，均验证通过。

**里程碑：V0.4 内容（Outline、DOCX 导入/导出、自动备份）已全部完成**（对应 [docs/03](../docs/03-source-change-list.md) 第 40 节，另已提前做完 V0.5 的 Story Memory 多数据源与一致性检查两项）。TASK-014 已完成首轮；Phase 5 的更新源与 Windows Release 资产配置已接入，真实 Release、签名和升级验收仍待执行；AI Context UI 的显式读取记录面板已完成首轮实现，完整上下文追踪仍待推进。

下一步：继续补齐 V0.5 AI Context UI 的上下文来源覆盖；Phase 5 真实 Windows Release、签名配置和安装后自动升级验收仍需签名身份及干净 Windows 环境。

**TASK-014（V1 整体测试 / 发布校验）已完成首轮**（分支 `feature/release-verification`）：

* **发布产物静态校验** `desktop/scripts/verify-release.mjs`（`pnpm verify:release`）：15 项不变量——产物齐全且架构后缀已规范化、`latest.yml` 引用的文件存在且 sha512/size 与实际一致、内置 wheel 版本匹配、`app-update.yml` 未回退上游、前端 bundle 确实含 V1 新页面。回归验证：把 `latest.yml` 改回改名前的 `x64` 文件名后脚本立即报错并以退出码 1 失败（即上一个 bug 的形态），恢复后全过。
* **安装包端到端冒烟** `desktop/scripts/packaged-smoke.mjs`（零依赖，直连 CDP）：静默安装 → 首启向导 → 运行时安装 → 主界面 → openapi 校验 → 关键 API 冒烟 → 清理。当前 **15/15 PASS**（含大纲建节点、故事记忆状态、一致性检查路由可达、清理冒烟项目）。
* 修复首启链路两个真实缺陷：① 首次运行强依赖联网安装 **uv**，受限网络下两个镜像均失败并直接中断整个安装流——自带 wheel 后改用 venv 自带 pip，移除 uv 依赖；② 用户已有 Python 时仍强制下载便携 Python——新增系统 Python 复用（3.12/3.13 区间，与 `requires-python` 一致，校验 ensurepip/venv，解释器来源记入 `.openfix-python` 标记以保证切换时只重建一次 venv）。实测本机命中 3.13.4、零下载、二次调用不重复重建；版本门控对 3.11/3.14/2.7 正确拒绝。
* 修复冒烟脚本自身两个缺陷：起始页也含「开始使用 OpenFix」按钮导致误判安装完成；向导前进按钮的 React 处理器不响应原生 `element.click()`（改用类选择器 + 完整指针事件序列）。

**Phase 5（自有 GitHub Release 与自动更新）首轮实现**（2026-10-01）：

* Electron Builder、打包更新资源与桌面更新器都指向 `Knight-ask-art/OpenFix`；本地更新冒烟继续使用独立 loopback 配置。
* Windows 更新清单、Release 上传文件名与包验收工作流已统一到 `OpenFix-*`；Release 静态校验增加了自有更新源与 x86_64 / aarch64 更新清单检查。
* Windows 包验收与 Release runner 会在打包前运行现有 `build-backend-wheel.mjs`，将内部 `openfic` wheel 一并打入安装包；GitHub Actions 实际运行仍待验证。
* Fork 中的 tag 不再运行继承的 PyPI `openfic` 或 Docker 发布任务。
* 这轮没有创建 tag、上传 Release、签名或执行安装后升级；当前更新链路尚未完成真实发布验收。

后续 Phase 5 验收：配置 Windows 签名身份，发布一版测试 Release，在干净 Windows 11 环境验证安装、检查更新、下载、安装升级和数据保留。当前没有创建 tag、上传 Release、签名或安装后升级验证。

**V0.5 AI Context UI（显式读取记录首轮，2026-10-02）**：

* Agent 侧边栏新增「对话 / 上下文」切换；上下文面板读取当前主会话或子会话中已完成且成功的资料工具记录。
* 展示章节正文、目录、检索与摘要，以及人物、世界设定、笔记的名称、章节序号和来源类型；合并重复资料，不展示正文内容。
* 本轮没有新增 PRD 所列的独立「建议」视图；该视图仍需单独定义数据来源和交互。
* 面板只反映显式读取工具返回，不包含当前选中章节、自动注入内容、尚未接入 Agent 的上下文 API 或模型的完整输入。因此这是可核对的读取记录视图，不代表完整 Prompt / Context 追踪。
* 验证：前端 type-check、lint、production build、格式检查和 `git diff --check` 通过；未执行测试或应用内 E2E / Tauri 打包验收。

**V0.4 安装包已重新产出**（2026-09-27，`desktop/dist-electron/`；该产物已被下方 2026-10-02 的包取代，SHA256 仅供参考）：

* 产物：`OpenFix-0.11.1-win-x86_64-setup.exe`（120.5 MB，SHA256 `7B50AD0268D72470099F759678E79E52DDF04B168730762F23084C125FB638D6`）、同名 `.zip`、`.blockmap`。
* 本机验证：静默覆盖安装成功、启动窗口正常（setup UI bundle 为最新构建）；包内容抽查确认 story memory / consistency / inline-ai / outlines 路由、自动备份（`OpenFix-backup-*`、`autoBackupNow`）、onboarding 与品牌键修复均已进入安装包；该版本构建时的 `app-update.yml` 仍指向禁用端点。
* 干净 Windows 11 人工验收清单（待执行）：
  1. 全新环境双击安装 → 首启动向导（欢迎 → 创建/导入/灵感 → AI 说明）；
  2. 配置本地实例（首次会联网创建 Python venv 并安装后端——当前设计，见 docs/04 Phase 3）；
  3. 设置 → 提供商填入 API Key → 模型可用；
  4. 新建项目 → 写章节 → 选中文字走 Inline AI 润色（Diff + Enter 接受）；
  5. 大纲建树、故事记忆重建、一致性检查出结果卡；
  6. 导入 DOCX、导出 DOCX、自动备份（选目录 + 立即备份 + 轮换）；
  7. 重启应用数据完好、升级安装（覆盖装新版本）数据保留。

**V1.0 验收链路复核与安装包重出**（2026-10-02；本轮不新增产品功能，只补验收证据并重出安装包）：

* 本机重新打包并复核 Phase 5 更新链路（Windows 11，未签名）：
  * `pnpm build` 后以独立 `UV_CACHE_DIR` 运行 `pnpm package` 成功；产物 `desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe`（157,940,977 字节，SHA256 `046DBD054BFEAA2BA48F874D646759AED3320A54506AE8C76588B4DAE15EA024`）与 `OpenFix-0.11.1-win-x86_64.zip`（188,373,359 字节，SHA256 `ABB5BE510FC24040A36C4E19FFADB9A2A0C175A62DD5B9FEF0AC3FED2B428C2A`）。
  * 新包内 `resources/app-update.yml` 为 `provider: github` / `owner: Knight-ask-art` / `repo: OpenFix`；2026-09-27 旧包仍是禁用端点，这正是静态校验曾失败的根因。
  * `pnpm verify:release`（`desktop/scripts/verify-release.mjs`）**ALL CHECKS PASSED**（旧包上同一脚本有 4 项失败，全部指向 `app-update.yml` 身份不变量）。
  * `node scripts/packaged-smoke.mjs` **SMOKE PASSED，15/15**：隔离临时目录静默安装 → 首启向导完成运行时安装 → 主界面 → openapi 146 路由 → 建项目 / 建大纲节点 / 故事记忆状态 / 一致性路由可达 → 清理；脚本自行清理临时目录。
  * 打包未配置签名身份，electron-builder 的 signtool 步骤无可用证书，产物**未签名**。
* 用隔离数据目录（`OPENFIC_DATA_DIR` 指向临时目录，未触碰 `backend/data/`）复核后端链路：项目 → 角色 → 世界设定 → 大纲 → 卷 → 章节创建成功；DOCX 导入 preview/confirm 正确（Heading 1 → 卷、Heading 2 → 章）；DOCX 导出任务 succeeded 并下载到 36,709 字节 Word 文档；未配置模型时 Inline AI 与一致性检查均返回 400 +「后台任务模型未配置: light_model」，错误路径无 500；后端重启后既有项目数据完好且不重复执行 migration。
* 复核结论：`backend/` 中 inline_ai、consistency、outlines、story_memory、docx 相关文件自各自功能提交后未再改动，TASK-006 / 007 / 009 / 011 / 012 记录的真实模型端到端结论对当前代码仍然成立。本轮未改动任何产品源码。
* 已知环境限制（非代码缺陷）：本机 checkout 为 CRLF（`core.autocrlf=true`），`pnpm format:check` 会对整仓库报格式差异（LF/CRLF 归一化），在 LF checkout / CI 上不出现；`uv build` 曾因 `%LOCALAPPDATA%\uv\cache\builds-v0` 残留临时目录报错，改用独立 `UV_CACHE_DIR` 后成功（未清理用户级 uv 缓存）。
* V1.0 仍需外部条件才能完成的验收（均未执行）：
  1. Windows 代码签名身份与签名产物；
  2. 干净 Windows 11 上「安装 → 检查更新 → 下载 → 覆盖升级 → 数据保留」的人工验收；
  3. 真实 GitHub Actions 运行与自有仓库 Release 发布（本轮未创建 tag、未上传 Release、未触发远端 workflow）。
* 尚未实现、需要产品决策后再开工的 PRD 条目（本轮未擅自实现）：PRD §15/§16 人物扩展字段与「人物当前状态」、PRD §17 世界设定类型/标签/关联、PRD §21 独立「AI 页面」预设任务、PRD §20 一致性检查的「当前卷 / 全书」范围、PRD §12 侧边栏「建议」视图（PRD 未给出数据来源与交互定义）、PRD §3 一级导航中的「AI / 设置」入口（现状为 OpenFic 的右侧助手 + 设置弹窗）。

> 上述「尚未实现」清单已被下一节的未提交工作树实现覆盖，保留原文以记录当时的结论。

---

**V1.0 剩余 PRD 条目：未提交工作树复核与修复**（2026-10-02 第二轮；本轮未新增打包产物）

工作树中已存在（尚未提交）的 V1.0 实现，覆盖上一节列出的全部六项：

* PRD §15/§16 人物扩展字段与人物当前状态：`character_profiles` / `character_states`（migration `1023`）、`GET/PUT /characters/{id}/profile`、`GET/PUT /characters/{id}/states`、`DELETE /characters/{id}/states/{state_id}`、`features/characters/components/character-author-panel.tsx`。
* PRD §17 世界设定类型 / 标签 / 关联 / AI 可见性：`world_entry_meta`（migration `1024`）、`GET/PUT /world-info-entries/{id}/meta`、`GET /projects/{id}/world-entry-meta`、`features/world-info/components/entry-meta-panel.tsx`。
* PRD §21 独立 AI 页面预设任务：`frontend/src/features/ai/`，路由 `/ai`，一级导航新增「AI」（`sidebar-nav-config.ts`）。8 个预设任务把提示词追加到右侧助手输入框，其中「一致性检查」直接跳转 `/consistency`。
* PRD §20 一致性检查范围：`scope = chapter | volume | book`，前后端与 i18n 三处枚举一致；`run_consistency_check` 按范围收集章节、分段（48000 字符）调用模型并返回范围标签与章节数。
* PRD §12 侧边栏「建议」视图：助手侧栏新增「建议」标签页（`agent-suggestions-panel.tsx`），建议来自故事记忆状态与项目计数，全部为跳转入口，不自动调用模型；同时保留「上下文」读取记录面板（上一节记录）。
* PRD §3 一级导航「AI / 设置」入口：「AI」现为一级导航项；「设置」仍是侧栏底部齿轮按钮（`sidebar-actions.tsx`）与状态栏索引按钮打开的弹窗，没有独立路由——沿用 OpenFic 既有形式，未新建页面。
* 另有超出上述六项、同样未提交的实现：`project_profiles` / `chapter_meta`（migration `1025`）、项目总览页 `/projects/:projectId/overview`、大纲 AI 四动作（`/projects/{id}/outlines/ai/improve|check-pacing|split-chapters|update-from-chapter`）、新书搭建草案 `POST /story-setup/draft`、Agent 统一故事记忆检索工具 `search_story_memory`（含 `story_memory_read` 工具类别）。

本轮复核修复 3 处缺陷（均在未提交工作树内）：

1. `features/world-info/components/entry-editor-panel.tsx` + `entry-meta-panel.tsx`：`EntryMetaPanel` 补 `key={entry.id}`，并在扩展信息查询成功前禁用编辑与保存。此前切换世界设定条目时表单保留上一条目的类型/标签/关联，保存会把上一条目的扩展信息写到当前条目（数据错误）。
2. `i18n/locales/zh-CN.json` + `en.json`：`assistant.suggestions.openSettings` 原文案为「打开故事记忆 / Open story memory」，但该按钮实际打开「设置 → 索引」，改为「打开设置 / Open settings」。
3. `features/ai/pages/ai-tasks-page.tsx` + `.css`：桌面端把助手宿主移入固定右栏（440px 网格列）。此前宿主是页面 flex 列末端的整宽元素，助手浮层按整页宽度定位并覆盖任务网格（移动端仍走全屏浮层）。

未改动但需记录：`storage/services/__init__.py` 未导出 `chapter_meta_service`、`project_profile_service`、`world_entry_meta_service`，三者靠 `from app.storage.services import x` 的子模块回退生效。补导出属纯风格改动且会给该文件引入 EOL 差异，本轮未改，留待与其它服务导出规则一并整理。

静态复核结论（逐条对照源码、路由、i18n 与既有测试）：

* 迁移链 `1022 → 1023 → 1024 → 1025` 连续、无分叉；新表均已在 `storage/models/__init__.py` 与 `tests/model_registry.py` 注册。
* 前端调用的每个新接口路径与后端路由逐一对应（project profile / character profile+states / chapter-meta / world-entry-meta / outlines/ai/* / story-setup/draft），未发现 404 路径。
* 两套语言包 key 集合一致（唯一差异 `resultSummary_one` 为英文复数形式，中文按 i18next 规则用 `resultSummary_other`，属正确差异）；新增页面文案均走 i18n；新增文件无 Emoji、无 `any`。
* 级联清理已覆盖并已有 API 测试：删除项目 / 章节 / 卷 / 人物时同步清理扩展表与关联 ID（`test_project_and_chapter_meta.py`、`test_character_extensions.py`、`test_world_entry_meta.py`）。
* 发布校验脚本已跟进：`verify-release.mjs` 增加 `openfix.ai.projectId` / `chapter-meta` / `/profile` 产物标记；`packaged-smoke.mjs` 扩展覆盖项目属性、大纲节点、人物、世界设定扩展、章节状态、一致性路由、DOCX 导出与自动备份。

本轮未执行的验证（环境限制，不代表通过）：

* 后端 `pytest` / `ruff` / `ty` 与前端 `lint` / `type-check` / `build` 均未执行。本会话无法获得运行 Python、Node、pnpm 等命令的授权，所有执行类命令（含通过子代理）均被拒绝，`python -c`、`.venv/Scripts/python.exe -m pytest`、`pnpm --version` 等一律返回「requires approval」。
* 未重新打包，未运行 `pnpm verify:release` 与 `packaged-smoke.mjs`。上一节记录的安装包 SHA256 与 15/15 冒烟对应的是修复前的代码，本轮 3 处改动未进入任何产物。
* 因此本轮改动仅经静态复核，未经编译、lint 或运行验证。

仍未完成 / 已知限制（均有源码位置可查）：

1. `ai_visible` 目前只在故事记忆索引构建与状态计数中生效（`retrieval/story_memory.py`）；Agent 资料工具（`agent_runtime/tools/impls/context/world_entry.py`）、`@` 提及候选（`mention_service.py`）与 `canonical_mentions.py` 仍可读到已隐藏条目，且切换开关不会自动重建索引，需手动重建后才完全生效。扩展面板提示「关闭后该设定不会进入故事记忆检索，也不会提供给 AI」在重建前偏乐观。
2. 人物扩展字段、人物状态、世界设定扩展信息、大纲与笔记的保存都不会把故事记忆索引标记为过期；`compute_story_memory_status` 直接读取索引行状态，因此不会出现「索引陈旧」提示。人物资料面板「这些字段会随人物一起进入故事记忆」需手动重建后才成立。
3. 全书范围一致性检查是同步请求、按 48000 字符分段顺序调用模型，段数无上限（300 章约 20–30 次调用），前端超时 5 分钟；检查任务化仍属后续工作。
4. 修订回滚（`agent_runtime/revisions.py`）硬删除人物 / 章节 / 世界条目时不清理扩展表与关联 ID；SQLite 未开启 `PRAGMA foreign_keys`，会残留孤立扩展行。
5. 删除项目不删除 `characters` 行（`project_service.delete_project` 上游既有行为，非本轮引入）。
6. 模型声明与迁移存在轻微漂移（`world_entry_meta.ai_visible` 的 `index=True`、`character_profiles.character_id` 的唯一索引形式）；测试用元数据建表、生产用迁移建表，功能不受影响。
7. `git diff --check` 在 4 个后端文件上报 trailing whitespace（`storage/repos/__init__.py`、`storage/services/chapter_service.py`、`project_service.py`、`world_info_service.py`）。这 4 个文件在 HEAD 中本就是 CRLF/LF 混合（`git show HEAD:<file> | file -` 可复现），新增行沿用 CRLF 即被判为行尾空白，属既有 EOL 状况，不是本轮引入；在 LF checkout / CI 上不出现。

---

**V1.0 本机最终验收与数据保护补洞**（2026-10-02 第三轮；未提交、未推送、未创建 tag / Release）：

* 复核本轮新增的 Agent revision 扩展快照：migration `1027` 接在 `1026` 后；模型已加入 SQLModel registry 与 revision 子表清理；人物作者字段 / 状态、章节扩展与人物状态、世界设定类型 / 标签 / AI 可见性 / 关联都随 Agent 回滚捕获和恢复。原有修改/删除回归测试已适配删除前捕获；SQLite 下创建、更新、删除场景由完整回滚套件覆盖。
* 修复 `character_extension_repo.replace_states()` 将 `dict[str, object]` 直接展开给 SQLModel 构造器导致的 `ty` 错误，改经 `CharacterState.model_validate()` 校验后写入。同步调整旧删除工具单测对新增快照捕获的 mock，并把 migration-head 断言更新到 `1027`。
* 后端 fresh gates：`uv run ruff check .`、`uv run ty check app` 通过；`uv run pytest -q` **1870 passed**。4 个新适配的定向回归测试也通过。
* 前端 fresh gates：`pnpm lint`、`pnpm type-check`、`pnpm build` 通过；桌面端 `pnpm lint`、`pnpm type-check` 通过。构建仍有已知大 bundle warning（主 JS 约 3.9 MB，tokenizer chunk 约 2.3 MB），不影响构建成功。
* 使用独立 `UV_CACHE_DIR` 重新构建 Windows x64 安装包：`OpenFix-0.11.1-win-x86_64-setup.exe`（158,037,204 bytes，SHA-256 `56af012211773a50bf3999b7a07f9c28d4edaaec57f025fe2d57c1f8a4ae9d0a`）与 `OpenFix-0.11.1-win-x86_64.zip`（188,471,980 bytes，SHA-256 `a3d24a66640818124253dc2eff6968b66e0202e3ed1b15712485f5862e49b447`）。`pnpm verify:release` **ALL CHECKS PASSED**。
* `node scripts/packaged-smoke.mjs` **SMOKE PASSED，37/37**：临时隔离安装目录与 Electron profile → 首启运行时安装 → 主界面 / 后端 → 11 个 V1 路由标记 → 合成项目、项目属性、大纲、人物字段与状态、世界设定扩展、章节与正文、Story Memory 计数、一致性路由 → DOCX 生成与下载 → 桌面 Data Manager 自动备份产物 → 关闭本次进程并清理临时目录。合成数据目录已由脚本清理。
* 对前两轮的遗留缺口更新结论：`ai_visible` 已由 Agent 世界书工具、mention 路径和 Story Memory 检索共同执行；扩展源数据改变会让指纹新鲜度变为 stale；revision 回滚已清理孤儿并恢复扩展快照。之前记录的「仍未实现」描述是当时的工作树快照，已被后续实现及本轮门禁覆盖。
* 仍未由本轮证据关闭的事项：真实模型供应商调用下的 Inline AI / Agent 用户验收；干净 Windows 11 从旧版覆盖升级后的数据保留；真实 GitHub Actions / Release；经证书链验证的代码签名身份与签名产物。当前冒烟使用合成数据，路由可达不等于真实模型调用已验收。
* `git diff --check` 仍会在上述 4 个已知混合 CRLF/LF 后端文件报告行尾空白；避免为了清掉这类噪声归一化整文件行尾。移除 `test_story_memory.py` 新增用例末尾的多余空行后，本轮没有新增该项 EOF 报告。
* Claude Code 2.1.280 已尝试继续只读复审，但调用以 `Exceeded USD budget (2)` 结束，没有复审结论；实现报告也不能替代主代理复核。本轮没有提交、推送、签名或发布。

**V1.0 上下文快照与最新本机复核（2026-10-02 第四轮；未提交）**：

* 修复 Agent 上下文来源快照的隐私缺口：快照依据实际模型输入中的工具调用 ID 解析工具名，并且只读取成功工具结果中的标签；章节标题、人物名和世界设定标题不再回退到工具参数。新增哨兵测试，确认参数中的用户文本不会进入快照；父 / 子 Agent 的快照分别持久化到各自会话。
* 后端完整测试最新记录为 **1880 passed**（`ruff check`、`ty check` 及完整 pytest；FastCtx job `j-qyjop2`）。随后再次运行 `ruff check .`、`ty check app`，并对快照、历史恢复、图、持久化、父 / 子 Agent 等 7 个测试文件定向复跑，**99 passed**。
* 最新前端 `pnpm lint && pnpm type-check && pnpm build` 通过（429 个文件 0 lint / 类型错误，production build 成功）；桌面端 `pnpm lint && pnpm type-check` 通过。构建仍有既有的大 JS chunk 警告。
* 当前 Windows x64 产物已复算：`OpenFix-0.11.1-win-x86_64-setup.exe`（158,039,308 bytes，SHA-256 `aedbb0cbc26421f8ff24d7d49382422d81cbf02a8b0c484d35daddc8d3bffb11`）；`OpenFix-0.11.1-win-x86_64.zip`（188,474,245 bytes，SHA-256 `3243b043d0d756dda39a4babf8ff6f5e171d352354c06f18c99fe29b33ae48c3`）。本轮再次运行 `pnpm verify:release`，全部静态检查通过；前一轮 packaged smoke（job `j-5azsnl`）通过，覆盖隔离安装、首启运行时、V1 路由、合成创作链路、DOCX 下载、自动备份和临时目录清理。本轮更新后的 smoke 结果见下节。
* 用户确认 Claude Code 暂时无法登录。本轮没有新的 Claude Code 实现或审查结论；此前 API Key 环境下的调用曾超预算，不能当作成功委派或通过的复审。
* 本机代码、构建、产物静态校验和合成冒烟已有通过证据；V1.0 正式发布仍未完成。真实供应商模型用户链路、干净 Windows 11 覆盖升级与数据保留、远端 GitHub Actions / Release、经证书链验证的签名仍待外部条件。本轮未提交、推送、签名、创建 tag 或发布。

---

**V1.0 包冒烟与清理误报修复**（2026-10-02 第五轮；未提交）：

* 修正 packaged smoke 中 `modelId` 定义在章节分支内、却在外层 Agent 会话创建时引用的作用域错误。
* 首次扩展 smoke 的 job `j-kaqbwp` 完成合成模型链路与重启持久化，但 Data Manager 步骤失败。诊断发现重启后脚本连到 `app://openfic/` webview；该 target 没有 Electron preload 桥，桌面配置文件中的本地实例实际仍在。脚本现改为连接 `app://setup/ui.html` 桌面主窗口 target，再通过 `openficDesktop` 读取配置与运行 Data Manager。
* 后续 job `j-svnx64` 的 59 条产品与接口断言通过，覆盖 Inline AI 候选不覆盖正文、假模型 Agent 成功回复、一致性检查、DOCX、重启后的项目 / 正文 / 模型 / Agent 对话 / 加密凭据持久化，以及 Data Manager 自动备份文件生成。
* `j-svnx64` 最后清理隔离 profile 时遇到 Windows `EPERM`；当时脚本没有把 `removeWorkspace()` 的失败加入失败集合，因而虽打印清理失败仍输出 `SMOKE PASSED`。该次结果不能作为全绿 smoke 记录。
* 确认没有 OpenFix、Electron 或 Python 进程后，核对临时目录解析到本次生成的精确 Temp 路径，并用 `fs.rmSync` 的 `maxRetries=40`、`retryDelay=500` 删除成功，耗时约 37 秒。脚本现使用该重试范围，并把清理结果计入 PASS / FAIL。
* 截至第五轮记录时，最终脚本改动通过 `node --check`、`pnpm exec eslint scripts/packaged-smoke.mjs`、该文件的 `git diff --check`；遗留 smoke 目录已确认不存在，清理修复后的完整回放尚未完成。第六轮复核见下节；不将前述 `SMOKE PASSED` 当成清理通过。
* V1.0 正式发布仍待真实供应商模型用户链路、干净 Windows 11 旧版覆盖升级及原数据保留、远端 GitHub Actions / Release、经证书链验证的 Windows 签名身份；Claude Code 暂时无法登录，本轮没有新的子代理审查结果。本轮未提交、推送、签名、创建 tag 或发布。

**V1.0 packaged smoke 首启 DOM 复核（2026-10-02；未提交）**：

* 在空闲调试端口 `19224`、且无现存 `OpenFix.exe` 时，定向回放 job `j-3km75p` 安装并启动了当前包，但在 setup 流程开始前退出：CDP 目标已出现时 `document.body` 仍为空，原 `page.text()` 直接读取 `innerText` 抛错。安装包产品断言未执行；profile `startup.log` 记录桌面 shell 随后完成加载。
* 将现有 `page.text()` 读取改为在 `document.body` 尚未建立时返回空文本，供既有轮询等待页面就绪。`node --check scripts/packaged-smoke.mjs`、`pnpm exec eslint scripts/packaged-smoke.mjs` 与目标文件 `git diff --check` 通过；最新改动未再通过完整 packaged smoke 验收。
* `j-3km75p` 异常收尾也遇到 `EPERM`。确认 OpenFix / Python 进程和调试端口均已退出，检查临时路径属于该 job 新建的隔离目录后，已手动移除；此前 `j-svnx64` 的59项产品断言仍是最近一次完成产品链路的证据，但其清理失败不能算全绿。
* 本机 packaged smoke 与 V1.0 正式发布均保持 `needs-verification`。正式门槛仍包括真实供应商模型用户链路、干净 Windows 11 旧版覆盖升级及数据保留、远端 GitHub Actions / Release、经证书链验证的 Windows 签名；Claude Code 暂时无法登录，本轮无其实现或复审结果。本轮未提交、推送、签名、创建 tag 或发布。

**V1.0 packaged smoke 收尾验收（2026-10-02；本机合成链路通过，未发布）**：

* 对当前 Windows x64 安装包再次执行 `node scripts/packaged-smoke.mjs --port=19226`，FastCtx job `j-sm45t2` 以退出码 0 完成，日志记录 **60 项 PASS / SMOKE PASSED**。
* 覆盖隔离静默安装、首次启动下载 Python 并安装运行时、主界面与后端连接、11 个 V1 API 标记、项目 / 项目属性 / 大纲 / 人物和状态 / 世界设定扩展 / 章节、合成模型 Inline AI 候选保护与接受、Story Memory、一致性检查、Agent 成功回复、DOCX 生成下载、重启后的项目正文 / 模型配置 / Agent 对话 / 加密凭据保留、Data Manager 非空自动备份，以及本次进程退出和临时目录清理。
* 脚本的自动备份断言要求找到 `.tar.gz` 且文件大小大于零；该项与临时目录清理均显示 PASS。隔离目录 `C:\Users\20969\AppData\Local\Temp\openfix-smoke-dNRvGD` 已由脚本删除。
* 本机已打包合成用户链路和收尾清理通过，信心等级 B。它仍不覆盖真实供应商模型验收、干净 Windows 11 从旧版本覆盖升级与数据保留、远端 GitHub Actions / Release、签名证书身份及证书链。Claude Code 暂时无法登录，本轮未取得其独立复审。本轮未提交、推送、签名、创建 tag 或发布；**V1.0 正式发布状态仍为 `needs-verification`**。

**V1.0 当前 Windows x64 包 smoke 异常与旧临时目录清理（2026-10-02；未发布）**：

* 最新静态校验包仍为 `OpenFix-0.11.1-win-x86_64-setup.exe`（158,042,666 bytes，SHA-256 `2891da7d7cece1f41f1c601d610d6636e1295242c7c24345a254b13fd6a24044`）与 portable ZIP（188,477,926 bytes，SHA-256 `2132f7534b788b0c8f39fcf5879fd2c0c2ef5db3b9d338cacabe431ccbc1f955`）。本机 `pnpm verify:release` 通过，安装包 Authenticode 状态为 `NotSigned`；先前 `j-sm45t2` 的通过结果属于旧包，不能替代当前 hash 的验收。
* 当前包 smoke job `j-8wrmht` 退出码 1。安装、合成创作链路、Inline AI 候选保护与接受、Story Memory、一致性、Agent、本地模型、DOCX、重启后数据 / 凭据保留、非空自动备份均通过。整体 smoke 仍判失败。
* 后端日志记录冷启动生成 `/openapi.json` 用时 8,163.65 ms；smoke 的 `httpJson` 默认仅等 8,000 ms，超时后回传 `null`，造成 0 路由及所有 marker 断言的 harness 假失败。已将该检查单独放宽为 30 秒。
* 首启主界面的旧检查依赖 CDP `/json` 出现独立 `app://openfic` target，当前 job 未观察到该 target；同期后端日志出现设置、仪表盘、模型、项目与 socket 请求，结果不足以确认产品界面未加载，也不足以证明 CDP target 已可见。smoke 现从桌面壳直接读取嵌入式 `<webview>` 的 URL 与 loading 状态，并在失败时输出壳内状态；此修订还未打包或回放。
* 当前 job 的脚本最终清理返回 `EPERM`。在确认没有引用这些临时目录的进程后，已删除并核实以下三个 Temp 路径均不存在：`openfix-smoke-ii8UD4`、`openfix-smoke-UXsCz6`、`openfix-smoke-JUEQH5`，共回收 3,370,651,107 bytes（约 3.37 GB）。smoke 清理增加两轮有界延迟重试；目录清理修订仍需随下一包验收。
* 当前 `packaged-smoke.mjs` 已通过 `node --check`、本地 ESLint 与目标文件 `git diff --check`。未因 process-artifact-pressure 再运行整包 smoke；新的 shell-webview 检查、30 秒 OpenAPI 等待及清理重试均未在新包中验证。
* 因此当前包的本机 smoke 保持 `needs-verification`，正式发布也保持 `needs-verification`。真实供应商模型链路、干净 Windows 11 旧版覆盖升级与数据保留、远端 GitHub Actions / Release、Windows 签名证书身份与链验证，以及 Claude Code 复审均未关闭。本轮未提交、推送、签名、创建 tag 或发布。

**V1.0 当前包修订后 smoke 回放**（2026-10-02；本轮仅一次，未发布）：

* 回放仍使用 EXE SHA-256 `2891da7d7cece1f41f1c601d610d6636e1295242c7c24345a254b13fd6a24044`、ZIP SHA-256 `2132f7534b788b0c8f39fcf5879fd2c0c2ef5db3b9d338cacabe431ccbc1f955`；没有重新打包产品。
* FastCtx job `j-gepsnv` 通过静默安装与 CDP 启动检查。新 profile 首启停在「安装 OpenFix」运行时安装步骤，超过 smoke 的 15 分钟上限后退出 1；前端主界面和后端未就绪，后续路由、一致性、写作、重启及自动备份检查都无法执行。当前证据只能说明运行时安装超过测试时限，不能证明安装最终失败，也不能把依赖它的接口失败归类为单独的产品缺陷。
* 收尾首次遇到 Windows `EPERM`，延迟重试后清理通过。`openfix-smoke-R0dyMV` 已删除；复核 Temp 中没有 `openfix-smoke-*` 目录，且没有进程命令行引用该隔离路径。没有保留 smoke profile。
* 截至本次记录时，本机当前包 smoke 与正式发布均为 `needs-verification`；该状态后来由下方 `j-fpiwyo` 受控回放更新。本轮后不再重复生成 smoke 环境。真实供应商、干净 Windows 11 覆盖升级、远端 Release、签名证书链及 Claude Code 复审仍未验收。未提交、推送、签名、创建 tag 或发布。
* 复核当前工作树的一致性卡片：`查看原文` 展示后端定位到的原文片段，`AI 分析` 调用一致性复核 API；对应 API 与后端测试源码均存在。此前只读审计提出的这项缺口不符合当前代码状态。

**V1.0 当前包修订后 smoke 与临时目录收尾（2026-10-02；本机合成验收通过，未发布）**：

* 在同一 Windows x64 安装包上仅执行一次 30 分钟有界 smoke，FastCtx job `j-fpiwyo` 退出码 0，完整日志记录 63 项 PASS 和 `SMOKE PASSED`。安装包 SHA-256 为 `2891da7d7cece1f41f1c601d610d6636e1295242c7c24345a254b13fd6a24044`；portable ZIP SHA-256 为 `2132f7534b788b0c8f39fcf5879fd2c0c2ef5db3b9d338cacabe431ccbc1f955`，均与本次运行前核对的产物一致。
* 首次运行时依赖安装约 18 分钟后完成，随后通过前端 webview / 后端连接、11 个 V1 API、项目 / 大纲 / 人物 / 世界设定 / 章节、Inline AI 候选保护、Story Memory、一致性结果原文定位与 AI 分析、Agent、本地模型、DOCX、重启后的正文 / 模型 / Agent 对话 / 加密凭据保留，以及非空自动备份。该 smoke 使用合成数据和本地 OpenAI 兼容假模型，不代表真实供应商验收。
* 最终清理首次遇到 Windows `EPERM`，一次延迟重试后删除本次隔离目录 `openfix-smoke-Q9rBYd`。退出后复核没有 OpenFix / Python 进程引用该目录、`19544` 调试端口已释放、Temp 下没有 `openfix-smoke-*` 目录；C 盘可用空间约 97 GB。本轮 PIP / UV 缓存路径位于本次 workspace 内，清理时一并删除；没有触碰其他用户级缓存。上一轮清掉的三个旧目录共回收约 3.37 GB。
* 前一轮 `j-gepsnv` 在 15 分钟时限退出于运行时安装阶段；本次成功回放更新了当前包 smoke 状态。历史失败仅表示该次等待超时，不构成产品路由失败。
* 当前 Windows x64 包的本机合成 smoke 已通过，信心等级 B；V1.0 正式验收仍为 `needs-verification`。未覆盖真实供应商用户链路、干净 Windows 11 从旧版本覆盖升级与原数据保留、远端 GitHub Actions / Release、Windows 签名身份及证书链。该次 smoke 本身不包含 Claude Code 复审；之后用户确认第三方 API 接入可用，限定只读审计已完成。没有提交、推送、签名、创建 tag 或发布。

**V1.0 续作：旧 smoke 环境核查与清理（2026-10-02；未重跑）**：

* 复查 Windows `%LOCALAPPDATA%/Temp`，没有遗留 `openfix-smoke-*` 安装目录或 profile；当前没有运行中的 OpenFix packaged-smoke job。本轮没有重复安装包冒烟。
* 删除此前打包任务专用的 5 个隔离 UV 缓存（`openfix-v1-uv-cache`、`openfix-v1-uv-cache-20261002`、`openfix-v1-uv-cache-20261002-context`、`openfix-v1-uv-cache-20261002-runtime-consistency`、`openfix-context-snapshot-uv-cache`），约回收 73 MB；逐一确认路径已不存在。保留日志、品牌图片和隔离测试数据库。
* 重新核对 packaged-smoke 清理实现：只递归删除本次 `mkdtemp` 创建的 workspace；进程未确认退出时保留环境并让 smoke 失败，清理结果也计入最终 PASS / FAIL。
* Claude Code CLI 2.1.280 的最小只读调用返回 `READY`；窄范围审查 job `j-7g0itq` 完成，结果为 `No confirmed blocker in this slice.`，范围仅覆盖所列 7 个 Phase 5 / smoke 文件，不代表全仓库复审。未改代码、未运行测试或构建。
* 当前 x64 包的 63 项 synthetic smoke 通过记录继续有效；真实供应商用户链路、干净 Windows 11 覆盖升级与数据保留、远端 GitHub Actions / Release、签名身份及证书链仍待外部验收。未提交、推送、签名、创建 tag 或发布；V1.0 保持 `needs-verification`。

**V1.0 Phase 5 更新清单门禁与 smoke 缓存隔离（2026-10-02；未发布）**：

* `desktop/scripts/verify-release.mjs` 新增 `--prepared-update-assets` 模式：校验合并后的 `latest.yml` 同时引用 x86_64 / aarch64 安装包和旧客户端 `x64` / `arm64` 查询别名，默认路径指向 x86_64，并核对 `latest-win-x86_64.yml` 与 `latest-win-aarch64.yml` 的版本、文件路径、SHA-512 和大小。
* `.github/workflows/package.yml` 在 `prepare-windows-update.mjs` 后、上传 Release 资产前调用该模式。Claude Code 窄范围静态复审 job `j-ivjtur` 对照实际清单生成器与 workflow，结论为没有确认的 blocker；不代表真实 GitHub Actions 或 Release 已运行。
* `git diff --check`、`node --check desktop/scripts/verify-release.mjs`、`pnpm exec eslint scripts/verify-release.mjs` 和 `pnpm verify:release` 均通过；本机包模式输出 `ALL CHECKS PASSED`。本机没有 aarch64 资产或 `latest-win-*` 清单，因此双架构 `--prepared-update-assets` 模式未执行；workflow 也未在 GitHub Actions 运行。本机未找到可用的 actionlint / YAML lint 工具。
* smoke 清理复审发现首次启动会继承用户级共享 pip / uv 缓存，而重启才重定向到本次 workspace。现已在 `desktop/scripts/packaged-smoke.mjs` 为首启与重启共用 `<openfix-smoke-临时目录>/package-cache`，进程退出后的清理范围和 `--keep` 行为未改动。`node --check`、目标 ESLint 与目标 `git diff --check` 通过；按用户要求未重跑 smoke。
* Claude Code job `j-3ec9i7` 确认 harness 只清理自身 `mkdtemp` workspace，进程未确认退出时保留目录；本次复核的 Windows Temp 下没有 `openfix-smoke-*`，之前清理的 5 个任务专用 UV 缓存仍不存在。本轮没有删除共享用户缓存、安装包、审计日志或数据库。
* 本机用户级 pip cache 只读测量约 699 MB；它是跨项目共享目录，无法归因到 OpenFix smoke，因此未执行全局 purge。smoke 进程的运行时目录位于隔离安装目录，未来下载缓存也已定向到本次 workspace；没有发现属于 OpenFix 的遗留 smoke workspace。
* 当前 x64 包 `j-fpiwyo` 的 63 项合成 smoke 证据继续有效；本次只改发布清单门禁与 smoke harness 缓存环境，未重打包或重跑 smoke。真实供应商用户链路、干净 Windows 11 旧版覆盖升级与数据保留、远端 GitHub Actions / Release、Windows 签名身份及证书链仍未验收。没有提交、推送、签名、创建 tag 或发布；V1.0 保持 `needs-verification`。

**V1.0 续作状态核对（2026-10-02；只更新记录）**：

* 用户说明 Claude Code 通过第三方 API 接入，不要求网页登录；此前记录的登录困难不再是当前 blocker。三项只读 Claude Code 审计 j-j8to3s、j-g2iu09、j-883m9x 均已完成：PRD §20 原文与 AI 分析功能已在当前代码实现；Story Memory 确认隐藏笔记泄漏；Phase 5 确认 package 自动发布保护及 CI 完整 verifier 覆盖缺口。
* 独立审计曾报告一致性问题卡缺少“查看原文”和“AI 分析”，但当前未提交工作树中两项操作均已实现：前端展示服务端返回的正文来源片段，并通过 consistency analyze API 复核问题；后端测试源码覆盖来源定位与分析请求。该审计缺口结论已用当前文件读回修正。
* smoke 首启缓存环境隔离已写入脚本并通过两份静态复核；63 项通过的 j-fpiwyo 回放早于这次脚本级环境注入，不能作为新修订运行证据。根据用户要求，本轮没有重跑 smoke。
* 当前可继续验证的本机代码 / 静态路径之外，正式 V1.0 仍缺真实供应商用户链路、干净 Windows 11 旧版覆盖升级与数据保留、远端 GitHub Actions / 双架构 Release、Windows 签名身份与证书链。V1.0 仍为 needs-verification；没有提交、推送、签名、创建 tag 或发布。

**Phase 5 发布门禁审阅补强（2026-10-02；本机修改，未发布）**：

* Claude Code 只读审计 j-883m9x 确认两项发布接线缺口：tagged Windows x64 package job 没有执行完整 package verifier；本地 package script 没有限制 electron-builder 的发布行为。
* 已为桌面 package script 增加 --publish never，避免常规打包命令在 tagged checkout 上自行发布；Release workflow 在 Windows x64 包完成架构命名后、上传工件前运行完整 pnpm verify:release。已有合并双架构更新清单的 --prepared-update-assets 检查仍在 gh release upload 前运行。
* 本机 x64 包的完整发布静态校验输出 ALL CHECKS PASSED；目标文件 git diff --check 通过。未运行测试、构建、smoke 或远端 Actions。
* 独立审阅还确认当前未签名包缺少 publisherName 时会跳过 Authenticode publisher 校验；签名身份与证书链必须在外部签名验收时补齐，当前未签名产品仍不能视为正式发布。
* 本地 V1 需求复审 job j-j8to3s 已确认一致性“查看原文”和“AI 分析”已有完整接线与 API 测试。Story Memory 隐藏 / 新鲜度审计 j-g2iu09 与 Phase 5 spec review j-v4r5bc 均已完成；隐藏笔记问题及 Phase 5 修改的复核证据见下节。V1.0 仍为 needs-verification。

**V1.0 Story Memory 隐藏笔记可见性修复与本机回归（2026-10-02；未发布）**：

* Claude Code 审计 j-g2iu09 确认：隐藏笔记此前会进入 Story Memory 索引和状态计数；隐藏切换不改变未过滤的索引指纹，Agent 搜索与一致性上下文可能继续使用旧正文。
* 修复仅落在 Story Memory 既有所有者：文档构建和笔记计数显式排除隐藏笔记；搜索结果 hydration 即时拒绝隐藏笔记，即使索引被报告为 fresh；一致性检查复用同一 freshness 指纹，在检索前后发现隐藏状态变化时丢弃旧上下文。
* 新增两条回归测试：`test_hidden_note_excluded_from_story_memory_and_invalidates_fingerprint` 与 `test_search_story_memory_drops_currently_hidden_note`。定向 pytest job `j-5tua8z` 退出 0，**33 passed**，包含隐藏状态后的计数、stale 指纹与输出泄漏哨兵。
* 另行运行一致性索引过期保护用例 `tests/api/test_consistency.py::test_story_memory_context_drops_results_when_index_goes_stale`，**1 passed**；检索期间 freshness 变 stale 时一致性上下文不会带出旧结果。
* `uv run ruff check` 四个目标文件、`uv run ty check app`、跟踪文件 `git diff --check` 均通过。Claude Code 规格复核 `j-7j40k6` 与代码质量复核 `j-6w3k25` 均 PASS；Phase 5 规格复核 `j-v4r5bc` 与代码质量复核 `j-1equ2e` 均 PASS。
* 本轮没有重跑 packaged smoke。合成 x64 smoke 证据仍为既有 job `j-fpiwyo`，不能证明本次后端源代码变更已打入新安装包。真实供应商链路、干净 Windows 11 旧版覆盖升级与数据保留、真实 GitHub Actions / 双架构 Release、Windows 签名身份及证书链仍未验收。
* V1.0 正式状态仍为 `needs-verification`。没有提交、推送、创建 tag、签名或发布。

**V1.0 续作：当前源码门禁与 x64 本机包（2026-10-02；未发布，未重跑 smoke）**：

* 后端 `uv run ruff check . && uv run ty check app && uv run pytest -q` 通过，完整套件 **1884 passed**（FastCtx job `j-ygbcaf`）。
* 前端 `pnpm lint && pnpm type-check && pnpm build` 通过：429 个文件零 lint / 类型错误，production build 成功；桌面 `pnpm lint && pnpm type-check` 与 `pnpm build` 也通过（jobs `j-hgt5fn`、`j-ex6kxv`、`j-g2uxy0`）。前端和桌面打包仍报告大 chunk 警告。
* 当前工作树重新生成 Windows x64 安装包与 ZIP：EXE 158,042,781 bytes，SHA-256 `01294e379ea45c995575e83d9e87d4d89632e2784d83ad2a6994bad1dc3925df`；ZIP 188,478,015 bytes，SHA-256 `ff9a8570fdfb2369943ccdebebda9010cdb4aa257f7944b62ba29e6bce036b08`。`pnpm verify:release` 在新包上输出 `ALL CHECKS PASSED`（job `j-vrh34h`）。
* 第一次打包在共享 uv cache 的临时文件限额处停止，未进入 Electron Builder；改用本次专用 `UV_CACHE_DIR` 后打包成功。专用缓存仅 2.1 MB，任务结束后已删除；没有清理共享 uv / pip cache。Windows Temp 下无 `openfix-smoke-*` 目录，此前清理的 smoke 专用缓存仍不存在。
* 历史 `j-fpiwyo` 的 63 项 PASS 属于旧 EXE 与旧 harness；当前源代码包未重新运行 packaged smoke，按用户此前要求不重跑。因此该新安装包只有构建和 x64 静态 release verifier 证据，没有运行时 smoke 证据。构建日志有通用 signtool 阶段，但当前没有签名身份和证书链验证，本记录不将包描述为已签名。
* 本地源码和包静态门禁通过，但正式 V1.0 仍为 `needs-verification`：真实供应商用户链路、干净 Windows 11 旧版覆盖升级及数据保留、远端 GitHub Actions 与双架构 Release、Windows 签名身份及证书链仍需实际验收。没有提交、推送、创建 tag、签名或发布。

**V1.0 Phase 5 Release 版本护栏（2026-10-03；未发布）**：

* Release 工作流现在把 tag 派生版本传给桌面打包校验和双架构清单校验，并与 `desktop/package.json` 版本比对；版本缺失时 GitHub Actions 会失败，避免将旧版本安装包写入新版本 Release。版本清单校验和内置后端 wheel 校验继续绑定到同一桌面版本。
* 桌面包校验位于安装包上传前，双架构清单校验位于更新资产上传前。本地未设置 tag 版本环境变量时，原有 `pnpm verify:release` 行为不变。
* Claude Code 规格与质量复审通过；`node --check`、目标 `git diff --check` 和本机 x64 `pnpm verify:release` 均通过。未执行测试、构建、smoke、双架构正向门禁、GitHub Actions、tag 或 Release。
* 当前 x64 包仍未运行 smoke；真实供应商、干净 Windows 11 覆盖升级及数据保留、远端双架构 Release、签名身份与证书链仍未验收，V1.0 保持 `needs-verification`。

**V1.0 本地开发里程碑提交检查（2026-10-03）**：

* 用户最新指令明确授权本地提交。提交范围为 OpenFix 仓库内既有 V1.0 创作工作流、人物 / 世界设定 / 项目与章节扩展、Story Memory、AI 候选与上下文保护、一致性检查、回滚保护、PNG 品牌资源及 Phase 5 发布护栏；继续保留外层 ai-novel 仓库和 OpenFic 上游的原状。
* 本次全量后端检查发现迁移链测试仍期待 `1027`，而跨卷章节回滚修复已经新增 `1028`。测试现明确校验 `1028 → 1027 → 1026` 及唯一迁移头；目标测试 3 passed，Ruff / ty 通过，重新运行完整套件 **1889 passed**（FastCtx job `j-taig3r`）。
* 前端 `pnpm lint && pnpm type-check` 通过，429 个文件零警告 / 错误（job `j-v44ehv`）。桌面 `pnpm lint && pnpm type-check && pnpm build` 通过（job `j-9za1x2` 的单测前各阶段）；该 build 同时完成前端 production build、setup renderer 和 main TypeScript 编译，保留既有大 chunk warning。
* 桌面 archive / data-manager 测试以 Windows 自带 tar 复跑 **12 passed**，覆盖真实备份 / 恢复、运行时备份排除、迁移与路径边界。Git Bash PATH 中的 tar 不接受这些原生 Windows 路径；相对符号链接用例在本机遭遇 EPERM，因缺少创建符号链接权限而单独排除，不能算该用例通过。
* `pnpm verify:release` 在已有 x64 产物上输出 **ALL CHECKS PASSED**；本次没有重新打包或运行 packaged smoke，静态校验不证明这些最新源码修订已经进入安装包。`git -c core.whitespace=cr-at-eol diff --check` 通过，保留既有混合行尾，不进行整文件格式化。提交候选路径和常见凭据模式检查未发现 API 密钥、数据库、安装包或临时缓存。
* 当前源码仍需继续处理的审阅边界：项目属性查询失败后仍可能以空 genre / target 写入；项目页及 onboarding 的空白创建在 profile PUT 在途时可能重复提交；人物 / 世界书的项目深链可能被异步初始化覆盖，且前 100 项以外的有效项目会被忽略；portable Python 尚未支持发布矩阵中的 Windows / Linux ARM64；非 Windows 发布任务仍需保证带入 fork backend wheel；恢复不含 runtime 的备份时须保留现有运行时。这些属于仓库内剩余工作，本地提交不会把它们自动关闭。
* 前端只读复核已由协调者核对相关源码，确认上述属性失败保护、重复创建窗口及深链选择问题；当前未从源码证实角色资料串写或建议页必然卡死，未执行对应运行时验收。
* 正式 V1.0 仍为 `needs-verification`：真实供应商用户链路、干净 Windows 11 旧版覆盖升级与原数据保留、真实双架构 GitHub Actions / Release、Windows 签名身份与证书链，以及当前安装包运行证据仍待完成。后续继续按 §42 与 Phase 5 计划推进，本次提交保存当前开发进度。

**V1.0 表单、人物/世界书深链、备份恢复与打包接线（2026-10-03；本地提交）**：

* 已关闭上一节列出的本轮源码缺口：项目属性读取失败时禁止空值属性写入；项目页/onboarding 共用完整 async submit 保护；表单会话互相隔离，成功 PUT 的权威 profile 先更新缓存，避免立即重开覆盖新属性。
* 人物/世界书统一用共享项目选择 hook，列表外 URL 经既有 API 校验；导航、迟到偏好/接口、manual ABA、后台刷新与同 id 选择均有保护。已验证的离页项目 metadata 在 URL 参数消失/无效时继续提供名称；页面卸载返回后按当前 id 的 query 恢复名称，不重新设置项目或清空角色/条目。
* 桌面 backup/restore/cleanup/rollback 共用显式配置 runtime 的顶层平台匹配策略，普通用户数据仍递归检查 symlink；真实 IPC 策略拒绝 runtime 指向数据根内其他子树和不支持的重叠。Windows 大小写变体的 runtime 与用户目录均有回归，迁移/portable extraction 默认行为保留。
* 保留两个打包 workflow 的六个 native target，增加 pinned CPython 3.13.14 / 20260623 的 Windows/Linux ARM64 映射，并在所有 target 的 Electron Builder 前 staging fork wheel。安装脚本修复 NSIS 最后 /D、verbatim/hidden 参数以及启动/非零退出检查；本轮只做静态检查。
* 本地源码提交：`359c811`（restore runtime）、`ebae8a3`（distribution/installer）、`49935a4`（forms/deep links）。协调者逐组核实 root、branch、显式暂存文件清单和 CRLF-aware cached diff；提交只属于 `新版本/OpenFix`。
* 最终验证 job `j-9g2cte` 退出 0：前端 432 文件 lint/type-check 零警告/错误，完整 desktop build 成功（含前端 production、setup renderer、main）；**36 个合成浏览器回归 passed**（28 深链、8 表单）。保留既有大 chunk warning。job `j-mnfh77` 的 desktop lint/type-check/build:main、目标测试 **24 passed / 1 POSIX-only skipped**、YAML/六平台矩阵/顺序/guard、六个 resolver 映射与 unsupported target、harness syntax 均通过；另一个需 Windows symlink 权限的用例被显式排除。
* 表单与深链独立质量复核通过；restore Claude 最终复核 `j-2cj918` PASS，distribution Claude 质量审查 `j-c8kd1y` PASS。深链质量审查发现的导航/重挂载 metadata 问题已修复并回归。重挂载用例直接覆盖暖缓存返回，冷缓存/挂起响应隔离仅有当前 query key/id guard 的源码支持。
* 仅停止本轮 Vite `j-bckuz9` 并删除已核实无 reparse point 的 `tmp/openfix-ui-boundaries-results`（45 bytes）；19003 无监听，证据日志/审阅材料保留。本轮没有新建工作树或 smoke 环境。
* 后续仓库工作：大纲与故事记忆页在 URL 变 null 时不重置 applied ref，仍需修复 `A → null → A` 重入；本轮仅只读核实。其列表外项目展示继续核实，不能从本次人物/世界书结果推断所有消费者通过。
* 正式 V1.0 保持 **`needs-verification`**。真实供应商、干净 Windows 11 旧版覆盖升级/原数据保留、native ARM64 binary dependencies/首启、远端双架构 Actions/Release、签名身份/证书链及最新安装包运行证据仍待验收；这次源码 build 不代表最新安装包已完成运行验证。

**V1.0 大纲/故事记忆项目选择收尾（2026-10-03；用户授权本地提交）**：

* 两页沿用人物/世界书已有的共享项目选择 hook，退役 raw URL/stored-id 初始化和竞争的 URL/recent fallback effects。`A → null → A`、`A → invalid → A` 重新应用 URL；第一页外的 URL、记住项目与最近项目经 API 校验并显示标题，无效候选回退。
* 页面以稳定 callback 和即时 ref 提供当前项目；迟到读取、metadata、manual ABA 与列表 refetch 不夺取手动选择。大纲只有真实项目变化才清空选中/dirty/expanded；同 id 与 URL 再应用保留草稿/展开。经验证的选择写入原 localStorage key，使 SPA 离页返回可恢复离页项目。
* 协调者补查出初轮质量报告漏掉的候选失败续跑：remembered 项目校验挂起时手动选择 BETA，reject 后旧 loop 仍能写回 ALPHA。共享 catch 已补 manual/current guard；actual hook seam 从错误的 BETA → ALPHA 变为仅 BETA，两页新增 pending/404/retry 用例分别覆盖 next-listed 和 final-first-page 回退。
* 最终 `j-7q3b9d` 退出 0：前端 lint/type-check **433 文件零警告/错误**，完整 desktop build 含前端 production/setup/main，**61 browser passed（3.4m）**，即 25 selection、28 原 deep-link、8 forms。既有 large-chunk warning 保留；没有重跑后端或安装包，这些前端源码结果不证明真实 provider/打包运行链路。
* 独立 fresh SPEC 和 Claude QUALITY `j-klhqxv` 均 PASS；初轮 `j-or8f99` 的全分支 guard 声明被反例纠正，不能以报告 PASS 代替实际源码/执行。现有 retry/60s metadata cache 保留，删除缓存项目与 hung IndexedDB 仍属未复现的有界风险；新 spec 980 行以 typed helper/两页参数化控制，继续扩增前另切 fixture 复用。
* 仅停止两个本轮 Vite，端口 19003 最终释放；精确结果目录核实在 workspace 内且无 reparse point后两次清理（各45 bytes），保留日志/审阅材料，继续使用唯一工作树。提交事实由 Git HEAD/message/files/status 读回，本记录不自引用本次提交 SHA。
* 下一批源码问题已独立核实：DOCX 首卷/首章前普通段落丢失，未过期 TXT 导出被误清、过期 DOCX 漏清。另有 Consistency/AI 选择及条件性手动覆盖升级的源码缺口待分任务验证。完整 V1.0 仍为 **`needs-verification`**，不能据这次提交宣称正式验收完成。

