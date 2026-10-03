"""Conservative input-token budgets for model context windows."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from math import ceil
from typing import Any


_REASONING_RESERVE_RATIOS = {
    "off": 0.0,
    "low": 0.02,
    "medium": 0.04,
    "high": 0.08,
    "xhigh": 0.12,
    "max": 0.12,
}


@dataclass(frozen=True)
class ContextBudget:
    max_context_tokens: int
    output_reserve_tokens: int
    reasoning_reserve_tokens: int
    safety_margin_tokens: int
    tool_schema_tokens: int
    usable_input_tokens: int


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None


def calculate_context_budget(
    model_config: Mapping[str, Any] | None,
    *,
    tool_schema_tokens: int = 0,
    safety_margin_ratio: float = 0.05,
) -> ContextBudget:
    """Reserve output, reasoning, safety margin, and fixed tool schemas first.

    ``usable_input_tokens`` is the remaining budget for message content after
    tool schemas have been accounted for. Unknown output limits use a bounded
    default; reserves never alter provider request parameters.
    """
    config = model_config if isinstance(model_config, Mapping) else {}
    max_context = _positive_int(config.get("max_context_tokens")) or 0
    schema_tokens = max(_positive_int(tool_schema_tokens) or 0, 0)
    if max_context == 0:
        return ContextBudget(0, 0, 0, 0, schema_tokens, 0)

    configured_output = _positive_int(config.get("max_tokens")) or _positive_int(
        config.get("max_output_tokens")
    )
    output_reserve = configured_output or min(4096, max(1, max_context // 4))
    output_reserve = min(output_reserve, max_context // 2)

    effort = config.get("reasoning_effort")
    effort_key = effort.strip().lower() if isinstance(effort, str) else ""
    reasoning_ratio = _REASONING_RESERVE_RATIOS.get(effort_key, 0.04)
    reasoning_reserve = min(
        ceil(max_context * reasoning_ratio),
        max_context // 4,
    )

    if not 0.0 <= safety_margin_ratio <= 0.25:
        safety_margin_ratio = 0.05
    safety_margin = min(ceil(max_context * safety_margin_ratio), max_context // 4)
    available_for_input = max(
        max_context - output_reserve - reasoning_reserve - safety_margin,
        0,
    )
    usable_input = max(available_for_input - schema_tokens, 0)

    return ContextBudget(
        max_context_tokens=max_context,
        output_reserve_tokens=output_reserve,
        reasoning_reserve_tokens=reasoning_reserve,
        safety_margin_tokens=safety_margin,
        tool_schema_tokens=schema_tokens,
        usable_input_tokens=usable_input,
    )


def retrieval_token_budget(
    model_config: Mapping[str, Any] | None,
    *,
    tool_schema_tokens: int = 0,
    fraction: float = 0.15,
    fallback_tokens: int = 1200,
    minimum_tokens: int = 256,
    maximum_tokens: int = 5000,
) -> int:
    """Give ranked retrieval a bounded share of the usable input budget."""
    budget = calculate_context_budget(
        model_config,
        tool_schema_tokens=tool_schema_tokens,
    )
    if budget.max_context_tokens == 0:
        return fallback_tokens
    if budget.usable_input_tokens == 0:
        return 0
    ratio = fraction if 0.0 < fraction <= 0.5 else 0.15
    return min(
        max(int(budget.usable_input_tokens * ratio), minimum_tokens),
        maximum_tokens,
        budget.usable_input_tokens,
    )
