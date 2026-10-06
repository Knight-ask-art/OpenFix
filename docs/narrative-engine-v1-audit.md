# Narrative Engine v1 Phase B 基础层审计与实现契约

范围：本文件只覆盖 Narrative Engine v1 的 **Phase B 基础层**（叙事状态表 + 类型化 Schema +
仓储/服务/路由 + 迁移 + 测试）。检索、上下文注入、Agent 工具、前端展示由父任务在后续阶段完成，
不在本次范围内。

本次工作基于当前本地工作树（branch `feature/branding`，含未提交改动），并复核了
`backend/.venv/novel-acceptance/claude-narrative-foundation-audit-recovered.txt` 的结论。
复核方式为源码阅读 + 现有测试/迁移约定比对，未运行真实服务。

---

## 1. 已有能力（复用，不重写）

| 能力 | 位置 | 复用方式 |
| --- | --- | --- |
| 扩展表模式 | `backend/app/storage/models/character_profile.py`、`character_state.py`、`world_entry_meta.py`、`chapter_meta.py` | 新表沿用「独立主键 + `project_id` 外键 + `created_at`/`updated_at` + JSON 文本列」的既有形状 |
| 迁移模板 | `backend/app/storage/migrations/versions/1024_create_world_entry_meta.py` | 显式 `ix_*` 索引、命名唯一约束、`downgrade()` 先删索引再删表 |
| 仓储/服务/路由分层 | `app/storage/repos/world_entry_meta_repo.py`、`app/storage/services/world_entry_meta_service.py`、`app/api/routers/chapter_meta.py` | Router 只做参数/状态码/调用 Service，业务在 Service，SQL 在 Repo（`OpenFix/AGENTS.md` §16） |
| 项目作用域 | 所有表 `project_id` + `filter_eq`/`where` | 读写全部按 `project_id` 限定 |
| 项目删除级联 | `app/storage/services/project_service.py:delete_project` | 在删除人物/章节/大纲等父行之前清理新表 |
| 领域错误映射 | `app/core/errors.py` + `app/api/exceptions.py` | `NotFoundError`→404、`ConflictError`→409 已全局处理；`ValidationError` 需路由内翻译为 400（沿用 `chapter_meta.py` 写法） |
| 测试基建 | `backend/tests/conftest.py`、`backend/tests/model_registry.py` | 内存 SQLite `SQLModel.metadata.create_all`；新模型必须同时进 `app/storage/models/__init__.py` 与 `tests/model_registry.py` |
| 迁移头断言 | `backend/tests/storage/test_story_memory_fingerprint_migration.py:132` | 头部从 `1031` 顺延到 `1032` |

## 2. 缺口（本阶段要补的）

现有 Agent 写入审批和已确认 Style Profile 已区分建议与用户确认。本阶段缺口是：
这些机制尚未形成可检索的原子叙事事实、人物信念、情节线和场景状态及其溯源。具体缺口：

1. **无原子世界事实**。`world_info_entries` 是自由散文 `name`/`content`，无法表达
   「一条可判定真伪、可被推翻、可被取代的断言」。
2. **无人物信念**。`character_states` 是可变的当下快照（地点/身体/心理/目标/关系），
   不是「人物相信某个命题」这种可错（mistaken）的陈述。
3. **无情节线义务追踪**。`outlines` 是 `book/arc/volume/chapter` 树 + 自由文本，
   没有 open/resolved 状态，也没有 setup→payoff 义务。
4. **无场景粒度**。最小单位是章节，只有章节级 `chapter_meta`。
5. **缺少统一叙事溯源列**。现有审批和文风确认不能替代 Fact / Belief / Plotline /
   Scene 的 source / confidence / confirmation，需要为这些新记录显式保存候选与确认状态。

## 3. 重复风险（明确不做）

- 不新建第二套 RAG / 检索：本次不碰 `backend/app/retrieval/`、不碰
  `search_story_memory` 工具。新表只是**未来** `story_memory` 的候选数据源，
  接入由父任务负责。
- 不新建人物状态系统：`character_states` 保持原样，信念是**另一张表**，
  因为「事实」与「信念」不能混为一谈（一个已确认的信念仍可能是错的）。
- 不新建大纲树：`plotlines` 通过可选关联 ID 指向 `outlines`，不嵌套、不替换。
- 不改核心表：`projects` / `chapters` / `characters` / `outlines` / `world_info_entries` /
  `revisions` 一律不动，只新增扩展表。
- 不新增依赖、不新增 Emoji、不新增遥测。

## 4. 计划新增/修改文件

**新增**

