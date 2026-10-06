"""Tests for the deterministic measure_text tool."""

import json
from typing import Any

from app.agent_runtime.agents.definitions import get_default_agent_definition
from app.agent_runtime.agents.tool_categories import get_tool_names_for_categories
from app.agent_runtime.tools.impls.chapter.measure_text import (
    COUNTING_METHOD,
    MAX_MEASURE_TEXT_CHARACTERS,
    MeasureTextTool,
)
from app.agent_runtime.tools.permission_metadata import (
    get_default_agent_tool_permissions,
    get_default_tool_permission_mode,
)
from app.agent_runtime.tools.registry import ToolRegistry
from app.core.word_count import count_words


def _make_state() -> dict:
    return {
        "session_id": "sess-1",
        "task_id": "task-1",
        "project_id": "proj-1",
        "model_config": {},
        "active_agent": None,
        "is_completed": False,
        "error": None,
        "retry_count": 0,
        "message_checkpoints": [],
        "user_request": "",
        "current_revision_id": "rev-1",
    }


async def _measure(**kwargs: Any) -> dict:
    tool = MeasureTextTool(_state=_make_state())
    result = await tool.ainvoke(kwargs)
    return json.loads(result)


def test_measure_text_is_registered_with_schema_and_default_permission() -> None:
    tool = ToolRegistry.get_tools(names=["measure_text"], state=_make_state())[0]

    schema = tool.args_schema.model_json_schema()

    assert tool.name == "measure_text"
    assert tool.access_level == "readonly"
    assert set(schema["properties"].keys()) == {"text", "min_words", "max_words"}
    assert schema["required"] == ["text"]
    for field_name in ("text", "min_words", "max_words"):
        assert schema["properties"][field_name]["description"]
    assert get_default_tool_permission_mode("measure_text") == "allow"
    assert {"tool_name": "measure_text", "mode": "allow"} in (
        get_default_agent_tool_permissions()
    )


def test_measure_text_is_registered_in_tool_display_order() -> None:
    """未登记在展示顺序里的工具不会出现在 /agent/tools 中，必须一并登记。"""
    from app.api.routers.agent_runtime import TOOL_DISPLAY_ORDER

    assert "measure_text" in TOOL_DISPLAY_ORDER
    assert (
        TOOL_DISPLAY_ORDER["read_chapter"]
        < TOOL_DISPLAY_ORDER["measure_text"]
        < TOOL_DISPLAY_ORDER["search_chapters"]
    )


def test_measure_text_expands_from_chapter_read_for_default_agents() -> None:
    assert "measure_text" in get_tool_names_for_categories(["chapter_read"])

    for agent_key in (
        "build",
        "plan",
        "explore",
        "composer",
        "auditor",
        "writer",
        "actor",
        "reviewer",
    ):
        definition = get_default_agent_definition(agent_key)
        assert "measure_text" in get_tool_names_for_categories(
            definition.enabled_tool_categories
        )


async def test_measure_text_counts_text_with_project_word_counter() -> None:
    text = "他推开门。The night was cold."

    data = await _measure(text=text)

    assert "word_count" in data
    assert data["word_count"] == count_words(text)
    assert data["range"] is None
    assert data["within_range"] is None
    assert data["counting_method"] == COUNTING_METHOD


async def test_measure_text_counts_chinese_characters_without_range() -> None:
    data = await _measure(text="你好世界")

    assert data["word_count"] == 4
    assert data["within_range"] is None
    assert "revision" not in data


async def test_measure_text_guides_one_bounded_length_revision() -> None:
    data = await _measure(text="字" * 3479, min_words=2800, max_words=3200)
    assert data["revision"]["target_words"] == 3000
    assert data["revision"]["word_delta"] == -479
    assert data["revision"]["minimum_change_words"] == 279
    assert "不能机械截断" in data["revision"]["guidance"]
    assert "片段达标不代表整章达标" in data["revision"]["guidance"]


async def test_measure_text_revision_supports_single_bound_and_empty_text() -> None:
    short = await _measure(text="", min_words=10)
    assert short["revision"]["word_delta"] == 10
    assert short["revision"]["minimum_change_words"] == 10
    long = await _measure(text="字" * 12, max_words=10)
    assert long["revision"]["target_words"] == 10
    assert long["revision"]["word_delta"] == -2
    valid = await _measure(text="字" * 10, min_words=10, max_words=10)
    assert "revision" not in valid


async def test_measure_text_treats_empty_text_as_zero() -> None:
    data = await _measure(text="", min_words=0)

    assert data["word_count"] == 0
    assert data["within_range"] is True


async def test_measure_text_checks_min_and_max_boundaries_inclusively() -> None:
    text = "一二三四五"
    word_count = count_words(text)
    assert word_count == 5

    at_min = await _measure(text=text, min_words=word_count)
    assert at_min["range"] == {"min_words": 5, "max_words": None}
    assert at_min["within_range"] is True

    below_min = await _measure(text=text, min_words=word_count + 1)
    assert below_min["within_range"] is False

    at_max = await _measure(text=text, max_words=word_count)
    assert at_max["range"] == {"min_words": None, "max_words": 5}
    assert at_max["within_range"] is True

    above_max = await _measure(text=text, max_words=word_count - 1)
    assert above_max["within_range"] is False


async def test_measure_text_requires_both_bounds_when_range_is_given() -> None:
    data = await _measure(text="一二三四五六七八九十", min_words=3, max_words=20)

    assert data["range"] == {"min_words": 3, "max_words": 20}
    assert data["within_range"] is True

    outside = await _measure(text="一二三四五六七八九十", min_words=3, max_words=9)
    assert outside["within_range"] is False


async def test_measure_text_does_not_echo_manuscript_text() -> None:
    text = "独一无二的正文标记串甲乙丙丁"

    data = await _measure(text=text, min_words=1, max_words=2)

    serialized = json.dumps(data, ensure_ascii=False)
    assert text not in serialized
    assert "独一无二" not in serialized


async def test_measure_text_accepts_text_at_character_limit() -> None:
    text = "字" * MAX_MEASURE_TEXT_CHARACTERS

    data = await _measure(text=text, max_words=MAX_MEASURE_TEXT_CHARACTERS)

    assert data["word_count"] == count_words(text)
    assert data["within_range"] is True


async def test_measure_text_rejects_text_over_character_limit() -> None:
    text = "字" * (MAX_MEASURE_TEXT_CHARACTERS + 1)

    data = await _measure(text=text)

    assert data["type"] == "fail"
    assert data["success"] is False
    assert data["code"] == "limit_exceeded"
    assert str(MAX_MEASURE_TEXT_CHARACTERS) in data["message"]
    assert text not in data["message"]


async def test_measure_text_rejects_inverted_range() -> None:
    data = await _measure(text="一二三四五", min_words=10, max_words=5)

    assert data["type"] == "fail"
    assert data["code"] == "validation_error"
    assert "10" in data["message"]
    assert "5" in data["message"]
    assert "一二三四五" not in data["message"]


async def test_measure_text_rejects_negative_bounds() -> None:
    negative_min = await _measure(text="一二三四五", min_words=-1)
    negative_max = await _measure(text="一二三四五", max_words=-1)

    assert negative_min["type"] == "fail"
    assert negative_min["code"] == "validation_error"
    assert negative_max["type"] == "fail"
    assert negative_max["code"] == "validation_error"
