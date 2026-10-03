# OpenFix 小说自然度增强：实现与验证

## 基线与结论

实现基线是本地 `0402d68654b2072f9caf9666aa9e96d4b659d0bf`，分支 `feature/branding`。本次只在 `新版本/OpenFix` 开发，使用原有 Skills、Prompt Chains、Agent definitions、dispatch、Notes 与 Revision 审批。

本轮完成了叙事、POV、人物声线、项目文风短卡和局部修订的能力接线。代码、协议与加载回归已通过；真实模型生成质量尚未通过小说样本盲评验收。实现切片信心等级 B，不能由这些测试推断整个 V1.0 正式发布已完成。

## 审查发现与规则统一

- Writer 原有绝对禁止比喻/拟人、完整主谓宾、硬章节字数和禁词替换要求，与已有去模板化/格式 Skill 冲突。
- Reviewer 原有每段 1–3 句、最多 60 字和禁止天气/环境开场要求；Build 入口重复了这些约束。
- 对话参考把权力位置绑定到句长，并要求每句话推进剧情；格式参考把停顿符号统一改为动作，会生成新的微动作模板。
- `deslop-writing` 的核心过长，部分参考又把自然度判断简化为次数、比例和替换模板。
- 已有 `author-style-profile` 能分析样本，本轮复用它；原来没有确认档案到后续 Agent 上下文的短卡接线。
- 数据库 Agent 定义覆盖默认 definitions，Prompt Chain 活跃数据库版本覆盖 YAML。不能将显式空 Skill 清单当作缺配置并强制补齐。

统一顺序：剧情事实与角色设定/用户已确认约束 → POV/人物声线/场景功能 → 项目文风 → 小说自然度 → 格式 → 表层 pattern。保留功能性修辞、自然不完整对白、必要解释、呼吸场景和有意收束。删除强制句长、段长、词频替换和统一叙事公式。

## 修改文件与职责

| 文件 | 修改 |
| --- | --- |
| `backend/app/skills/deslop-writing.yaml` | 核心 161 行，事实锁、Gate/Pass、最小有效修改、验证/停止条件；4 个按需参考。 |
| `backend/app/skills/deslop-lexicon.yaml` | 改为 Surface Linter，命中不等于错误，语境豁免；词表移到参考，不增加禁词。 |
| `backend/app/skills/narrative-deslop.yaml` | 新增 N1–N8、POV/距离、证据不足与不适用、叙事改动和局部修订边界。 |
| `backend/app/skills/dialogue-design.yaml` | 人物声线卡、遮名检查、关系与压力变化、不完整对白；移除权力句长模板。 |
| `backend/app/skills/prose-format.yaml` | 按戏剧单元/镜头/信息变化断段；停顿、标签、章节开合依功能。 |
| `backend/app/skills/story-quality.yaml` | 事实到表层的审查顺序、S1–S4、风险向量和定位字段；细则按需参考。 |
| `backend/app/skills/style-profile.yaml` | 项目档案 JSON v1、确认/撤销、短卡与样本分析路由；新增保存与使用能力。 |
| `backend/app/skills/author-style-profile.yaml` | 原分析方法保留，增加保存为项目档案及后续短卡使用路由。 |
| `backend/app/prompts/builtin-agents/writer.yaml` | 聚焦 beat、POV、目标、声线、文风和一致性；详细审稿交 Reviewer。 |
| `backend/app/prompts/builtin-agents/reviewer.yaml` | 只读 Narrative → Surface、风险向量、结构化 issue、Final Review 停止条件。 |
| `backend/app/prompts/builtin-agents/actor.yaml` | issue span/邻域定位、事实保留、最小有效修改和局部验证回执。 |
| `backend/app/prompts/builtin-agents/build.yaml` | 清除入口冲突规则，使用既有 dispatch 组合自然度流程。 |
| `backend/app/prompts/builtin-agents/plan.yaml` | 增加同一协作协议，保留原规划职责。 |
| `backend/app/agent_runtime/agents/definitions.py` | 少量默认 Skill manifest；保留数据库覆盖语义。 |
| `backend/app/storage/repos/note_repo.py` | 精确查询项目内可见、根级、同名笔记，最多读 2 条检测歧义。 |
| `backend/app/storage/services/style_profile_service.py` | 只从现有 Notes 读取并编译确认档案；固定字段顺序、大小限制、未知/损坏安全回退。 |
| `backend/app/agent_runtime/context/parts/style_profile.py` | 尊重 Agent/Skill/读取权限；转义短卡，限制最终发送内容，排除原始样本。 |
| `backend/app/agent_runtime/context/build_context.py` | 仅接线：规则后、Skill manifest 与历史前插入短卡。 |
| `backend/app/agent_runtime/context/metrics.py` | 增加 `style_profile` Token 分类、稳定性及指纹。 |
| `backend/tests/skills/test_novel_naturalness.py` | YAML/ID/参考/Token、规则冲突、各 Agent 协议、默认 bundle 和真实 Skill 工具回归。 |
| `backend/tests/storage/test_style_profile_service.py` | SQLite 持久化与更新、隔离、确认/隐藏/歧义/损坏、权限、转义及最终 Token 上限、完整 Context 构造。 |
| `backend/tests/agent_runtime/context/test_build_context.py` | 原隔离 fixture 适配新 context part，真实接线另有 SQLite 回归。 |
| `backend/tests/api/test_agent_definitions.py` | API 精确校验新的 Build/Plan/Writer/Reviewer 默认 Skill 清单。 |
| `docs/aegis/plans/2026-10-04-novel-naturalness.md` | 本轮范围、实现计划、兼容性和验证边界。 |
| 本文 | 实现说明、使用方法、实测静态 Token 与最终验证证据。 |