```
backend/app/storage/models/narrative_provenance.py   # 共享溯源列基类 + 枚举常量
backend/app/storage/models/world_fact.py             # world_facts
backend/app/storage/models/character_belief.py       # character_beliefs
backend/app/storage/models/plotline.py               # plotlines
backend/app/storage/models/scene_plan.py             # scene_plans
backend/app/storage/repos/narrative_repo.py          # 四张表的数据访问
backend/app/storage/services/narrative_service.py    # 校验/确认/取代/分页 + 视图对象
backend/app/api/schemas/narrative.py                 # 类型化请求/响应模型
backend/app/api/routers/narrative.py                 # 路由
backend/app/storage/migrations/versions/1032_create_narrative_engine_tables.py
backend/tests/api/test_narrative_engine.py
backend/tests/storage/test_narrative_engine_migration.py
docs/narrative-engine-v1-audit.md                    # 本文件
```

**最小修改**

```
backend/app/storage/models/__init__.py               # 注册 4 个模型
backend/app/storage/repos/__init__.py                # 注册 narrative_repo
backend/app/storage/services/__init__.py             # 注册 narrative_service
backend/app/main.py                                  # +1 行 include_router
backend/tests/conftest.py                            # +1 行 include_router（测试应用）
backend/tests/model_registry.py                      # 注册 4 个模型
backend/app/storage/services/project_service.py      # 删除项目时清理 4 张表
backend/tests/storage/test_story_memory_fingerprint_migration.py  # 迁移头 1031 -> 1032
```

**明确不动**：`app/retrieval/**`、`app/agent_runtime/**`、`app/skills/**`、`app/prompts/**`、
`frontend/**`、核心表模型、`revision_*` 引擎、`.env`/凭据、Git 元数据。

## 5. 数据库变更与风险

### 5.1 变更

单个 revision `1032`，`down_revision = "1031"`，只 `create_table` 四张新表：

| 表 | 关键列 | 约束 |
| --- | --- | --- |
| `world_facts` | `statement`、`subject_ref`、`status`、`superseded_by_id` | 索引 `project_id` / `status` / `confirmation` / `source_type` |
| `character_beliefs` | `character_id`、`proposition`、`belief_state`、`learned_at_chapter_id`、`superseded_by_id`、`invalidated_at` | 索引 `project_id` / `character_id` / `belief_state` |
| `plotlines` | `title`、`description`、`current_question`、`payoff`、`state`、`introduced_chapter_id`、`advanced_chapter_id`、关联 ID JSON | 索引 `project_id` / `state` |
| `scene_plans` | `chapter_id`、`scene_index`、`goal`、`pov_character_id`、`location`、`tone`、若干 JSON 列 | `UniqueConstraint(chapter_id, scene_index)` |

四张表共享同一组**溯源列**（列名一致，非多态孤儿表）：`source_type`、`source_id`、
`source_chapter_id`、`quote_anchor`、`created_by`、`confidence`、`confirmation`、
`confirmed_at`、`confirmed_by`。

### 5.2 风险与对策

| 风险 | 对策 |
| --- | --- |
| 旧库升级时新表为空即可，但列必须能在旧 SQLite 上创建 | 所有列 `nullable=False` 均带 `server_default`；可空列显式 `nullable=True`（对齐 1024） |
| 降级必须干净 | `downgrade()` 先 `drop_index` 再 `drop_table`，顺序与 1024 一致 |
| 外键指向核心表 | 只**新增**指向 `projects`/`chapters`/`characters`/`outlines` 的外键，不修改被指向的表 |
| SQLite 不强制外键 | 归属校验放在 Service 层显式做（项目存在性 + 跨项目引用拒绝），不依赖数据库 |
| 迁移头被多处断言 | 同步更新 `test_story_memory_fingerprint_migration.py` 的 head 与回溯起点 |
| 与 upstream 合并冲突 | 表名领域独立、迁移号顺延、不改核心文件；`project_service.py` 只加一段删除调用 |
| 全表扫描 | 所有列表接口强制 `project_id` + 分页（`limit<=200`）+ 可选过滤，不做跨项目/整书扫描 |

## 6. 实现契约（本次交付的确定性约定）

### 6.1 世界事实 `world_facts`

- `status ∈ {confirmed, uncertain, contradicted, retired}`：断言在故事世界中的**成立状态**。
- `confirmation ∈ {candidate, inferred, confirmed, rejected}`：**人工确认状态**，与 `status`
  是两条正交轴。
- 取代：更新时设置 `superseded_by_id`（必须是同项目内的另一条事实），同时把本条
  `status` 置为 `retired`。不静默删除。

### 6.2 人物信念 `character_beliefs`

- `belief_state ∈ {known, believed, suspected, unknown, mistaken}`，必填 `character_id`
  与 `proposition`。
- `learned_at_chapter_id`：人物在哪一章得知，可空。
- `confidence`：使用共享溯源列上的 `confidence`（0..1，可空），不重复建列。
- `superseded_by_id` / `invalidated_at`：失效的两种方式，均保留行。
- **信念与事实不混用**：不同表、不同接口、不同枚举。`belief_state="mistaken"` 且
  `confirmation="confirmed"` 是合法组合——已确认的信念依然可以是错的。

### 6.3 情节线 `plotlines`

