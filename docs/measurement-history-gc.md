# 测量历史上下文清理（measurement history GC）

范围：本文件只覆盖 `backend/app/agent_runtime/context/processors/measurement_gc.py`
及其在 `build_context_parts` 中的接线。它是**模型请求级**的软清理，不涉及持久化、
迁移、API 契约、前端或提示词。

## 1. 问题

`measure_text` 是 agent 证明章节字数的唯一手段，因此每次修订都要把整章草稿作为
`args.text` 传进工具调用。这些工具调用会随 assistant 消息进入 history，并在之后
**每一次**模型请求里被重复发送。一次验收会话里连续改 5 到 6 版 3000 字草稿，
等于每轮都在请求里携带 5 到 6 份整章正文。

实测（本地 `o200k_base` 计数器，6 版 3200 字草稿）：

| 指标 | 数值 |
| --- | --- |
| 清理前请求 token | 19318 |
| 清理后请求 token | 6976 |
| 减少 | 12342 |
| 减少比例 | 63.9% |
| 退役调用数 | 4 / 6 |

该数字只描述**本地 tokenizer 对模型请求体积的测量**，不代表任何提供商的计费、
缓存命中率、生成质量或审核结论。不同 tokenizer、不同草稿长度会得到不同结果。

## 2. 做什么

只重写**即将发给提供商的那份 `ContextMessage` 列表**：把已被更新的同范围测量
取代的旧 `measure_text` 调用参数，替换为一条简短的实测事实标记。

标记内容形如：

```text
（上下文清理：本次测量的正文输入已从当前模型请求中省略，实测 3214 字，
2500-3500 字。正文内容未被修改，完整输入仍保存在会话历史中。此标记不是正文，不得作为写入内容。）
```

标记只陈述**实测事实**（字数、字数范围、正文未被修改），不伪造、不摘录任何
正文内容，也不冒充草稿。

工具调用本身保持提供商可接受的形状：`id`、`name`、`args` 三个键不变，
`args` 内除 `text` 外的参数（`min_words` / `max_words`）原样保留，`text` 仍是字符串。
配对的 tool 结果、`tool_call_id`、审批、source snapshot、角色顺序都不变。

## 3. 不做什么

明确不触碰：

- 持久化任务历史（`agent_run_messages`）与任何 DB 写入；
- tool 结果内容、`tool_call_id`、调用与结果的配对关系；
- 审批（approval）状态、preview 结果、interrupt 参数；
- `source_snapshot` / handoff 快照；
- 章节正文、CANON、草稿等权威文本；
- 任何非 measurement 工具（`read_chapter`、`write_chapter`、`search_*` 等）；
- 用户消息与作者约束（rules / style profile / skills）。
- 当前创作上下文（本处理器只看 measurement 工具调用的 `text` 参数）。

## 4. 保留规则

判定「可退役」必须同时成立：

1. 工具名在 `MEASUREMENT_TOOL_NAMES`（当前只有 `measure_text`）；
2. 调用有**出现在其之后**的配对 tool 结果；
3. 该结果解析为成功的 JSON 且带整数 `word_count`（失败、`type=fail`、带 `error`
   的一律视为未解决，永不退役）；
4. 实测字数 `>= MIN_FULL_DRAFT_WORDS`（800）——低于此值视为片段探测；
5. 同一字数范围 `(min_words, max_words)` 下，已有更新的整章测量存在。

在同一字数范围内：

- 永久保留**最新 2 份**整章测量（`RETAIN_LATEST_FULL_DRAFTS`），保证仍可对比最近两版；
- 片段探测（如 5 字、552 字）**永不退役**，也**不占用**这 2 个保留名额；
- 不同字数范围互不取代；范围变了就保留旧范围的草稿，不做推断；
- 单份草稿在单条消息里省下的 token 少于 `MIN_ELIDED_TOKENS`（256）时不改写。

无法证明「已被更新测量取代」的调用一律保持原样，不猜测、不构造 provenance。

同一字数范围只有一组、且只有 3 份整章时，只退役最旧的 1 份；少于 3 份时完全不动。

## 5. 安全阀

| 机制 | 触发 | 效果 |
| --- | --- | --- |
| 用户设置 | `context_soft_gc_tool_results = false` | 整个清理（含既有的重复结果 GC）跳过 |
| 对比 / 恢复意图 | 最近一条用户消息含「对比 / 比较 / 比对 / 对照 / 回滚 / 还原 / 恢复 / 用回 / 上一版 / 之前的草稿 / compare / restore / revert / rollback / previous draft …」 | 本次请求完全不做清理 |
| 用户逐字引用 | 用户消息里存在与某草稿连续重合 48 字符以上的窗口 | 该草稿不退役；其余仍按规则处理 |

「对比 / 恢复」是关键词判定，偏保守：中文里「比较」等词也可能出现在无关语境，
代价只是本次不清理。逐字引用探测同样是保守启发式：命中即放弃清理，未命中**不**
代表用户一定没有提及这版草稿。

探测窗口从用户消息**末尾往前**取最多 256 个 48 字符切片（步长 24，覆盖最近约
6000 字符输入）。更早的输入不在探测范围内。

## 6. 成本上界

