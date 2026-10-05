"""Conservative soft GC for repeated model-visible tool results."""

from __future__ import annotations

from dataclasses import dataclass, replace

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.context.compaction.tokens import count_text_tokens
from app.agent_runtime.context.errors import ContextBuildError
from app.agent_runtime.context.types import ContextMessage
from app.storage.repos import setting_repo


SETTING_KEY_SOFT_GC_TOOL_RESULTS = "context_soft_gc_tool_results"
DEFAULT_SOFT_GC_TOOL_RESULTS_ENABLED = True
MIN_DUPLICATE_RESULT_TOKENS = 256
MIN_SAVED_TOKENS = 128
_DUPLICATE_REFERENCE = "此工具结果与前文中的同工具结果完全一致，请参考前文结果。"


@dataclass(frozen=True)
class SoftGcResult:
    messages: list[ContextMessage]
    tokens_pruned: int
    results_replaced: int


async def is_soft_gc_tool_results_enabled(db_session: AsyncSession) -> bool:
    """Read the opt-out setting; old installations keep the conservative default."""
    try:
        row = await setting_repo.get_by_key(db_session, SETTING_KEY_SOFT_GC_TOOL_RESULTS)
    except Exception as e:
        raise ContextBuildError(
            "settings",
            "failed to load tool_result_soft_gc setting",
            cause=e,
        ) from e
    if row is None or row.value == "":
        return DEFAULT_SOFT_GC_TOOL_RESULTS_ENABLED
    return row.value.strip().lower() not in {"false", "0", "no", "off"}


def soft_prune_duplicate_tool_results(
    messages: list[ContextMessage],
) -> SoftGcResult:
    """Replace only later, large, byte-identical results from the same tool."""
    seen: set[tuple[str, str]] = set()
    output: list[ContextMessage] = []
    tokens_pruned = 0
    results_replaced = 0

    for message in messages:
        if message.role != "tool" or not isinstance(message.content, str):
            output.append(message)
            continue
        metadata = message.metadata if isinstance(message.metadata, dict) else {}
        raw_tool_name = message.name or metadata.get("tool_name")
        if not isinstance(raw_tool_name, str) or not raw_tool_name:
            output.append(message)
            continue
        result_tokens = count_text_tokens(message.content)
        if result_tokens < MIN_DUPLICATE_RESULT_TOKENS:
            output.append(message)
            continue

        key = (raw_tool_name, message.content)
        if key not in seen:
            seen.add(key)
            output.append(message)
            continue

        saved_tokens = result_tokens - count_text_tokens(_DUPLICATE_REFERENCE)
        if saved_tokens < MIN_SAVED_TOKENS:
            output.append(message)
            continue

        metrics = dict(message.metrics or {})
        metrics["tokens_pruned"] = saved_tokens
        output.append(replace(message, content=_DUPLICATE_REFERENCE, metrics=metrics))
        tokens_pruned += saved_tokens
        results_replaced += 1

    return SoftGcResult(output, tokens_pruned, results_replaced)
