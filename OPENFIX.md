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

用户可见品牌已改为 OpenFix（`appId: com.openfix.app`）。桌面版本号仍为 `0.11.1`，因为 Runtime 仍会 `pip install openfic==${app.getVersion()}`。自动更新已断开官方 OpenFic Release，待自有 GitHub 仓库后再接入。

**[docs/04](../docs/04-fork-and-packaging-roadmap.md) Phase 1（Fork + 本机跑通）已结束。** 开发模式可启动。自有仓库 `origin` 已接入：`https://github.com/Knight-ask-art/OpenFix`（2026-09-23 由 OpenFic 改名而来），分支均已推送。

**TASK-002（Sidebar / Navigation）已完成**（分支 `feature/navigation`）：一级导航改为首页 / 写作 / 大纲 / 人物 / 世界；Prompt Chains 与 Dashboard 从一级导航隐藏，路由 `/prompt-chains`、`/dashboard` 保留可用；`/outline` 为占位页（`frontend/src/features/outline/`）。已通过 lint / type-check / build 及浏览器冒烟。

下一刀：V0.1 安装包验收（[docs/03](../docs/03-source-change-list.md) 第 37 节），随后 TASK-003（Home）。

**V0.1 安装包已产出并通过本机冒烟**（2026-09-23，分支 `feature/navigation`）：

* 产物：`desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe`（约 120 MB）与同名 `.zip`。
* 打包修复：`electron-builder.yml` 显式将 `publish` 指向禁用端点，避免 electron-builder 从上游 repository 字段推断出 OpenFic 官方 GitHub 更新源。
* 本机验证：静默安装成功、首次启动窗口正常加载实例配置页、开发模式主流程已通过浏览器冒烟。
* 待人工验收：在干净的 Windows 11 虚拟机 / 电脑上安装，走完「实例配置 → 首次联网创建后端运行环境 → 模型配置 → 写作 → 重启数据保留」全链路。
* 已知限制：版本号保持 `0.11.1`（Runtime 依赖 `pip install openfic==${app.getVersion()}`，与 [docs/03](../docs/03-source-change-list.md) 第 37 节的 0.1.0 命名不符，Phase 3 后端 Fork 时解耦）；自动更新尚未接入自有仓库。

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

下一刀按 Ticket 顺序：TASK-012（Consistency Checker）、TASK-013（Onboarding）。