## Narrative Gates 与协作协议

| Gate | 重点 |
| --- | --- |
| N1 Character Agency | 人物想要什么、为何现在行动、主动选择是否有依据。 |
| N2 Resistance | 阻力来自已有立场/条件/信息/误判，不能为指标新增剧情。 |
| N3 Choice | 选择属于人物；单一选项可是真实处境，不硬造 A/B。 |
| N4 Cost | 实际后果及延迟兑现，避免用总结句代替代价。 |
| N5 Irreversible Change | 重要 beat 的信息、关系、机会、承诺、策略等变化；呼吸场景允许不适用。 |
| N6 Knowledge Boundary | 已知与推断分开，保留误解、偏见、自欺和限知边界。 |
| N7 Interpretation Density | 事件后重复解释情绪/意义；必要心理经验与因果保留。 |
| N8 Tidy Closure | 避免反复总结、成长、金句、预告；有功能的阶段收束保留。 |

Story/Plot → Narrative Check → Writer Draft → Narrative Reviewer → Surface Deslop Reviewer → Actor Targeted Revision → Final Review。

这是既有 dispatch 的 Prompt/Skill 协作协议。已有成稿跳过 Writer，纯审查只派 Reviewer，Narrative 与 Surface 可在同一 Reviewer 请求完成，无实质 issue 跳过 Actor。只交接相关章节、锚点、问题、保留项与短卡，不传全部 Writer 历史。尚未新增强制工作流引擎或 issue JSON 解析器。

Reviewer 输出 `risk_vector`，每维为低/中/高/证据不足；issue 提供 `id/type/severity/chapter_id/location/quote_anchor/reason/goal/preserve/requires_plot_change`。Actor 不猜 offset，不因一处问题重写整章；需要新事件或改变选择时交回剧情设计。

## Skill 加载与兼容

- Writer 默认 2 个：style-profile、deslop-writing。
- Reviewer 默认 5 个：style-profile、narrative-deslop、deslop-lexicon、story-quality、dialogue-design。
- Actor 默认 3 个：style-profile、deslop-writing、prose-format；Composer 提供样本分析/档案/叙事预检。
- Build/Plan 入口使用对应少量 manifest。完整正文仍由 `activate_skill` 按需读取，references 由 `reference_skill` 按标题读取。
- 已审查 `context/parts/skills.py` 和 `tools/impls/skill/skill.py`；原实现已经分离 manifest/core/reference，继续复用。
- 六个既有相关 Skill 的 ID 和原 reference 名称均保留，比较基线未发现丢失的旧 reference 名称。
- 数据库 Agent/Prompt 自定义版继续优先，包括显式空清单；不会猜测用户是否定制或自动重置。已保存旧版本的用户需要显式启用所需新 Skills、更新对应 Prompt 后才能采用新默认。

## Style Profile 使用

授权 Composer 分析 3～10 章/样本，沿用“文风样本分析”。确认要在项目采用后，用现有笔记工具和审批写入根笔记 `项目文风档案`。正文须是 JSON 对象，包含 `schema_version: 1` 与 `status: "confirmed"`；草稿用 `draft`。模板在 style-profile 的 reference。

