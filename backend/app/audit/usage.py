"""Provider-neutral usage token normalization for LLM audit records."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypedDict


class NormalizedUsageTokens(TypedDict):
    token_input: int
    token_output: int
    tokens_total: int
    token_cache: int
    token_cache_write: int
    token_input_uncached: int
    token_input_total: int
    token_reasoning: int
    cache_hit_rate: float


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(int(value), 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _usage_int(
    usage: Mapping[str, Any],
    *keys: str,
    nested_paths: tuple[tuple[str, str], ...] = (),
) -> int:
    for key in keys:
        value = _non_negative_int(usage.get(key))
        if value:
            return value
    for parent_key, child_key in nested_paths:
        parent = usage.get(parent_key)
        if isinstance(parent, Mapping):
            value = _non_negative_int(parent.get(child_key))
            if value:
                return value
    return 0


def normalize_usage_tokens(
    usage: Mapping[str, Any] | None,
) -> NormalizedUsageTokens:
    """Normalize common provider aliases and keep old input fields intact.

    ``token_input`` retains its historical provider-reported value. The new
    normalized total and uncached counters account for Anthropic's separate
    cache read/write fields without changing legacy dashboard semantics.
    """
    if not isinstance(usage, Mapping) or not usage:
        return {
            "token_input": 0,
            "token_output": 0,
            "tokens_total": 0,
            "token_cache": 0,
            "token_cache_write": 0,
            "token_input_uncached": 0,
            "token_input_total": 0,
            "token_reasoning": 0,
            "cache_hit_rate": 0.0,
        }

    token_input = _usage_int(
        usage,
        "input_tokens",
        "prompt_tokens",
        "prompt_token_count",
        "token_input",
    )
    token_output = _usage_int(
        usage,
        "output_tokens",
        "completion_tokens",
        "candidates_token_count",
        "token_output",
    )
    token_cache = _usage_int(
        usage,
        "cache_read_input_tokens",
        "cache_read_tokens",
        "cached_tokens",
        "cache_read",
        "cached_content_token_count",
        nested_paths=(
            ("input_token_details", "cache_read"),
            ("input_token_details", "cached_tokens"),
            ("input_token_details", "cache_read_tokens"),
            ("prompt_tokens_details", "cached_tokens"),
            ("prompt_tokens_details", "cache_read"),
            ("prompt_tokens_details", "cache_read_tokens"),
        ),
    )
    token_cache_write = _usage_int(
        usage,
        "cache_creation_input_tokens",
        "cache_write_input_tokens",
        "cache_write_tokens",
        "cache_creation_tokens",
        "cache_creation",
        "cache_write",
        nested_paths=(
            ("input_token_details", "cache_creation"),
            ("input_token_details", "cache_creation_input_tokens"),
            ("input_token_details", "cache_write"),
            ("prompt_tokens_details", "cache_creation"),
            ("prompt_tokens_details", "cache_creation_input_tokens"),
            ("prompt_tokens_details", "cache_write"),
        ),
    )
    token_reasoning = _usage_int(
        usage,
        "reasoning_tokens",
        "thoughts_token_count",
        nested_paths=(
            ("completion_tokens_details", "reasoning_tokens"),
            ("output_token_details", "reasoning"),
            ("output_token_details", "reasoning_tokens"),
        ),
    )

    # Anthropic reports uncached prompt tokens separately from cache tokens.
    anthropic_cache_shape = any(
        key in usage
        for key in ("cache_read_input_tokens", "cache_creation_input_tokens")
    )
    token_input_total = (
        token_input + token_cache + token_cache_write
        if anthropic_cache_shape
        else token_input
    )
    token_input_uncached = (
        token_input
        if anthropic_cache_shape
        else max(token_input - token_cache - token_cache_write, 0)
    )
    total_tokens = _usage_int(usage, "total_tokens", "total_token_count") or (
        token_input_total + token_output
    )
    return {
        "token_input": token_input,
        "token_output": token_output,
        "tokens_total": total_tokens,
        "token_cache": token_cache,
        "token_cache_write": token_cache_write,
        "token_input_uncached": token_input_uncached,
        "token_input_total": token_input_total,
        "token_reasoning": token_reasoning,
        "cache_hit_rate": (
            min(token_cache, token_input_total) / token_input_total
            if token_input_total
            else 0.0
        ),
    }
