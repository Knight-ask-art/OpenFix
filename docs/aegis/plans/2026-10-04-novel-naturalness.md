# OpenFix 小说自然度增强

## Goal / Architecture / Tech Stack

将词句替换提升为叙事、POV、声线与项目文风协作审稿；沿用 Python/FastAPI、SQLite Notes、YAML Skills/Prompt Chains、现有 dispatch 与 Revision 审批。Aegis Visibility：跨 Skill、Prompt 和持久化消费者需要统一规则与兼容性证据。

## Baseline / Authority Refs

- 用户本轮详细需求；本地 `0402d68654b2072f9caf9666aa9e96d4b659d0bf`，`feature/branding`，初始 clean，origin ahead/behind 0/0，单工作树，无进行中的 Git 操作。
- `../AGENTS.md`、`OPENFIX.md`；Python 产品目录优先于外层旧 Rust 计划。
- 已审查指定的五个 Skills、Writer/Reviewer/Actor、Agent definitions、Skill manifest/tools、Notes service/repo/tools、Prompt Chain 默认与 DB override 路径。
- 当前主 Skill 332 行且完整指南继续含硬阈值；Writer 绝对禁修辞、完整句与禁词；Reviewer 固定段长；Build 重复相同约束。文风样本分析已存在，但缺短卡持久化消费。

## Compatibility Boundary / Change Necessity

仅 YAML 无法让已确认项目文风自动进入后续请求，故最小代码边界是：现有 Notes 的精确标题查询、Style Profile 校验/短卡服务、context part 接线与 metrics 分类。无需新表、migration、API、依赖或 workflow engine。项目根笔记 `项目文风档案` 保存 JSON v1；只有 status=confirmed 的有效档案自动读取，隐藏、歧义、损坏档案不自动应用。

Agent 默认仅开启少量 manifest，正文仍通过 activate_skill/reference_skill 拉取。DB Agent/Prompt overrides 优先，包括显式空 Skills；不猜测是否用户定制，不自动 reset。已有 Skill ID 与参考标题保持兼容，新增叙事审查与文风运行 Skill。旧机械模板退休，其文学功能保留为情境参考。

## TDD Route / Verification

Mode: off；Decision: skipped；Authority: 根 AGENTS；Test posture: 按用户要求补行为与契约回归测试；不要求 RED-first。验证 YAML/ID/reference/token、manifest 无全文、Agent 默认与 DB 覆盖、SQLite Notes 写入读回、短卡确定性/大小/隔离/隐藏/损坏/更新、Context 顺序、Reviewer issue 协议、Actor 最小修改边界。运行 focused pytest、后端完整 pytest（可行时）、ruff、ty，不调用付费模型。

## Tasks

1. 重写 deslop-writing 核心（150–300 行）及按主题 references；lexicon 改 Surface Linter；新增 narrative-deslop；增强 dialogue/prose-format/story-quality；复用 author-style-profile 生成短档案。优先级：事实/人物 > POV/声线/场景 > Style > 自然度 > 格式 > 表层模式。
2. 缩减 Writer；Reviewer 风险向量和带 quote_anchor/paragraph 定位的 issues；Actor 只修目标及邻域；Build 移除冲突，Build/Plan 复用 dispatch 串行组织 Narrative → Surface → Actor → Final。
3. 默认 Skills 与现有 DB 覆盖兼容；Style Profile 用原 Notes 写工具与审批，短卡服务只读。Context builder 仅接线，稳定卡位于 history 前；不加载原始样本。
4. 补上述测试，修复任务相关失败，审查完整 diff。保留一份验证结果文档，统计实际静态 token 变化但不声称小说质量或模型成本改善已获实测。
5. 显式路径暂存、CRLF-aware diff check、提交并推送 origin/feature/branding，核对远程 SHA。

## Risks / Retirement / Execution

Scope fence：不改 Provider/RAG/Web/前端/数据库 schema/Revision 核心。静态断言证明协议与加载，不证明真实生成质量；真实小说样本盲评留作后续。旧自定义 prompts 继续保留，需用户自行更新或重置才使用新默认。复杂度：Context builder 接线；Profile 服务单一责任；长 YAML 案例在 references 按需读取。执行 inline；Claude Code 可用于只读复核，失败时自行完整验证。单 inline checkpoint：审查已完成 → 实现 → 测试 → 提交/推送。User confirmation required: no（当前开发、测试及交付均已授权）。