`tokens_pruned` 必须精确（与 `context metrics` 使用同一个 `count_context_tokens`），
所以每份待退役草稿要被编码两次。为避免病态长历史拖慢每一轮：

- 单次请求最多处理 `MAX_ELIDED_DRAFT_CHARS_PER_PASS`（120000）字符的待退役草稿，
  超出部分本次保持不变（下一轮仍有机会）；
- 逐字引用探测的切片数上限 `MAX_REFERENCE_PROBES`（256）。

清理**不改变**上下文预算计算（`budget.py`）与工具 schema 预留，只是在同样的
可用输入预算里放入更少的历史正文。

## 7. 指标

被改写的 assistant 消息写入 `metrics["tokens_pruned"]`，随后由
`measure_context_parts` 汇总进 `context_token_breakdown` 之外的
`tokens_pruned` 字段，最终落到 `llm_audit_log.tokens_pruned` 与审计 API。
`tokens_pruned` 与 `context_tokens_estimated` 的前后差**严格相等**，有测试断言。

## 8. 与 compaction 的交互

`build_context_parts` 同时是 `react_agent.maybe_auto_compact` 与
`session_runner.compact()` 的数据源，所以清理后的历史也参与自动压缩判断、
tail 预算与压缩窗口选择。这是一个有意的取舍：

- 所有下游 token 统计（`count_context_tokens(parts)` 触发阈值、
  `select_compaction_window` 的 `source_input_tokens` 与 tail 预算）都基于
  **清理后的同一份视图**，因此彼此自洽：请求真的更小，压缩也按更小的视图判断。
- 代价是压缩 transcript 里，**被退役的旧草稿**会以标记形式进入摘要输入，
  摘要无法复述这些草稿的正文。同一字数范围内最新的 2 份整章草稿仍然在
  transcript 里保持完整，所以被摘要掉的是**已被取代的旧版本**。
- 受影响的是**生成的摘要文本**。`agent_run_messages`、章节正文、revision、
  source snapshot 都没有变化，用户可以随时回看完整草稿。

若后续要让 compaction 走未清理的视图，需要给 `build_context_parts` 增加显式开关
并由压缩调用方传入；本次不改 `session_runner.py` / `react_agent.py`，所以保持现状。

## 9. 已知限制

1. 只覆盖 `measure_text`。其他把整章正文放进参数的工具（例如未来的同类测量工具）
   需要显式登记到 `MEASUREMENT_TOOL_NAMES`，否则不会被清理。
2. 保留粒度是字数范围。作者改了字数要求后，旧范围的草稿会一直保留。
3. 引用探测是逐字重合，不是语义判断。「刚才那版 / 刚才那一版 / 刚才的版本」已加入保留关键词；
   其他无引用的间接指代仍只能依赖有限关键词兜底，不能视为完整语义识别。
4. 字符预算达到上限时，较新的可退役草稿本轮不处理（最旧优先退役）。
5. 清理只作用于模型请求副本。前端历史、导出、持久化记录中仍然保留完整草稿，
   这是刻意的：用户可随时回看与恢复。

## 10. 明确拒绝的做法

- 退役未解决 / 失败 / 待审批的调用：会让 agent 失去自己刚发出的证据。
- 把片段当成整章的替代：片段达标不代表整章达标，`measure_text` 自己就提示过。
- 只保留 1 份最新草稿：无法对比最近两版，牺牲连续性。
- 用摘要或改写文本替换正文：等于伪造 manuscript。
- 修改 tool 结果、`tool_call_id` 或删掉工具调用：破坏提供商要求的 tool-call 配对，
  也破坏审批与快照的对应关系。
- 回写持久化历史：本任务是上下文 ROI 修复，不是数据迁移。

## 11. 测试

`backend/tests/agent_runtime/context/processors/test_measurement_gc.py`：

- `test_keeps_two_latest_full_drafts_per_range_and_elides_the_rest`
- `test_elided_args_keep_provider_shape_and_report_measured_size`
- `test_processing_never_mutates_input_messages_or_tool_results`
- `test_tool_call_ids_still_pair_with_untouched_tool_results`
- `test_pending_and_failed_measurements_are_never_elided`
- `test_small_fragment_probes_are_kept_and_do_not_fill_retention_slots`
- `test_user_quoting_an_older_draft_disables_that_elision`
- `test_other_drafts_are_still_elided_when_only_one_draft_is_quoted`
- `test_compare_or_restore_requests_disable_pruning`（参数化 4 种表述）
- `test_elision_budget_bounds_the_work_of_a_single_pass`
- `test_different_word_ranges_do_not_supersede_each_other`
- `test_non_measurement_tools_sharing_a_message_with_an_elided_call_are_untouched`
- `test_user_text_and_author_constraints_are_never_touched`
- `test_tokens_pruned_metric_matches_context_metrics_delta`
- `test_measurement_history_gc_benchmark_is_deterministic`（合成基准，见 §1）

`backend/tests/agent_runtime/context/test_build_context.py`：

- `test_build_context_retires_obsolete_measurement_inputs`
- `test_build_context_skips_measurement_gc_when_setting_disabled`

基准完全本地、确定性（固定随机种子），不调用任何付费 API。
