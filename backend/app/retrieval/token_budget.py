"""Token-aware limits for ranked retrieval results."""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from pydantic import BaseModel

from app.agent_runtime.context.compaction.tokens import count_text_tokens


ResultModel = TypeVar("ResultModel", bound=BaseModel)


def fit_ranked_text_results(
    items: list[ResultModel],
    *,
    token_budget: int,
    render: Callable[[list[ResultModel]], str],
) -> list[ResultModel]:
    """Keep ranked results in order, clipping only the top item when necessary."""
    if not items:
        return []
    budget = max(int(token_budget), 0)
    if budget == 0:
        return []

    selected: list[ResultModel] = []
    for item in items:
        candidate = [*selected, item]
        if count_text_tokens(render(candidate)) <= budget:
            selected.append(item)
            continue
        if selected:
            break

        text = getattr(item, "text", None)
        if not isinstance(text, str):
            return []

        low = 0
        high = len(text)
        best: ResultModel | None = None
        while low <= high:
            middle = (low + high) // 2
            clipped = item.model_copy(update={"text": text[:middle]})
            if count_text_tokens(render([clipped])) <= budget:
                best = clipped
                low = middle + 1
            else:
                high = middle - 1
        return [best] if best is not None else []

    return selected