- `state ∈ {open, progressing, resolved, abandoned, uncertain}`。
- `title` 必填；`description`/`current_question`/`payoff` 自由文本。
- `introduced_chapter_id` / `advanced_chapter_id`：必须属于当前项目。
- `related_character_ids` / `related_outline_ids`：JSON 列表，写入时校验归属。

### 6.4 场景计划 `scene_plans`

- `chapter_id` 必填且属于当前项目；`scene_index >= 0`，`(chapter_id, scene_index)` 唯一。
- `pov_character_id`、`participants`、`character_goals[].character_id` 必须属于当前项目。
- `active_plotline_ids` 必须属于当前项目。
- `world_constraints` / `known_information` / `hidden_information` 为自由文本列表，
  不强制引用实体（避免发明必需字段）。
- `result`：JSON 对象，固定五个分类，每类为自由文本列表：
  `fact_changes` / `belief_changes` / `relationship_changes` / `state_changes` /
  `plotline_changes`。

### 6.5 溯源

- `source_type ∈ {user, chapter, agent, inference, outline, world_info, character_profile}`，
  默认 `user`。
- `source_id`：当 `source_type` 为 `chapter` / `outline` / `world_info` / `character_profile`
  时，必须是当前项目内存在的实体；`user` / `agent` / `inference` 不做实体校验。
- `source_chapter_id`：必须是当前项目内的章节。
- `quote_anchor` / `created_by`：自由文本，默认为空串。
- `confidence`：`0.0 <= confidence <= 1.0`，可空。
- 全部字段可选，不发明必需细节。

### 6.6 确认与升级防护

- **创建**：`confirmation` 只接受 `candidate` / `inferred`，缺省为 `candidate`；
  请求 `confirmed` 直接 400。AI / Agent / 默认路径因此只能产生候选。
- **常规更新（PATCH）**：`confirmation` 只接受 `candidate` / `inferred` / `rejected`；
  请求 `confirmed` → 400（升级被拒）；当前已是 `confirmed` 的行不允许通过常规更新
  改回未确认状态 → 400。拒绝（`rejected`）与取代是安全的，不删除行。
- **确认接口**：`POST .../confirm`，请求体必须携带 `expected_updated_at`。
  与库中 `updated_at` 不一致 → 409（防止基于过期数据确认）。已确认的行幂等返回。
- **没有 Agent 写入 confirmed 的工具**：本次不新增任何 Agent 工具；确认只能由人类
  通过确认接口触发。

### 6.7 作用域与边界

- 所有路由挂在 `/api/v1/projects/{project_id}/narrative/...`，服务层先校验项目存在。
- 条目级读写用 `(project_id, item_id)` 双条件定位，跨项目 ID 一律 404/400。
- 列表接口：`limit`（默认 50，上限 200）、`offset`、按状态/确认/归属过滤，返回
  `{items, total, limit, offset}`。

### 6.8 项目删除

`project_service.delete_project` 在删除人物 / 章节 / 世界书之前调用
`narrative_repo.delete_by_project`，一次性清理四张表（场景计划 → 情节线 → 信念 → 事实），
避免留下孤儿行。

## 7. 测试矩阵

| 文件 | 覆盖 |
| --- | --- |
| `tests/api/test_narrative_engine.py` | 事实 CRUD、候选确认防护、确认接口乐观锁、取代、信念 mistaken×confirmed、情节线 resolve、溯源写入与校验、跨项目引用隔离、场景计划唯一性与归属、删除、项目删除级联 |
| `tests/storage/test_narrative_engine_migration.py` | `1031 → 1032` 升级建表且旧数据保留、降级删表且旧数据保留、链连续性 |
| `tests/storage/test_story_memory_fingerprint_migration.py` | 迁移头断言更新到 `1032` |

## 8. 验证结果（本次实际执行）

| 命令 | 结果 |
| --- | --- |
| `ruff check`（全部新增/修改文件） | All checks passed |
| `pytest tests/storage/test_narrative_engine_migration.py tests/storage/test_story_memory_fingerprint_migration.py -q` | 7 passed |
| `pytest tests/api/test_narrative_engine.py -q` | 24 passed |
| `pytest tests/api/test_projects.py tests/api/test_project_and_chapter_meta.py tests/test_main.py tests/storage/test_database_cleanup.py tests/storage/test_revision_cascade.py tests/api/test_world_entry_meta.py tests/api/test_character_extensions.py -q` | 58 passed |

未执行：真实服务启动、真实迁移命令 `alembic upgrade`（迁移逻辑通过内存 SQLite 直接调用 upgrade/downgrade 验证）、前端相关验证。

## 9. 未决/后续（不属于本次范围）

- 新表接入 `story_memory` 文档构建与 `source` 过滤（父任务）。
- 候选是否默认排除出检索（父任务，建议沿用 `ai_visible` 先例）。
- 章节级 writer 上下文注入场景计划与情节线（父任务）。
- 修订快照对四张表的捕获/还原（父任务；本次不注册进 `EXTENSION_ENTITY_TYPES`）。
- 增量索引：v1 沿用全量重建 + 指纹过期信号。
