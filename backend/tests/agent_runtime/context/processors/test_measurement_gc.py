"""measurement_gc 的行为测试与确定性 token 基准。

基准只用本地 tokenizer 统计模型请求本身的体积，不代表任何提供商计费、
缓存命中或生成质量结论。
"""

import copy
import json
import random

import pytest

from app.agent_runtime.context.compaction.tokens import count_context_tokens
from app.agent_runtime.context.metrics import measure_context_parts
from app.agent_runtime.context.processors.measurement_gc import (
    MIN_FULL_DRAFT_WORDS,
    RETAIN_LATEST_FULL_DRAFTS,
    prune_obsolete_measurement_inputs,
)
from app.agent_runtime.context.types import ContextMessage
from app.core.word_count import count_words

_CHAPTER_CHARS = (
    "的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里"
    "后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第"
    "样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位"
)

_RANGE = (2500, 3500)


def _draft(seed: int, words: int = 1200) -> str:
    """确定性生成指定字数的中文草稿，保证 count_words 与字数一致。"""
    rng = random.Random(seed)
    text = "".join(rng.choice(_CHAPTER_CHARS) for _ in range(words))
    assert count_words(text) == words
    return text


def _call(
    call_id: str,
    draft: str,
    min_words: int | None = _RANGE[0],
    max_words: int | None = _RANGE[1],
) -> dict:
    return {
        "id": call_id,
        "name": "measure_text",
        "args": {"text": draft, "min_words": min_words, "max_words": max_words},
    }


def _result_message(
    call_id: str,
    word_count: int,
    min_words: int | None = _RANGE[0],
    max_words: int | None = _RANGE[1],
) -> ContextMessage:
    return ContextMessage(
        role="tool",
        name="measure_text",
        tool_call_id=call_id,
        content=json.dumps(
            {
                "word_count": word_count,
                "range": {"min_words": min_words, "max_words": max_words},
                "within_range": True,
                "counting_method": "app.core.word_count.count_words",
            },
            ensure_ascii=False,
        ),
    )


def _measured_pair(
    index: int,
    draft: str,
    *,
    min_words: int | None = _RANGE[0],
    max_words: int | None = _RANGE[1],
) -> list[ContextMessage]:
    call_id = f"call_{index}"
    return [
        ContextMessage(
            role="assistant",
            content="",
            tool_calls=[_call(call_id, draft, min_words, max_words)],
            metadata={"part": "history"},
        ),
        _result_message(call_id, count_words(draft), min_words, max_words),
    ]


def _drafts_of(messages: list[ContextMessage]) -> dict[str, str]:
    return {
        call["id"]: call["args"]["text"]
        for message in messages
        if message.role == "assistant"
        for call in message.tool_calls or []
    }


def _ordered_pairs(count: int) -> tuple[list[str], list[ContextMessage]]:
    drafts = [_draft(seed) for seed in range(count)]
    messages: list[ContextMessage] = []
    for index, draft in enumerate(drafts):
        messages.extend(_measured_pair(index, draft))
    return drafts, messages


def test_keeps_two_latest_full_drafts_per_range_and_elides_the_rest() -> None:
    drafts, messages = _ordered_pairs(5)

    result = prune_obsolete_measurement_inputs(messages)

    kept = _drafts_of(result.messages)
    assert result.drafts_elided == len(drafts) - RETAIN_LATEST_FULL_DRAFTS
    assert result.tokens_pruned > 0
    for index in range(3):
        assert kept[f"call_{index}"] != drafts[index]
    for index in range(3, 5):
        assert kept[f"call_{index}"] == drafts[index]


def test_elided_args_keep_provider_shape_and_report_measured_size() -> None:
    drafts, messages = _ordered_pairs(4)

    result = prune_obsolete_measurement_inputs(messages)

    first = result.messages[0].tool_calls[0]
    assert set(first) == {"id", "name", "args"}
    assert first["id"] == "call_0"
    assert first["name"] == "measure_text"
    assert first["args"]["min_words"] == _RANGE[0]
    assert first["args"]["max_words"] == _RANGE[1]
    marker = first["args"]["text"]
    assert isinstance(marker, str)
    assert str(count_words(drafts[0])) in marker
    assert drafts[0] not in marker
    assert len(marker) < len(drafts[0])


def test_processing_never_mutates_input_messages_or_tool_results() -> None:
    _, messages = _ordered_pairs(4)
    snapshot = copy.deepcopy(messages)

    result = prune_obsolete_measurement_inputs(messages)

    assert result.messages is not messages
    assert messages == snapshot


