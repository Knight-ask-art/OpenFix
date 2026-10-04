# 作者文风档案与真实模型实测

## 基线与交付范围

当前本地 `edcd674f28054133e88e8f11ba4b7ffcac33feb2` / `feature/branding` 是本轮实现基线。沿用此前已提交的 Token 优化和小说自然度增强；不从 GitHub 旧代码重新设计。

用户已授权配置本地 OpenAI-compatible 网关、分析本人样本并采用项目文风、使用指定的两种模型测试，以及完成后提交并推送自己的 OpenFix 仓库。Claude Code CLI 完成限定范围的审查和补丁，协调者独立复核和运行门禁；没有使用 Codex 子代理或新增工作树。

本轮完成的运行数据属于用户本地应用，源码仓库只保存修复、测试和匿名指标。密钥由原有凭据加密服务保存；小说原文、模型正文、数据库与凭据不提交。

## 用户可使用的结果

- 本地项目：`http://127.0.0.1:9000/projects/074wNSbtRentFFFV6CV58`。
- 默认主模型：`cline-pass/deepseek-v4.1-flash`。
- 轻模型：`cline-pass/mimo-v2.6-flash`；摘要设置沿用 `__system_light_model__`。
- 两模型保留 temperature 0.6、最大输出 6144。配置的 128000 context 是应用 fallback，未取得供应商确认的真实上限；价格 metadata 缺失，费用未知。
- “项目文风档案”已确认采用；“当前场景与人物声线卡”保存场景事实与角色边界。
- 两份“文风分析候选”和两份“实战候选”均保存在项目笔记中。原章没有被候选覆盖。

### 样本范围

用户提供的《不想变强的我开始摸鱼》链接中，实际取得第一至第四章文字，来自 `_1`、`_2`、`_3`、`_5`。四章应用统计共 5297 字。

`_4` 是人物图片页，只有少量文字，不当作完整文风样本；`_6` 返回目录，也不计为第六章。广告和导航已排除，原文口语、系统面板、动漫梗、作者 PS 保留，不猜图片人物或修改原文章句。

导入后、候选保存后均读回四章，与导入文本逐字符串一致。后端重启前后另比较正文 SHA-256 和字数，结果见运行读回证据。

## 项目 Style Profile

复用 Notes 的唯一可见根笔记、JSON v1、`status: confirmed`。两模型的分析经过人工复核，剔除把作者 PS、直白对白本身视为错误的机械结论。

保留作者的轻松吐槽、系统互怼、短口语、场景适用的动漫/网文梗、低微动作密度，以及有功能的设定列表与插话。声线卡保留主要人物、当前地点和首次武术训练事实，系统脑内信息不向其他人物泄漏；证据不足的角色声线不编造。

编译短卡为 **388 estimated tokens**，实际请求包装后 `style_profile` 分类为 **447 estimated tokens**，在 800 上限内。真实 audit 证明 Writer、Reviewer、Actor、Build 均取得短卡，不需要每轮重新加载原始文风样本。

## 测试方法与真实用量

先用 Build → Composer 分析同四章，再通过既有 Build → Writer → Reviewer → Actor → Final Review 生成首次训练场景。草稿、模型修订和人工复核版分别保留，全部是候选笔记。

以下只统计 `category=agent` 的审计记录，不含会话标题生成。`Agent calls` 是应用逻辑调用数，不能当作网关全部 HTTP 尝试数；SDK 重试等没有独立请求计数。

| 场景 | 模型 | Agent calls | Tool calls | Tool failures | Input | Cached input | Uncached input | Output | Reasoning |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 文风分析 | MiMo | 7 | 10 | 2 | 91909 | 67584 | 24325 | 8055 | 5244 |
| 文风分析 | DeepSeek | 6 | 11 | 0 | 80672 | 48768 | 31904 | 5421 | 2391 |
| 写作审稿链 | MiMo | 23 | 17 | 4 | 264754 | 219648 | 45106 | 31824 | 22115 |
| 写作审稿链 | DeepSeek | 21 | 13 | 1 | 273345 | 247808 | 25537 | 22851 | 13580 |

Reasoning 是记录在 Output 中的子项，不能再加一次当作总 Output。写作链加权 cache hit rate：MiMo **82.96%**，DeepSeek **90.66%**；文风分析分别为 **73.53%**、**60.45%**。

累计 audit latency：文风 MiMo 96244 ms、DeepSeek 54993 ms；写作链 MiMo 488858 ms、DeepSeek 557893 ms。父 Agent latency 包含等待工具/子 Agent，可能与子调用重叠；审批也影响墙钟时间。因此这些数字不能作为纯推理耗时或干净的端到端速度排名。

