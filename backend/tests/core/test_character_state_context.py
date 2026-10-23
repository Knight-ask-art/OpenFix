# -*- coding: utf-8 -*-
"""人物状态 opt-in 渲染的纯内存回归测试。

只测试纯渲染：项目隔离、章节锚点解析与数据库读取由工具层测试覆盖。
这里固定四件事：

1. 静态描述与章级状态分开，章级状态带真实来源与请求锚点；
2. 来源早于锚点时显式标注「最近记录，非本章新确认」；缺失即未知，不用
   后章或项目级常设状态填补；
3. 空字段（unknown_fields）与因预算整项省略的字段（omitted_fields）分开；
4. 整份 opt-in JSON（含名称、描述）受固定字符 / token 上限约束，巨大记录
   在有限次尝试内返回，字段只在整项层面装入或省略。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from app.core.character_state_context import (
    DESCRIPTION_OMITTED_NOTE,
    MAX_CONTEXT_CHARS,
    MAX_CONTEXT_TOKENS,
    PRIOR_SOURCE_NOTE,
    PROJECT_STATE_NOTE,
    STATE_FIELD_ORDER,
    ChapterAnchor,
    StateAtAnchor,
    render_character_state_context,
)

ANCHOR = ChapterAnchor(
    chapter_id="chapter-v1c2",
    chapter_title="渡口",
    chapter_order=2,
    volume_id="volume-1",
    volume_title="第一卷",
    volume_order=1,
)


def _source(
    state_id: str = "state-v1c2",
    chapter_id: str = "chapter-v1c2",
    chapter_title: str = "渡口",
    chapter_order: int = 2,
    volume_id: str = "volume-1",
    volume_title: str = "第一卷",
    volume_order: int = 1,
    **values: str,
) -> StateAtAnchor:
    fields = {field: "" for field in STATE_FIELD_ORDER}
    fields.update(values)
    return StateAtAnchor(
        state=SimpleNamespace(
            id=state_id,
            character_id="char-1",
            project_id="project-1",
            chapter_id=chapter_id,
            **fields,
        ),
        chapter_id=chapter_id,
        chapter_title=chapter_title,
        chapter_order=chapter_order,
        volume_id=volume_id,
        volume_title=volume_title,
        volume_order=volume_order,
    )


def _render(**overrides) -> str:
    kwargs = {
        "character_id": "char-1",
        "character_name": "林舟",
        "description": "1|镖师",
        "chapter_source": None,
        "anchor": None,
        "token_counter": len,
    }
    kwargs.update(overrides)
    return render_character_state_context(**kwargs)


def _payload(**overrides) -> dict:
    return json.loads(_render(**overrides))


def _assert_budget_exact(payload: dict, text: str) -> None:
    budget = payload["state_context"]["budget"]
    assert budget["max_chars"] == MAX_CONTEXT_CHARS
    assert budget["max_tokens"] == MAX_CONTEXT_TOKENS
    assert budget["chars"] == len(text)
    assert budget["tokens"] == len(text)
    assert len(text) <= MAX_CONTEXT_CHARS
    assert len(text) <= MAX_CONTEXT_TOKENS


def test_static_description_and_recorded_chapter_state_are_separated() -> None:
    payload = _payload(
        chapter_source=_source(physical_state="左肩受伤", location="渡口"),
        anchor=ANCHOR,
    )

    assert payload["name"] == "林舟"
    assert payload["description"] == "1|镖师"
    assert payload["description_kind"] == "static_profile"
    context = payload["state_context"]
    assert context["status"] == "ok"
    assert context["character_id"] == "char-1"
    assert context["budget"]["truncated"] is False
    assert context["scope"] == {
        "chapter_id": "chapter-v1c2",
        "chapter_label": "第1卷第2章 渡口",
        "chapter_order": 2,
        "volume_id": "volume-1",
        "volume_order": 1,
        "chapter_title": "渡口",
        "volume_title": "第一卷",
    }

    chapter_state = context["chapter_state"]
    assert chapter_state["source"] == "character_state"
    assert chapter_state["time_applicability"] == "chapter"
    assert chapter_state["state_id"] == "state-v1c2"
    assert chapter_state["is_exact_anchor"] is True
    assert chapter_state["chapter_id"] == "chapter-v1c2"
    assert chapter_state["volume_order"] == 1
    assert chapter_state["chapter_order"] == 2
    assert chapter_state["fields"] == {"physical_state": "左肩受伤", "location": "渡口"}
    assert chapter_state["unknown_fields"] == [
        "mental_state", "goal", "relationship_note", "notes"
    ]
    assert chapter_state["omitted_fields"] == []
    assert "本章已保存记录" in chapter_state["provenance_note"]

    # 不再展开 15 个档案字段，也不输出项目级常设状态或信念 / 世界事实。
    assert "static_profile" not in context
    assert "project_state" not in context
    assert "beliefs" not in context
    assert context["separate_tools"]["character_beliefs"].startswith("read_narrative_state")
    assert context["separate_tools"]["world_facts"].startswith("read_narrative_state")
    assert PROJECT_STATE_NOTE in context["unknowns"]


def test_prior_source_keeps_real_source_separate_from_requested_anchor() -> None:
    prior = _source(
        state_id="state-v1c1",
        chapter_id="chapter-v1c1",
        chapter_title="雨夜",
        chapter_order=1,
        physical_state="手腕轻伤",
    )

    context = _payload(chapter_source=prior, anchor=ANCHOR)["state_context"]

    chapter_state = context["chapter_state"]
    assert chapter_state["state_id"] == "state-v1c1"
    assert chapter_state["is_exact_anchor"] is False
    # 实际来源与请求锚点各自独立，不能把来源冒充成锚点。
    assert chapter_state["chapter_id"] == "chapter-v1c1"
    assert chapter_state["chapter_label"] == "第1卷第1章 雨夜"
    assert chapter_state["requested_anchor"]["chapter_id"] == "chapter-v1c2"
    assert chapter_state["requested_anchor"]["chapter_label"] == "第1卷第2章 渡口"
    assert PRIOR_SOURCE_NOTE in chapter_state["provenance_note"]
    assert context["scope"]["chapter_id"] == "chapter-v1c2"
    assert any(
        PRIOR_SOURCE_NOTE in note and "第1卷第1章 雨夜" in note for note in context["unknowns"]
    )


def test_prior_volume_with_repeated_chapter_order_is_source_not_anchor() -> None:
    prior = _source(
        state_id="state-v1c2",
        chapter_id="chapter-v1c2",
        chapter_title="渡口",
        chapter_order=2,
        physical_state="旧伤",
    )
    anchor = ChapterAnchor(
        chapter_id="chapter-v2c2",
        chapter_title="王都",
        chapter_order=2,
        volume_id="volume-2",
        volume_title="第二卷",
        volume_order=2,
    )

    chapter_state = _payload(chapter_source=prior, anchor=anchor)["state_context"]["chapter_state"]

    assert chapter_state["is_exact_anchor"] is False
    assert chapter_state["chapter_label"] == "第1卷第2章 渡口"
    assert chapter_state["requested_anchor"]["chapter_label"] == "第2卷第2章 王都"
    assert chapter_state["volume_order"] == 1
    assert chapter_state["requested_anchor"]["volume_order"] == 2


def test_missing_record_at_anchor_is_unknown_not_backfilled() -> None:
    payload = _payload(description="", anchor=ANCHOR)

    context = payload["state_context"]
    assert payload["description"] is None
    assert context["status"] == "no_records"
    assert context["chapter_state"] is None
    assert context["scope"]["chapter_id"] == "chapter-v1c2"
    assert any(
        "第1卷第2章 渡口 的章级状态：未记录" in note
        and "后续章节与项目级状态不会代替" in note
        for note in context["unknowns"]
    )


def test_no_anchor_returns_no_chapter_state() -> None:
    context = _payload()["state_context"]

    assert context["status"] == "ok"
    assert context["scope"] is None
    assert context["chapter_state"] is None
    assert any("未提供章节锚点" in note for note in context["unknowns"])


def test_unknown_fields_are_distinct_from_budget_omitted_fields() -> None:
    huge_notes = "雨夜" * 5_000
    payload = _payload(
        chapter_source=_source(physical_state="左肩受伤", mental_state="", notes=huge_notes),
        anchor=ANCHOR,
    )
    text = json.dumps(payload, ensure_ascii=False)

    chapter_state = payload["state_context"]["chapter_state"]
    assert chapter_state["fields"]["physical_state"] == "左肩受伤"
    assert "mental_state" in chapter_state["unknown_fields"]
    # 巨大字段整项省略，不会以半截文本出现。
    assert "notes" in chapter_state["omitted_fields"]
    assert "notes" not in chapter_state["fields"]
    assert "notes" not in chapter_state["unknown_fields"]
    assert huge_notes[:50] not in text
    assert payload["state_context"]["status"] == "truncated"
    assert payload["state_context"]["budget"]["truncated"] is True


def test_whole_state_field_is_kept_or_omitted_without_losing_negation() -> None:
    negation = "身体状况稳定，并未死亡，意识清醒。"
    small = _payload(chapter_source=_source(notes=negation), anchor=ANCHOR)
    small_state = small["state_context"]["chapter_state"]
    assert small_state["fields"]["notes"] == negation
    assert small_state["omitted_fields"] == []

    huge = "伤势记录：" + "平稳。" * 3_000 + negation
    large = _payload(chapter_source=_source(notes=huge), anchor=ANCHOR)
    large_text = json.dumps(large, ensure_ascii=False)
    large_state = large["state_context"]["chapter_state"]
    assert "notes" in large_state["omitted_fields"]
    assert "notes" not in large_state["fields"]
    # 整项省略：不会保留半句，也不会只留下否定词后缀造成误导。
    assert "伤势记录" not in large_text


def test_giant_record_is_finite_and_whole_output_is_hard_bounded() -> None:
    huge = "旧事" * 200_000
    text = _render(
        character_name="极长名字" * 500,
        description="\n".join("描述内容" * 20 for _ in range(5_000)),
        chapter_source=_source(
            physical_state="左肩受伤",
            location="渡口",
            mental_state=huge,
            goal=huge,
            relationship_note=huge,
            notes=huge,
        ),
        anchor=ANCHOR,
    )
    payload = json.loads(text)

    _assert_budget_exact(payload, text)
    context = payload["state_context"]
    assert context["status"] == "truncated"
    assert context["budget"]["truncated"] is True
    # 名称与描述超长时整项省略并显式标注。
    assert payload["name"] is None
    assert payload["name_omitted"] is True
    assert payload["description"] is None
    assert payload["description_omitted"] is True
    assert DESCRIPTION_OMITTED_NOTE in context["unknowns"]
    # 来源与优先级最高的身体 / 地点状态完整保留。
    chapter_state = context["chapter_state"]
    assert chapter_state["chapter_id"] == "chapter-v1c2"
    assert chapter_state["requested_anchor"]["chapter_id"] == "chapter-v1c2"
    assert chapter_state["fields"]["physical_state"] == "左肩受伤"
    assert chapter_state["fields"]["location"] == "渡口"
    assert set(chapter_state["omitted_fields"]) == {
        "mental_state", "goal", "relationship_note", "notes"
    }
    # 巨大文本没有被截半输出。
    assert "旧事" not in text


def test_token_cap_is_hard_independently_of_char_cap() -> None:
    def counter(value: str) -> int:
        return len(value) * 2

    description = "描述" * 2_000
    text = _render(
        description=description,
        chapter_source=_source(physical_state="x" * 500),
        anchor=ANCHOR,
        token_counter=counter,
    )
    payload = json.loads(text)
    context = payload["state_context"]

    assert counter(text) <= MAX_CONTEXT_TOKENS
    assert len(text) <= MAX_CONTEXT_CHARS
    assert context["budget"]["tokens"] == counter(text)
    assert context["budget"]["chars"] == len(text)
    # 字符上限单独看完全装得下描述与身体状态，触发省略的是 token 上限。
    assert len(text) + len(description) + 500 < MAX_CONTEXT_CHARS
    assert payload["description"] is None
    assert payload["description_omitted"] is True
    assert DESCRIPTION_OMITTED_NOTE in context["unknowns"]
    assert "physical_state" in context["chapter_state"]["omitted_fields"]
    assert "physical_state" not in context["chapter_state"]["fields"]


def test_len_counter_boundary_keeps_complete_metadata_within_token_cap() -> None:
    huge = "伤" * 8_000
    text = _render(
        description="D" * 8_000,
        chapter_source=_source(
            physical_state="x" * 1_240,
            location=huge,
            mental_state=huge,
            goal=huge,
            relationship_note=huge,
            notes=huge,
        ),
        anchor=ANCHOR,
        token_counter=len,
    )
    payload = json.loads(text)

    assert len(text) <= MAX_CONTEXT_TOKENS
    assert payload["state_context"]["budget"]["tokens"] == len(text)
    assert payload["description"] is None
    assert payload["state_context"]["chapter_state"]["fields"]["physical_state"] == "x" * 1_240


def test_actual_tokenizer_budget_includes_final_metadata_and_omitted_fields() -> None:
    from app.core.utils.tiktoken import count_tokens

    anchor = ChapterAnchor("c", "C", 1, "v", "V", 1)
    huge = "伤" * 8_000
    source = StateAtAnchor(
        state=SimpleNamespace(
            id="s",
            character_id="x",
            physical_state="肩" * 2_100,
            location=huge,
            mental_state=huge,
            goal=huge,
            relationship_note=huge,
            notes=huge,
        ),
        chapter_id="c",
        chapter_title="C",
        chapter_order=1,
        volume_id="v",
        volume_title="V",
        volume_order=1,
    )

    text = render_character_state_context(
        character_id="x",
        character_name="X",
        description="D" * 8_000,
        chapter_source=source,
        anchor=anchor,
    )
    payload = json.loads(text)

    assert len(text) <= MAX_CONTEXT_CHARS
    assert count_tokens(text) <= MAX_CONTEXT_TOKENS
    assert payload["state_context"]["budget"]["chars"] == len(text)
    assert payload["state_context"]["budget"]["tokens"] == count_tokens(text)
    assert huge not in text


def test_small_envelope_without_fields_stays_within_fixed_caps() -> None:
    text = _render(description="", chapter_source=_source(), anchor=ANCHOR)
    payload = json.loads(text)

    _assert_budget_exact(payload, text)
    context = payload["state_context"]
    assert context["status"] == "ok"
    assert context["chapter_state"]["fields"] == {}
    assert context["chapter_state"]["unknown_fields"] == list(STATE_FIELD_ORDER)
    assert context["chapter_state"]["omitted_fields"] == []
    assert context["budget"]["truncated"] is False


def test_long_titles_are_omitted_while_ids_and_orders_are_kept() -> None:
    context = _payload(
        chapter_source=_source(
            state_id="state-prior",
            chapter_id="chapter-prior",
            chapter_title="长标题" * 100,
            chapter_order=1,
            volume_title="长卷名" * 100,
            physical_state="左肩受伤",
        ),
        anchor=ANCHOR,
    )["state_context"]
    request_anchor = context["chapter_state"]["requested_anchor"]
    chapter_state = context["chapter_state"]

    assert "chapter_title" not in chapter_state
    assert "volume_title" not in chapter_state
    assert chapter_state["title_omitted"] is True
    assert chapter_state["chapter_id"] == "chapter-prior"
    assert chapter_state["fields"]["physical_state"] == "左肩受伤"
    # 请求锚点（短标题）照常带标题，来源标题超长则整项省略。
    assert request_anchor["chapter_label"] == "第1卷第2章 渡口"
    assert request_anchor["chapter_title"] == "渡口"
    assert chapter_state["volume_order"] == 1
    assert chapter_state["chapter_order"] == 1
    assert context["budget"]["truncated"] is True


def test_oversized_fixed_metadata_fails_closed() -> None:
    import pytest

    huge_id = "x" * 10_000
    anchor = ChapterAnchor(
        chapter_id=huge_id,
        chapter_title="渡口",
        chapter_order=2,
        volume_id="volume-1",
        volume_title="第一卷",
        volume_order=1,
    )

    with pytest.raises(ValueError) as exc_info:
        _render(description="", anchor=anchor)

    message = str(exc_info.value)
    assert message == "character state metadata exceeds read budget"
    assert huge_id not in message
    assert "novel" not in message.casefold()