def test_tool_call_ids_still_pair_with_untouched_tool_results() -> None:
    _, messages = _ordered_pairs(4)
    before_results = [
        (message.tool_call_id, message.content)
        for message in messages
        if message.role == "tool"
    ]

    result = prune_obsolete_measurement_inputs(messages)

    assert [
        (message.tool_call_id, message.content)
        for message in result.messages
        if message.role == "tool"
    ] == before_results
    assert [
        call["id"]
        for message in result.messages
        if message.role == "assistant"
        for call in message.tool_calls or []
    ] == [call_id for call_id, _ in before_results]


def test_pending_and_failed_measurements_are_never_elided() -> None:
    pending = _draft(11)
    failed = _draft(12)
    errored = _draft(13)
    messages: list[ContextMessage] = [
        # 未配对：调用仍待解决。
        ContextMessage(
            role="assistant",
            content="",
            tool_calls=[_call("call_pending", pending)],
            metadata={"part": "history"},
        ),
        # 已配对但工具返回硬失败文本。
        ContextMessage(
            role="assistant",
            content="",
            tool_calls=[_call("call_failed", failed)],
            metadata={"part": "history"},
        ),
        ContextMessage(
            role="tool",
            name="measure_text",
            tool_call_id="call_failed",
            content="文本长度 60000 字符，超过单次测量上限 48000 字符。",
        ),
        # 已配对但结果是失败 JSON。
        ContextMessage(
            role="assistant",
            content="",
            tool_calls=[_call("call_error", errored)],
            metadata={"part": "history"},
        ),
        ContextMessage(
            role="tool",
            name="measure_text",
            tool_call_id="call_error",
            content=json.dumps(
                {"type": "fail", "success": False, "error": "measure_failed"},
                ensure_ascii=False,
            ),
        ),
    ]
    drafts, pairs = _ordered_pairs(3)
    messages.extend(pairs)

    result = prune_obsolete_measurement_inputs(messages)

    kept = _drafts_of(result.messages)
    assert kept["call_pending"] == pending
    assert kept["call_failed"] == failed
    assert kept["call_error"] == errored
    # 未解决、失败的调用不占用保留名额：3 个整章仍只保留最新 2 个。
    assert result.drafts_elided == 1
    assert kept["call_0"] != drafts[0]
    assert kept["call_1"] == drafts[1]
    assert kept["call_2"] == drafts[2]


def test_small_fragment_probes_are_kept_and_do_not_fill_retention_slots() -> None:
    drafts, messages = _ordered_pairs(3)
    fragment_5 = _draft(90, words=5)
    fragment_552 = _draft(91, words=552)
    assert count_words(fragment_552) < MIN_FULL_DRAFT_WORDS
    messages.extend(_measured_pair(90, fragment_5))
    messages.extend(_measured_pair(91, fragment_552))

    result = prune_obsolete_measurement_inputs(messages)

    kept = _drafts_of(result.messages)
    assert kept["call_90"] == fragment_5
    assert kept["call_91"] == fragment_552
    assert result.drafts_elided == 1
    assert kept["call_0"] != drafts[0]
    assert kept["call_1"] == drafts[1]
    assert kept["call_2"] == drafts[2]


def test_user_quoting_an_older_draft_disables_that_elision() -> None:
    drafts, messages = _ordered_pairs(3)
    quoted = drafts[0]
    messages.append(
        ContextMessage(role="user", content=f"请沿用这段开头：{quoted[100:260]}")
    )

    result = prune_obsolete_measurement_inputs(messages)

    assert result.drafts_elided == 0
    assert result.messages is messages
    assert _drafts_of(result.messages)["call_0"] == quoted


def test_other_drafts_are_still_elided_when_only_one_draft_is_quoted() -> None:
    drafts, messages = _ordered_pairs(4)
    messages.append(ContextMessage(role="user", content=f"参考：{drafts[0][40:200]}"))

    result = prune_obsolete_measurement_inputs(messages)

    kept = _drafts_of(result.messages)
    assert result.drafts_elided == 1
    assert kept["call_0"] == drafts[0]
    assert kept["call_1"] != drafts[1]


@pytest.mark.parametrize(
    "request_text",
    [
        "把第三版和第四版对比一下",
        "恢复到上一版的结尾",
        "用你刚才那版，不用现在这版",
        "保留刚才那一版",
        "采用刚才的版本",
        "please compare the two drafts",
        "restore the earlier draft",
    ],
)
def test_compare_or_restore_requests_disable_pruning(request_text: str) -> None:
    _, messages = _ordered_pairs(4)
    messages.append(ContextMessage(role="user", content=request_text))

    result = prune_obsolete_measurement_inputs(messages)

    assert result.drafts_elided == 0
    assert result.tokens_pruned == 0
    assert result.messages is messages


