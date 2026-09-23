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

**[docs/04](../docs/04-fork-and-packaging-roadmap.md) Phase 1（Fork + 本机跑通）已结束。** 开发模式可启动；本地库中已有手工冒烟项目（标题「测试」，1 个章节）。未打安装包，未接自有 GitHub `origin`。

**TASK-002（Sidebar / Navigation）已完成**（分支 `feature/navigation`）：一级导航改为首页 / 写作 / 大纲 / 人物 / 世界；Prompt Chains 与 Dashboard 从一级导航隐藏，路由 `/prompt-chains`、`/dashboard` 保留可用；`/outline` 为占位页（`frontend/src/features/outline/`）。已通过 lint / type-check / build 及浏览器冒烟。

下一刀：V0.1 安装包验收（[docs/03](../docs/03-source-change-list.md) 第 37 节），随后 TASK-003（Home）。

**V0.1 安装包已产出并通过本机冒烟**（2026-09-23，分支 `feature/navigation`）：

* 产物：`desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe`（约 120 MB）与同名 `.zip`。
* 打包修复：`electron-builder.yml` 显式将 `publish` 指向禁用端点，避免 electron-builder 从上游 repository 字段推断出 OpenFic 官方 GitHub 更新源。
* 本机验证：静默安装成功、首次启动窗口正常加载实例配置页、开发模式主流程已通过浏览器冒烟。
* 待人工验收：在干净的 Windows 11 虚拟机 / 电脑上安装，走完「实例配置 → 首次联网创建后端运行环境 → 模型配置 → 写作 → 重启数据保留」全链路。
* 已知限制：版本号保持 `0.11.1`（Runtime 依赖 `pip install openfic==${app.getVersion()}`，与 [docs/03](../docs/03-source-change-list.md) 第 37 节的 0.1.0 命名不符，Phase 3 后端 Fork 时解耦）；自动更新尚未接入自有仓库。

