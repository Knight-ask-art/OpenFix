"""Focused tests for context token measurement and safe cleanup."""

import pytest
from pydantic import BaseModel, ConfigDict
from unittest.mock import AsyncMock

from app.agent_runtime.context.budget import (
    calculate_context_budget,
    retrieval_token_budget,
)
from app.agent_runtime.context.metrics import (
    measure_context_parts,
    stable_context_fingerprint,
)
from app.agent_runtime.context.processors.soft_gc import (
    SETTING_KEY_SOFT_GC_TOOL_RESULTS,
    is_soft_gc_tool_results_enabled,
    soft_prune_duplicate_tool_results,
)
from app.agent_runtime.context.types import ContextMessage
from langchain_core.tools import StructuredTool

from app.agent_runtime.tools.schema import (
    count_tool_schema_tokens,
    serialize_tool_schemas,
    tool_schema_json,
)


def _noop(query: str) -> str:
    return query


def test_budget_reserves_output_reasoning_margin_and_tool_schemas() -> None:
    budget = calculate_context_budget(
        {
            "max_context_tokens": 32_000,
            "max_tokens": 4_000,
            "reasoning_effort": "high",
        },
        tool_schema_tokens=1_500,
    )

    assert budget.output_reserve_tokens == 4_000
    assert budget.reasoning_reserve_tokens == 2_560
    assert budget.safety_margin_tokens == 1_600
    assert budget.usable_input_tokens == 22_340
    assert (
        retrieval_token_budget(
            {"max_context_tokens": 32_000, "max_tokens": 4_000},
            tool_schema_tokens=1_500,
        )
        <= budget.usable_input_tokens
    )


def test_unknown_and_tiny_context_have_safe_retrieval_fallbacks() -> None:
    assert retrieval_token_budget(None) == 1_200
    assert (
        retrieval_token_budget(
            {"max_context_tokens": 128, "max_tokens": 128},
            tool_schema_tokens=1_000,
        )
        == 0
    )


def test_duplicate_gc_replaces_only_exact_same_tool_results() -> None:
    large = "人物仍然不知道父亲的遗嘱内容。" * 100
    messages = [
        ContextMessage(role="tool", name="search_story_memory", content=large),
        ContextMessage(role="tool", name="search_story_memory", content=large),
        ContextMessage(role="tool", name="read_chapter", content=large),
        ContextMessage(role="tool", name="search_story_memory", content=large + "后来"),
        ContextMessage(role="user", content=large),
    ]

    result = soft_prune_duplicate_tool_results(messages)

    assert result.results_replaced == 1
    assert result.tokens_pruned > 100
    assert result.messages[0].content == large
    assert result.messages[1].content != large
    assert result.messages[1].metrics["tokens_pruned"] == result.tokens_pruned
    assert result.messages[2].content == large
    assert result.messages[3].content == large + "后来"
    assert result.messages[4].content == large


@pytest.mark.asyncio
async def test_duplicate_gc_setting_defaults_on_and_can_be_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.storage.repos import setting_repo

    lookup = AsyncMock(return_value=None)
    session = object()
    monkeypatch.setattr(setting_repo, "get_by_key", lookup)

    assert await is_soft_gc_tool_results_enabled(session) is True
    lookup.assert_awaited_once_with(session, SETTING_KEY_SOFT_GC_TOOL_RESULTS)

    lookup.return_value = type("Setting", (), {"value": "false"})()
    assert await is_soft_gc_tool_results_enabled(session) is False


def test_context_metrics_are_content_free_and_stable() -> None:
    parts = [
        ContextMessage(
            role="system",
            content="stable writer instructions",
            metadata={"part": "system_prompt"},
        ),
        ContextMessage(
            role="system",
            content="POV must remain close third person",
            metadata={"part": "rules"},
        ),
        ContextMessage(
            role="tool",
            name="search_chapters",
            content="secret chapter excerpt",
            metadata={"part": "history", "tool_name": "search_chapters"},
        ),
    ]
    tool = StructuredTool.from_function(
        func=_noop,
        name="search",
        description="Search relevant passages.",
    )

    first = measure_context_parts(parts, tools=[tool], usable_input_tokens=5_000)
    second = stable_context_fingerprint(parts, [tool])

    assert first["context_token_breakdown"]["system"] > 0
    assert first["context_token_breakdown"]["rules"] > 0
    assert first["context_token_breakdown"]["retrieval"] > 0
    assert first["tool_schema_tokens_estimated"] == count_tool_schema_tokens([tool])
    assert first["context_fingerprint"] == second
    assert "secret chapter excerpt" not in str(first)
    assert tool_schema_json([tool]) == tool_schema_json([tool])


def test_tool_schema_budget_includes_required_fields_and_function_wrapper() -> None:
    tool = StructuredTool.from_function(
        func=_noop,
        name="search",
        description="Search relevant passages.",
    )

    schema = serialize_tool_schemas([tool])

    assert schema[0]["type"] == "function"
    assert schema[0]["function"]["parameters"]["required"] == ["query"]
    assert count_tool_schema_tokens([tool]) > 0


def test_context_metrics_reuse_precomputed_tool_schema_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tool = StructuredTool.from_function(
        func=_noop,
        name="search",
        description="Search relevant passages.",
    )
    monkeypatch.setattr(
        "app.agent_runtime.context.metrics.count_tool_schema_tokens",
        lambda _tools: pytest.fail("schema token count should be reused"),
    )

    metrics = measure_context_parts(
        [], tools=[tool], tool_schema_tokens=123, usable_input_tokens=500
    )

    assert metrics["tool_schema_tokens_estimated"] == 123
    assert metrics["context_token_breakdown"]["tool_schema"] == 123


def test_context_fingerprint_changes_when_tool_requiredness_changes() -> None:
    class RequiredQuery(BaseModel):
        model_config = ConfigDict(title="SearchArgs")
        query: str

    class OptionalQuery(BaseModel):
        model_config = ConfigDict(title="SearchArgs")
        query: str = ""

    required_tool = StructuredTool.from_function(
        func=_noop,
        name="search",
        description="Search relevant passages.",
        args_schema=RequiredQuery,
    )
    optional_tool = StructuredTool.from_function(
        func=_noop,
        name="search",
        description="Search relevant passages.",
        args_schema=OptionalQuery,
    )

    assert stable_context_fingerprint(
        [], [required_tool]
    ) != stable_context_fingerprint([], [optional_tool])
