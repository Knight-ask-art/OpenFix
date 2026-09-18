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

第一阶段的验收标准见 [docs/03](../docs/03-source-change-list.md) 第 37 节：能在干净的 Windows 11 上安装并启动安装包，什么业务功能都不改。

