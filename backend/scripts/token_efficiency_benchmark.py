"""Offline synthetic token-efficiency benchmark; no provider calls or manuscript data."""

from __future__ import annotations

import json

from pydantic import BaseModel

from app.agent_runtime.context.budget import calculate_context_budget
from app.agent_runtime.context.compaction.tokens import (
    count_context_tokens,
    count_text_tokens,
)
from app.agent_runtime.context.processors.soft_gc import (
    soft_prune_duplicate_tool_results,
)
from app.agent_runtime.context.types import ContextMessage
from app.retrieval.token_budget import fit_ranked_text_results


class _RetrievalItem(BaseModel):
    title: str
    text: str
    score: float


def _retrieval_case(token_budget: int) -> dict[str, int | bool]:
    results = [
        _RetrievalItem(
            title=f"第 {index + 1} 章",
            text=("这个片段包含人物认知、动作和因果线索。" * 180),
            score=1.0 - index * 0.05,
        )
        for index in range(8)
    ]

    def render(items: list[_RetrievalItem]) -> str:
        return json.dumps(
            {
                "query": "林晚何时得知信件内容",
                "results": [item.model_dump() for item in items],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )

    before = count_text_tokens(render(results))
    bounded = fit_ranked_text_results(results, token_budget=token_budget, render=render)
    after = count_text_tokens(render(bounded))
    return {
        "input_tokens_before": before,
        "input_tokens_after": after,
        "estimated_tokens_avoided": max(before - after, 0),
        "ranked_top_result_preserved": bool(
            bounded and bounded[0].score == results[0].score
        ),
    }


def _gc_case(tool_name: str, copies: int) -> dict[str, int]:
    result = "林晚不知道父亲早已签署遗嘱，也不知道信件被转移。" * 150
    messages = [
        ContextMessage(
            role="tool",
            name=tool_name,
            content=result,
            metadata={"part": "history", "tool_name": tool_name},
        )
        for _ in range(copies)
    ]
    before = count_context_tokens(messages)
    gc_result = soft_prune_duplicate_tool_results(messages)
    after = count_context_tokens(gc_result.messages)
    return {
        "input_tokens_before": before,
        "input_tokens_after": after,
        "estimated_tokens_avoided": max(before - after, 0),
        "duplicate_results_replaced": gc_result.results_replaced,
    }


def run_benchmark() -> dict[str, object]:
    short_session = [
        ContextMessage(
            role="system", content="Write the current scene in close third person."
        ),
        ContextMessage(role="user", content="继续写林晚推开病房门的场景。"),
    ]
    continuity = [
        ContextMessage(
            role="user", content=f"第 {chapter} 章摘要：人物目标与冲突进展。"
        )
        for chapter in range(1, 10)
    ]
    continuity.append(ContextMessage(role="user", content="续写第十章。"))
    short_before = count_context_tokens(short_session)
    continuity_before = count_context_tokens(continuity)
    budget = calculate_context_budget(
        {
            "max_context_tokens": 64_000,
            "max_tokens": 6_000,
            "reasoning_effort": "medium",
        },
        tool_schema_tokens=1_200,
    )
    heavy_retrieval_budget = min(1_200, budget.usable_input_tokens)

    return {
        "benchmark_kind": "synthetic_o200k_base_estimates",
        "live_provider_calls": 0,
        "cases": {
            "A_short_single_chapter": {
                "input_tokens_before": short_before,
                "input_tokens_after": short_before,
                "estimated_tokens_avoided": 0,
            },
            "B_multi_chapter_continuity": {
                "input_tokens_before": continuity_before,
                "input_tokens_after": continuity_before,
                "estimated_tokens_avoided": 0,
                "continuity_messages_preserved": len(continuity),
            },
            "C_chapter_50_plus_retrieval": _retrieval_case(heavy_retrieval_budget),
            "D_reviewer_to_actor_repeated_reads": _gc_case("search_chapters", 2),
            "E_skill_heavy_duplicate_activation": _gc_case("activate_skill", 3),
            "F_rag_heavy": _retrieval_case(min(900, budget.usable_input_tokens)),
            "G_compaction_threshold": {
                "max_context_tokens": budget.max_context_tokens,
                "legacy_trigger_tokens": int(budget.max_context_tokens * 0.8),
                "reserved_input_budget_tokens": budget.usable_input_tokens,
                "new_soft_trigger_tokens": int(budget.usable_input_tokens * 0.8),
            },
        },
    }


if __name__ == "__main__":
    print(json.dumps(run_benchmark(), ensure_ascii=False, indent=2, sort_keys=True))