def test_elision_budget_bounds_the_work_of_a_single_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drafts, messages = _ordered_pairs(5)
    monkeypatch.setattr(
        "app.agent_runtime.context.processors.measurement_gc"
        ".MAX_ELIDED_DRAFT_CHARS_PER_PASS",
        len(drafts[0]) + 10,
    )

    result = prune_obsolete_measurement_inputs(messages)

    kept = _drafts_of(result.messages)
    assert result.drafts_elided == 1
    assert kept["call_0"] != drafts[0]
    for index in range(1, 5):
        assert kept[f"call_{index}"] == drafts[index]


def test_different_word_ranges_do_not_supersede_each_other() -> None:
    messages: list[ContextMessage] = []
    for index in range(2):
        messages.extend(_measured_pair(index, _draft(index)))
    for index in range(10, 12):
        messages.extend(
            _measured_pair(index, _draft(index), min_words=5000, max_words=6000)
        )

    result = prune_obsolete_measurement_inputs(messages)

    assert result.drafts_elided == 0


def test_non_measurement_tools_sharing_a_message_with_an_elided_call_are_untouched() -> (
    None
):
    drafts, messages = _ordered_pairs(4)
    chapter_text = _draft(30)
    messages[0].tool_calls.append(
        {
            "id": "call_read",
            "name": "read_chapter",
            "args": {"order": 3, "text": chapter_text},
        }
    )
    messages.insert(
        1,
        ContextMessage(
            role="tool",
            name="read_chapter",
            tool_call_id="call_read",
            content=json.dumps({"content": chapter_text}, ensure_ascii=False),
        ),
    )

    result = prune_obsolete_measurement_inputs(messages)

    kept = _drafts_of(result.messages)
    assert kept["call_0"] != drafts[0]
    assert kept["call_read"] == chapter_text
    assert [call["id"] for call in result.messages[0].tool_calls] == [
        "call_0",
        "call_read",
    ]


def test_user_text_and_author_constraints_are_never_touched() -> None:
    user_text = _draft(40)
    messages: list[ContextMessage] = [
        ContextMessage(role="user", content=user_text),
        ContextMessage(role="system", content="每章 2500-3500 字"),
    ]
    messages.extend(_ordered_pairs(4)[1])

    result = prune_obsolete_measurement_inputs(messages)

    assert result.messages[0].content == user_text
    assert result.messages[1].content == "每章 2500-3500 字"


def test_tokens_pruned_metric_matches_context_metrics_delta() -> None:
    _, messages = _ordered_pairs(5)

    before = measure_context_parts(copy.deepcopy(messages))
    pruned = prune_obsolete_measurement_inputs(messages)
    after = measure_context_parts(pruned.messages)

    assert before["tokens_pruned"] == 0
    assert pruned.tokens_pruned > 0
    assert after["tokens_pruned"] == pruned.tokens_pruned
    assert (
        before["context_tokens_estimated"] - after["context_tokens_estimated"]
        == pruned.tokens_pruned
    )


def test_measurement_history_gc_benchmark_is_deterministic() -> None:
    """合成基准：6 版 3200 字章节草稿，用真实 tokenizer 统计请求体积。"""
    revisions = 6
    drafts = [_draft(seed, words=3200) for seed in range(revisions)]
    messages: list[ContextMessage] = [
        ContextMessage(role="system", content="你是长篇小说写作助手。"),
        ContextMessage(role="user", content="写第 3 章，2500-3500 字。"),
    ]
    for index, draft in enumerate(drafts):
        messages.extend(_measured_pair(index, draft))

    before_tokens = count_context_tokens(messages)
    result = prune_obsolete_measurement_inputs(messages)
    after_tokens = count_context_tokens(result.messages)

    assert result.drafts_elided == revisions - RETAIN_LATEST_FULL_DRAFTS
    assert result.tokens_pruned == before_tokens - after_tokens
    assert after_tokens < before_tokens
    print(
        "measurement-gc benchmark:"
        f" revisions={revisions} draft_words=3200"
        f" before={before_tokens} after={after_tokens}"
        f" saved={result.tokens_pruned}"
        f" ratio={(before_tokens - after_tokens) / before_tokens:.3f}"
        f" elided={result.drafts_elided}"
    )