完整匿名机器可读数据见 [模型实测指标](2026-10-04-author-model-benchmark.json)。单价没有提供，不能根据本地默认零单价声称免费或计算可靠费用；失败记录的零 Token 也不证明供应商没有收费。

### 运行失败与恢复

- MiMo 文风分析两次以英文 slug 调用 Skill，manifest 实际使用中文名；改成正确名称后恢复。这是调用参数问题，不作为新 loader 缺陷。
- MiMo 的 Actor 两次输出 6144，reasoning 也为 6144，没有可用正文；子运行报错，第三次成功。LLM transport audit 的 success 不代表正文成功，本报告保留这两次 Token 成本。
- DeepSeek Writer 两次 `InternalServerError`，第三次成功。错误记录没有用量，不能将其当作零费用请求。
- 已完成会话没有待审批操作。标题生成曾出现工具标记字符串，本轮新建四个任务已人工命名为明确的文风/写作实测标题。

## 质量复核与适用范围

- MiMo：初稿 542 汉字，模型局部修订后 517；主要删除重复解释和重复互怼。
- DeepSeek：初稿 534 汉字，模型修订后 520；主要修 POV 和重复打量。
- 独立复核发现 DeepSeek 虚构了前一天的同一句拒绝话，模型 Reviewer 未发现。人工仅从候选复核版删去该两句后为 **499 汉字**，比内部 500 汉字测试下限少 1 字；不人为填句凑数，也不将该版冒充未经人工修改的模型成果。原始稿和模型回执仍保留。
- 姓名、606 教室、首次训练、无新增升级等粗检查通过，原章逐字未改。这不证明全部叙事细节正确。
- 本轮不是盲评，不是旧/新 Prompt 的受控对照；四章短样本不能代表 50+ 章长篇、长期人物认知边界或全书质量回归。不能声称质量一定提高或给出优化前后真实调用降幅。

## 实测触发的代码修复

| 文件 | 本轮修改 |
| --- | --- |
| `backend/app/agent_runtime/runner/subagent_runner.py` | 最终正文只能取当前 HumanMessage 之后最新的最终 AIMessage；空回复、reasoning-only、工具前言不能回退到旧正文。合法 text blocks 通过公共 accessor 读取。 |
| `backend/tests/agent_runtime/runner/test_subagent_runner.py` | 新增 10 个测试函数，覆盖当前回合边界、最新空结果、字符串/text blocks、reasoning/tool-only、tool-call 前言，以及 SQLite request/driver/status/event 接缝。 |
| `docs/aegis/plans/2026-10-04-real-author-model-validation.md` | 本轮范围、修复 owner、兼容和验证边界。 |
| 本报告与 benchmark JSON | 匿名运行数据、实际失败、人工复核和验收限制。 |
| 唯一 V1 work record | 更新当前切片和读回证据，保留历史切片。 |

旧 helper 向前遍历整个历史寻找非空字符串，后续回合空输出时可能返回上轮答案。替换该判定路径，错误状态、API、持久化、审批和 Provider 重试保持现有 owner。没有新增 fallback、数据库迁移、依赖或通用 Context Manager。

Claude Code 只读审查 `j-4nu897`、限定两文件实现 `j-evrch2` 均退出 0；协调者补齐 tool-call 前言边界并独立检查 diff。格式化曾触及原文件排版，收尾已恢复无关排版，并核对 AST 一致，避免整文件格式差异。

## 验证与当前包

- 完整后端：`uv run --no-sync pytest -q`，**2149 passed / 1809.97 秒 / 退出 0**（`j-zt1gb0`）。
- 当前补丁和调用接缝：runner、dispatch/list/recycle、Agent API、LLM invoke，**149 passed / 124.20 秒 / 退出 0**；同一 `j-qxtekx` 中全 app/tests Ruff 和 app ty 均通过。
- 自然度、Style Profile、全部 Context、Skill tools、Agent/Skill API 相关回归：**250 passed / 56.86 秒 / 退出 0**（`j-sl5fg2`）。
- 前端 452 文件 lint/typecheck 均零警告/错误，desktop lint/typecheck 与完整 build 通过（`j-ktgqjy` 的这些前置命令）；保留原有大 chunk 构建警告。
- `j-ktgqjy` 随后在共享 UV 构建缓存失败，不能把该 job 的退出 1 当作打包通过。改用本轮专用缓存后，`j-evby66` 完成 wheel/Windows package；其末尾规范化命令工作目录错误，退出 1。明确指定 `desktop/dist-electron` 后，`j-l1g1di` 的规范化、**26 项发布静态检查**和三个独立内容核验全部通过、退出 0。没有以失败尝试替换终态证据。
- 当前安装包绑定基线 `edcd674f` 加本轮未提交的 runner 补丁。打包时 Git HEAD 仍为基线，不能把 `packageSourceHead` 字段当作“补丁未包含”；已逐字节比较 **644** 个后端源码文件与 wheel、**733** 个前端文件与 resources、**56** 个 desktop dist 文件与 app.asar；ZIP 的 frontend/asar/wheel/update 配置一致。
- 包含补丁的 runner 文件 SHA-256：`c305be1dddaca8c5aa5eb1509de6e2437819021bb85363165183bc5336485958`。
- 没有重复 packaged smoke；此前 `f9d680b` 包的 64 项 smoke 是历史证据，不能等同这个新包运行已通过。本轮后端源码服务使用真实第三方模型的实测与新包的静态内容核验分别记录。

