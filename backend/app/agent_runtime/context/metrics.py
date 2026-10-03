"""Text-free context measurements for audit and budget decisions."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping

from langchain_core.tools import BaseTool

from app.agent_runtime.context.compaction.tokens import count_context_tokens
from app.agent_runtime.context.types import ContextMessage
from app.agent_runtime.tools.schema import (
    count_tool_schema_tokens,
    serialize_tool_schemas,
)


_CATEGORIES = (
    "system",
    "rules",
    "skills",
    "history",
    "current_chapter",
    "summary",
    "story_state",
    "retrieval",
    "runtime",
    "other",
)
_STABLE_PARTS = frozenset({"system_prompt", "rules", "skills"})
_TOOL_CATEGORIES = {
    "search_chapters": "retrieval",
    "search_story_memory": "retrieval",
    "read_chapter": "current_chapter",
    "read_chapter_summaries": "summary",
    "read_range_summaries": "summary",
    "list_characters": "story_state",
    "read_character": "story_state",
    "list_world_entries": "story_state",
    "read_world_entry": "story_state",
    "list_notes": "story_state",
    "read_note": "story_state",
}
_PRIORITY = {
    "system": 100,
    "rules": 95,
    "skills": 60,
    "history": 70,
    "current_chapter": 95,
    "summary": 80,
    "story_state": 90,
    "retrieval": 70,
    "runtime": 90,
    "other": 50,
}


def _context_category(message: ContextMessage) -> str:
    metadata = message.metadata if isinstance(message.metadata, Mapping) else {}
    part = metadata.get("part")
    if part == "system_prompt":
        return "system"
    tool_name = message.name or metadata.get("tool_name")
    if isinstance(tool_name, str):
        if tool_name in {"activate_skill", "reference_skill"}:
            return "skills"
        if category := _TOOL_CATEGORIES.get(tool_name):
            return category
    if part in _CATEGORIES:
        return str(part)
    if part == "rules":
        return "rules"
    if part == "skills":
        return "skills"
    if part == "runtime":
        return "runtime"

    return "history" if part == "history" else "other"


def _part_metrics(
    message: ContextMessage, category: str, tokens: int
) -> dict[str, object]:
    stable = (message.metadata or {}).get("part") in _STABLE_PARTS
    required = category in {"system", "rules"}
    reasons = {
        "system": "agent core prompt",
        "rules": "project and global writing constraints",
        "skills": "skill manifest or explicitly activated skill",
        "history": "conversation and tool continuity",
        "current_chapter": "chapter content read by the agent",
        "summary": "chapter or range summary read by the agent",
        "story_state": "character, world, outline, or note facts",
        "retrieval": "ranked chapter or story-memory search result",
        "runtime": "current-turn runtime instructions",
        "other": "unclassified model-visible context",
    }
    return {
        "source": category,
        "type": message.role,
        "estimated_tokens": tokens,
        "priority": _PRIORITY[category],
        "relevance": 1.0
        if category in {"system", "rules", "current_chapter", "story_state", "runtime"}
        else None,
        "cacheability": "stable" if stable else "dynamic",
        "stability": "stable" if stable else "turn-or-history",
        "required": required,
        "reason": reasons[category],
        "origin": (message.metadata or {}).get("origin")
        or (message.metadata or {}).get("tool_name")
        or (message.metadata or {}).get("part")
        or category,
    }


def stable_context_fingerprint(
    parts: Iterable[ContextMessage],
    tools: Iterable[BaseTool] | None = None,
) -> str:
    """Fingerprint only ordered stable prompt parts and tool schemas."""
    stable_messages = [
        {"role": message.role, "content": message.content}
        for message in parts
        if (message.metadata or {}).get("part") in _STABLE_PARTS
    ]
    payload = json.dumps(
        {
            "messages": stable_messages,
            "tools": serialize_tool_schemas(tools),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]


def measure_context_parts(
    parts: list[ContextMessage],
    *,
    tools: Iterable[BaseTool] | None = None,
    tool_schema_tokens: int | None = None,
    usable_input_tokens: int = 0,
) -> dict[str, object]:
    """Attach per-part numeric metadata and return a content-free summary."""
    breakdown = {category: 0 for category in _CATEGORIES}
    tokens_pruned = 0
    tokens_compacted = 0
    for message in parts:
        category = _context_category(message)
        tokens = count_context_tokens([message])
        breakdown[category] += tokens
        prior_metrics = message.metrics if isinstance(message.metrics, dict) else {}
        tokens_pruned += max(int(prior_metrics.get("tokens_pruned", 0) or 0), 0)
        tokens_compacted += max(int(prior_metrics.get("tokens_compacted", 0) or 0), 0)
        message.metrics = _part_metrics(message, category, tokens)

    tool_tokens = (
        count_tool_schema_tokens(tools)
        if tool_schema_tokens is None
        else max(int(tool_schema_tokens), 0)
    )
    breakdown["tool_schema"] = tool_tokens
    return {
        "context_token_breakdown": breakdown,
        "context_tokens_estimated": sum(
            breakdown[category] for category in _CATEGORIES
        ),
        "tool_schema_tokens_estimated": tool_tokens,
        "context_budget_tokens": max(usable_input_tokens, 0),
        "tokens_pruned": tokens_pruned,
        "tokens_compacted": tokens_compacted,
        "context_fingerprint": stable_context_fingerprint(parts, tools),
    }
