# OpenFix 0.12.5 验证记录

日期：2026-10-23。工程：`新版本/OpenFix` Python/FastAPI Fork。
本次从 `dec883f036eaf638dc75ed0c62d7ff2fb99dee13` 开始，使用合成测试与隔离数据目录。
没有访问或修改用户小说、已发布章节、E 盘素材或现有安装数据。

## 实施与审查

- `57670e1`：章级人物状态与原始作者要求交接；root 最终补齐空锚点拒绝和类型收敛。
- `ffd7eae`：primary 迭代预算、审批恢复和模型/文风观测；子 Agent 模型记录 ID 同步。
- `8de384f`：章节哈希/字面约束、预览与执行共同验证、有限无进展退出、质量 Skill 合同。
- 实际使用 Claude Code CLI 2.1.306；init 配置标签是 `claude-opus-5`，响应消息的
  `assistant.message.model` 是 `deepseek-v4.1-flash`。只能证明调用了真实 Claude Code 客户端，
  不能把配置标签当成 Anthropic 模型实施或独立通过的证据。Codex 独立读 diff、复跑并修复验收发现。

## 已执行检查

以下后端命令均在 `backend` 执行，并设置独立 `OPENFIC_DATA_DIR`。

| 检查 | 真实结果 |
| --- | --- |
| `python -m pytest -q` | 首次 2 failed / 2764 passed；修复后 2843 passed，474.94s；最终源码冻结后再次 2843 passed，441.82s |
| LF01/02 工具、核心状态目标套件 | root 146 passed，6.28s |
| LF03 图/Runner/API 目标套件 | root 135 passed，40.25s；包含两次审批、重建图后恢复且 cap=2 仍仅两次模型调用 |
| LF04/05/07 工具、循环、Prompt、Skill 套件 | root 174 passed，12.45s |
| LF06 与 LF03 相关回归 | 284 passed，57.23s；最后子 Agent record ID 修复另测 5 passed，26 deselected |
| `ruff check app tests` | 通过 |
| `ty check app` | 通过；不把这说成全部测试源码类型检查通过 |
| 前端 `lint`、`type-check`、`build` | 通过；保留现有大 chunk 构建警告 |
| 桌面端 `lint`、`type-check`、`build:setup`、`build:main` | 通过 |
| 实际 TS sanitizer 的 Node 断言 | 9 项通过；没有把它说成浏览器 E2E |
| wheel 内容比对 | 673 个源码/规则文件与工作区逐字节一致；未包含数据库、`.key`、`.env` |
| wheel 隔离启动 | 使用发行 CLI 相同的 Windows Selector loop factory；健康接口与包内前端均 200，版本 0.12.5，正常退出 |

实现期间的 CLI turn 上限退出、拒绝和失败测试保留在本地忽略目录，未当作成功证据。
完整日志在 `backend/.venv/release-0.12.5-20261023/`，不进入 Git。

## 包与运行验证

Windows x64/ARM64 的安装包、blockmap、便携 ZIP 及三份更新清单均已生成，共九项发布资产。
完整包体验证与 `--prepared-update-assets` 校验通过，包含版本、更新源、两架构清单的
SHA-512/size、wheel 版本与前端功能资产。首轮校验误选同目录 0.12.4 旧包，已将校验器
收紧为当前版本精确文件名，再次通过；旧包保留。
打包后的 x64 `OpenFix.exe` 以 Electron Node 模式读取 `app.asar/package.json`，版本为
0.12.5，Electron 43.4.0。两个安装包 Authenticode 实测均为 `NotSigned`。
这些是本地构建证据；公共 Release/更新发现核对另行记录，不能混称已安装升级成功。
后端 wheel 已从最终源码生成；为避免 GitHub 大文件下载反复停滞，使用本机同版本 Electron
43.4.0 缓存，核对 ZIP CRC、版本、x64/ARM64 PE 架构，并与 Electron 官方 Release
`SHASUMS256.txt` 的两项 SHA-256 一致。未声称 OpenFix 产物已取得可信发布者签名。

首次 TestClient 冒烟未使用 Windows 发行 CLI 的 Selector loop，退出时遇到 pyzmq/Proactor
不兼容；校正测试 harness、复用实际 CLI loop factory 后通过，没有为通过冒烟修改产品事件循环。

## 兼容性与保留边界

- 不新增数据库迁移；隔离的新库仍执行已有迁移。本次没有对用户现有数据库作升级演练。
- `read_character(name)` 保持默认输出；历史状态显式指定卷章。静态 profile 不是历史快照。
- 字段超预算整项省略，固定来源信息仍放不下时明确失败；不是悄悄截断事实。
- `max_iterations` 是每个真实用户轮的 primary 调用预算，合法末轮工具仍可审批完成。
  子 Agent 预算独立，不代表限制整棵任务树的费用与 Token。
- 作者交接来源哈希证明传输；`source_consumption=unverified`，不冒称世界/人物工具已读取。
- 哈希与字面保留仅能验证文本版本及字面约束；不能证明世界事实、情感或声线语义正确。
  所有高风险写入继续沿既有审批、Diff 与 Revision，不建立第二套候选或 RAG。
- 自定义数据库 Agent/Prompt 配置保留；用户覆写不会被新版内置 YAML 静默覆盖。

## 未完成与后续

1. 尚无同模型、同素材的真实长篇质量 A/B benchmark，不宣称节省比例或质量提升百分比。
2. 三文风和相邻章 fixture 验证规则/loader/按需 reference，不证明模型必然写出优质正文。
3. 未做真实 provider、用户安装态完整 UI E2E，也未运行依赖私人大项目的浏览器测试。
4. stale 检索来源完整展示、父子共享预算、永久作者约束压缩保留、全部语义约束结构化仍待后续。
5. 章节基线哈希是显式可选 guard；并未给所有写入口建立原子 CAS，不能宣称全局并发编辑保护。
6. Aegis 结构检查在开始时已有两个旧 work Markdown 未索引；这是已有过程文档问题，不冒称软件测试失败。