### 当前本地交付文件

| 资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe` | 158053192 | `2047eed2bb8f4a9a57c03c5435e3f8f29f3eb66b76d76a2ce4a567b12c06139c` |
| `desktop/dist-electron/OpenFix-0.11.1-win-x86_64.zip` | 188491357 | `80a2a6c0619ca1adefe56ec23a9f88a146effc24c8af79682435ece9bb61f3a7` |
| `desktop/dist-electron/OpenFix-0.11.1-win-x86_64-setup.exe.blockmap` | 166643 | `e12eb448656fe65c3683232b28a9795c4ff8ffa86618838db37a955d6b50a48a` |
| `desktop/dist-electron/latest.yml` | 368 | `52b3af0494ba81c174e8c568497169c7bdee64abc9561e7ee1f2fbcb0b926256` |
| `desktop/backend-wheel/openfic-0.11.1-py3-none-any.whl` | 30837849 | `93687b4a062f5b7c0a92dabf6fcecafaea6871de111350ec0a406b1f39f7df60` |

当前安装包 Authenticode 实际读回为 **NotSigned**，无 signer/timestamp certificate。

### 运行读回与清理

确认四个实测会话不在运行且无待审批后，停止 owned 后端 `j-914ecw`，启动 `j-ddvsag`，保留原数据目录、加密密钥和 9000 前端。重启后四章的 SHA-256/总字数、六份文风/候选笔记的 SHA-256 和默认模型设置与重启前一致，Socket.IO 自动重连成功。

清理前核对 Windows 进程引用为 0、两个精确目标路径在工作区内、全部父路径与目录树没有 symlink/junction，再只删除：

- `desktop/dist-electron/win-unpacked`：394198438 bytes。
- `tmp/real-model-validation-20261004-package/uv-cache`：1752623 bytes。

共回收 **395951061 bytes（约 378 MiB）**。五个交付文件在清理前后大小/hash 一致；应用数据与共享缓存保留。内容、运行、签名和清理读回保留在上述 tmp 证据目录，不提交用户数据库。

复杂度：runner 和测试文件已有大文件压力，本轮属于 `local-fix-without-new-responsibility`，原 owner 中替换判定并补直接调用接缝；没有新增通用状态机或重复 owner。后续测试维护应按 runner 行为拆分大测试文件，此整理不扩大当前行为修复范围。长期 V1 验收记录仍使用同一个 work record。

## 下一步最有收益的优化

本轮最明显的额外开销是 Build 调度往返和大 Tool schema：Build 每次 schema 约 8675 estimated tokens，Writer 5871、Reviewer 2666、Actor 6581。写作链 Build 分别占 8/12 次逻辑调用；MiMo 还有 reasoning-only 修订失败。继续优化应先减少执行列表/交接往返、评估稳定的最小工具 bundle，并按任务和模型检查 reasoning/output 预算。

本轮已记录 Soft Prune 的请求贡献，写作链分别为 4605/10053 estimated tokens；没有触发 compaction，也没有大量 RAG，不能拿本次数据证明长会话 GC、Compaction 或 RAG 的降低比例。

Claude 的只读审查还提出 reasoning-only 的错误分类和 Socket.IO 诊断传输/异步窗口建议。协调者确认当前空正文子运行会报错、用量仍应记录；websocket 与 polling 实际探测成功、刷新及重启后连接恢复。本轮只修有明确回合判定复现的 runner 缺陷；诊断竞态尚未补受控复现，后续需要 fake timer/transport 回归，不能列为已修复或所有建议已验证。

整体 V1 正式发布继续为 needs-verification：仍需长篇质量验证、干净 Windows 历史升级及原数据、native ARM64、远端 Actions/双架构 Release 与正式签名。当前开发版本是 0.11.1，本次配置和测试不等于正式 V1 Release。