档案固定类别为 narration、syntax、paragraph、dialogue、emotion、imagery、anti_patterns。未知指标省略，值最长 64 字符，anti_patterns 最多 6 条，原档案最多 32,000 字符。样本、证据和分析说明不进入短卡；转义及包装后的最终 Context part 最多 800 个估算 Token，超限不截断或硬塞。

只读取项目内唯一可见根笔记，未确认、隐藏、同名歧义、损坏或未知版本不自动采用。Agent 须启用、具备 `note_read`、启用 style-profile 且全局 Skill 未禁用。修改后下一轮重新读取；无跨请求缓存陈旧问题。读取故障以 Context 错误传播，不默默宣称已使用文风。隐藏、删除或改回 draft 可以撤销采用。

单次 Context 的相关稳定部分顺序为：Agent system → 项目 rules → 短 Runtime Style Card → Skill manifest → history；其它既有 context part 和预算策略沿用当前实现。

## 静态 Token 测量

使用项目 `count_tokens`，对比本地基线与修改后 YAML。Prompt 只统计按 order_index 排序后以换行连接的启用 entry 内容；Skill 只统计 core，排除 references。以下是静态内容估算，不能等同 API 输入用量、费用、缓存命中或小说质量 benchmark。

| 内容 | 修改前 | 修改后 | 变化 |
| --- | ---: | ---: | ---: |
| Writer Prompt | 4,795 | 1,147 | -76.1% |
| Reviewer Prompt | 1,397 | 1,219 | -12.7% |
| Actor Prompt | 996 | 1,430 | +43.6% |
| Build Prompt | 3,842 | 2,369 | -38.3% |
| Plan Prompt | 3,767 | 4,070 | +8.0% |
| deslop-writing core | 7,368 | 2,136 | -71.0% |
| deslop-lexicon core | 3,213 | 570 | -82.3% |
| dialogue-design core | 109 | 699 | +541.3% |
| prose-format core | 103 | 559 | +442.7% |
| story-quality core | 7,161 | 732 | -89.8% |

Actor/Plan 增加局部修订边界与调度协议；原 dialogue/prose 核心仅要求读取长参考，新核心直接提供可执行原则。不能只挑下降数字报告总体模型成本下降。

## 验证与局限

- 最终完整后端：`uv run pytest -q`，**2139 passed，143.61 秒，退出 0**。
- 最终相关回归：Skills、新短卡服务、全部 context、Skill tools、Agent definitions API、Skill API/reference，**250 passed，4.74 秒，退出 0**。
- `uv run ruff check app tests`、`uv run ty check app` 均通过；4 个新增 Python 文件 `ruff format --check` 通过。
- 前端 `pnpm lint` / `pnpm type-check` 均为 452 文件、零警告/错误；桌面 `pnpm lint` / `pnpm type-check` 通过。完整 `pnpm --dir desktop build`（前端 production、setup renderer、main TypeScript）退出 0；构建保留既有大 chunk 警告。
- CRLF-aware `git diff --check` 通过；保留既有行尾，不做整仓格式化。
- Claude Code 的两次限定只读审查均被第三方网关返回 502；没有取得审核结论，不计为审核通过。协调者完成本地源码复核及上述实际门禁。
- 测试未调用真实付费 LLM，也未接入 AI 检测服务。协议断言证明约束、加载和持久化接线；不能证明模型一定遵守每条规则或真实小说质量已经提升。
- 本实现提交阶段尚未重建安装包；之后的最新包验收已经完成，见 [当前包报告](2026-10-04-current-package.md)。该包在源码 HEAD `f9d680b` 上重建，后端/前端/桌面内容逐字节核对通过，64 项合成 packaged smoke 通过。
- 复杂度在本轮范围内：Notes 继续是唯一持久化所有者，Context builder 只接线，编译服务/part 各自单一职责；新增测试沿用现有框架，不新增依赖、schema、Provider 或 RAG 系统。

最值得继续验证的是：用用户自己的同一批章节，对旧/新 Prompt 做人物认知、声线、POV、文风和最小修改范围的盲评；之后再把风险向量和可定位 issues 接到现有 UI。

收尾重新运行 Ruff、ty 及上述 250 个相关回归，FastCtx `j-ltrge5` 退出 0，**250 passed / 5.98 秒**。原完整 2139 项结果属于实现阶段，本次收尾未重复完整后端套件。
