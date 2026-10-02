"""Build bounded, content-free source metadata from the exact model input."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

MAX_CONTEXT_SOURCES = 500
MAX_SOURCE_LABEL_LENGTH = 160
MAX_SOURCE_ID_LENGTH = 256

_SOURCE_TYPES_BY_CATEGORY: dict[str, set[str]] = {
    "chapter": {
        "chapterBody",
        "chapterCatalog",
        "chapterSearch",
        "chapterSummary",
        "rangeSummary",
        "storyMemorySearch",
    },
    "character": {"characterList", "characterProfile", "storyMemorySearch"},
    "worldEntry": {"worldEntryList", "worldEntryContent", "storyMemorySearch"},
    "outline": {"storyMemorySearch"},
    "note": {"noteList", "noteContent", "storyMemorySearch"},
    "conversation": {"compactionSummary"},
}


def _record(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _label(value: Any, *, limit: int = MAX_SOURCE_LABEL_LENGTH) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split())
    return normalized[:limit] if normalized else None


def _number(record: Mapping[str, Any] | None, *keys: str) -> int | None:
    if record is None:
        return None
    for key in keys:
        value = record.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def sanitize_agent_context_sources(value: Any) -> list[dict[str, Any]]:
    """Keep only the public source-label contract; drop arbitrary payload data."""
    if not isinstance(value, list):
        return []

    sanitized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        record = _record(item)
        if record is None:
            continue
        category = record.get("category")
        if not isinstance(category, str) or category not in _SOURCE_TYPES_BY_CATEGORY:
            continue
        source_id = _label(record.get("id"), limit=MAX_SOURCE_ID_LENGTH)
        if (
            not source_id
            or not source_id.startswith(f"{category}:")
            or source_id in seen
        ):
            continue
        raw_source_types = record.get("sourceTypes")
        source_types = (
            list(
                dict.fromkeys(
                    source_type
                    for source_type in raw_source_types
                    if isinstance(source_type, str)
                    and source_type in _SOURCE_TYPES_BY_CATEGORY[category]
                )
            )
            if isinstance(raw_source_types, list)
            else []
        )
        if not source_types:
            continue

        normalized: dict[str, Any] = {
            "id": source_id,
            "category": category,
            "title": _label(record.get("title")) or "",
            "sourceTypes": source_types,
        }
        for key in ("chapterOrder", "chapterStartOrder", "chapterEndOrder"):
            number = record.get(key)
            if (
                category == "chapter"
                and isinstance(number, int)
                and not isinstance(number, bool)
            ):
                normalized[key] = number
        sanitized.append(normalized)
        seen.add(source_id)
        if len(sanitized) >= MAX_CONTEXT_SOURCES:
            break
    return sanitized


def _tool_names_by_id(messages: Sequence[BaseMessage]) -> dict[str, str]:
    tool_names: dict[str, str] = {}
    for message in messages:
        if not isinstance(message, AIMessage):
            continue
        for call in message.tool_calls or []:
            tool_call_id = call.get("id")
            name = call.get("name")
            if isinstance(tool_call_id, str) and tool_call_id and isinstance(name, str):
                tool_names[tool_call_id] = name
    return tool_names


def _decoded_result(content: Any) -> Any:
    if not isinstance(content, str):
        return None
    try:
        value = json.loads(content)
    except (TypeError, ValueError):
        return None
    record = _record(value)
    if record is None:
        return value
    result_type = record.get("type")
    result_reason = record.get("reason")
    if (
        record.get("success") is False
        or record.get("error")
        or (isinstance(result_type, str) and result_type in {"fail", "preview"})
        or (
            isinstance(result_reason, str)
            and result_reason in {"approval_preview", "tool_error"}
        )
    ):
        return None
    data = record.get("data")
    if isinstance(data, (Mapping, list)):
        return data
    return value


def _items(value: Any, key: str | None = None) -> list[Any]:
    if isinstance(value, list):
        return value
    record = _record(value)
    items = record.get(key) if record is not None and key else None
    return items if isinstance(items, list) else []


def build_agent_context_sources(
    messages: Sequence[BaseMessage],
) -> list[dict[str, Any]]:
    """Summarize only successful read results present in the final model input."""
    sources: dict[str, dict[str, Any]] = {}
    tool_names_by_id = _tool_names_by_id(messages)

    def add(
        category: str,
        title: Any,
        source_type: str,
        *,
        identity: Any = None,
        chapter_order: int | None = None,
        chapter_start_order: int | None = None,
        chapter_end_order: int | None = None,
    ) -> None:
        safe_title = _label(title) or ""
        safe_identity = _label(identity, limit=MAX_SOURCE_ID_LENGTH)
        if chapter_start_order is not None and chapter_end_order is not None:
            fallback = f"range:{chapter_start_order}:{chapter_end_order}"
        elif chapter_order is not None:
            fallback = f"order:{chapter_order}"
        else:
            fallback = f"title:{safe_title.casefold()}"
        source_id = f"{category}:{safe_identity or fallback}"
        existing = sources.get(source_id)
        if existing is not None:
            if not existing["title"] and safe_title:
                existing["title"] = safe_title
            if source_type not in existing["sourceTypes"]:
                existing["sourceTypes"].append(source_type)
            return

        source: dict[str, Any] = {
            "id": source_id,
            "category": category,
            "title": safe_title,
            "sourceTypes": [source_type],
        }
        if chapter_order is not None:
            source["chapterOrder"] = chapter_order
        if chapter_start_order is not None:
            source["chapterStartOrder"] = chapter_start_order
        if chapter_end_order is not None:
            source["chapterEndOrder"] = chapter_end_order
        sources[source_id] = source

    for message in messages:
        if (
            isinstance(message, HumanMessage)
            and isinstance(message.content, str)
            and "<compaction-summary>" in message.content
        ):
            add(
                "conversation",
                "压缩后的对话摘要",
                "compactionSummary",
                identity="compaction-summary",
            )
            continue
        if not isinstance(message, ToolMessage):
            continue
        tool_name = (
            message.name
            if isinstance(message.name, str)
            else tool_names_by_id.get(message.tool_call_id)
        )
        if not isinstance(tool_name, str):
            continue
        result = _decoded_result(message.content)
        if result is None:
            continue
        result_record = _record(result)

        if tool_name == "read_chapter":
            chapter_order = _number(result_record, "order")
            title = _label(result_record.get("title")) if result_record else None
            if title or chapter_order is not None:
                add(
                    "chapter",
                    title,
                    "chapterBody",
                    identity=f"order:{chapter_order}"
                    if chapter_order is not None
                    else None,
                    chapter_order=chapter_order,
                )
        elif tool_name == "list_chapters":
            for item in _items(result):
                record = _record(item)
                if record is None:
                    continue
                chapter_order = _number(record, "order")
                title = _label(record.get("title"))
                if title or chapter_order is not None:
                    add(
                        "chapter",
                        title,
                        "chapterCatalog",
                        identity=f"order:{chapter_order}"
                        if chapter_order is not None
                        else None,
                        chapter_order=chapter_order,
                    )
        elif tool_name == "search_chapters":
            for item in _items(result, "results"):
                record = _record(item)
                if record is None:
                    continue
                chapter_order = _number(record, "chapter_order")
                title = _label(record.get("chapter_title"))
                if title or chapter_order is not None:
                    add(
                        "chapter",
                        title,
                        "chapterSearch",
                        identity=f"order:{chapter_order}"
                        if chapter_order is not None
                        else None,
                        chapter_order=chapter_order,
                    )
        elif tool_name in {"read_chapter_summaries", "read_range_summaries"}:
            for item in _items(result, "summaries"):
                record = _record(item)
                if record is None:
                    continue
                if tool_name == "read_chapter_summaries":
                    chapter_order = _number(record, "order")
                    title = _label(record.get("title"))
                    if title or chapter_order is not None:
                        add(
                            "chapter",
                            title,
                            "chapterSummary",
                            identity=f"order:{chapter_order}"
                            if chapter_order is not None
                            else None,
                            chapter_order=chapter_order,
                        )
                else:
                    chapter_start = _number(record, "start_order")
                    chapter_end = _number(record, "end_order")
                    if chapter_start is not None and chapter_end is not None:
                        add(
                            "chapter",
                            "",
                            "rangeSummary",
                            chapter_start_order=chapter_start,
                            chapter_end_order=chapter_end,
                        )
        elif tool_name == "list_characters":
            for item in _items(result, "characters"):
                record = _record(item)
                title = _label(record.get("name")) if record else None
                if title:
                    add("character", title, "characterList")
        elif tool_name == "read_character":
            title = _label(result_record.get("name")) if result_record else None
            if title:
                add("character", title, "characterProfile")
        elif tool_name == "list_world_entries":
            for item in _items(result, "entries"):
                record = _record(item)
                if record is None:
                    continue
                title = _label(record.get("title")) or _label(record.get("name"))
                uid = _number(record, "uid")
                if title:
                    add(
                        "worldEntry",
                        title,
                        "worldEntryList",
                        identity=f"uid:{uid}" if uid is not None else None,
                    )
        elif tool_name == "read_world_entry":
            title = _label(result_record.get("title")) if result_record else None
            uid = _number(result_record, "uid")
            if title:
                add(
                    "worldEntry",
                    title,
                    "worldEntryContent",
                    identity=f"uid:{uid}" if uid is not None else None,
                )
        elif tool_name == "search_story_memory":
            for item in _items(result, "results"):
                record = _record(item)
                if record is None:
                    continue
                source = record.get("source")
                title = _label(record.get("title")) or ""
                entity_id = _label(record.get("entity_id"), limit=MAX_SOURCE_ID_LENGTH)
                identity = f"id:{entity_id}" if entity_id else None
                if source == "chapter":
                    chapter_order = _number(record, "chapter_order")
                    if title or chapter_order is not None:
                        add(
                            "chapter",
                            title,
                            "storyMemorySearch",
                            identity=identity,
                            chapter_order=chapter_order,
                        )
                elif source == "character" and title:
                    add("character", title, "storyMemorySearch", identity=identity)
                elif source == "world_entry" and title:
                    add("worldEntry", title, "storyMemorySearch", identity=identity)
                elif source == "outline" and title:
                    add("outline", title, "storyMemorySearch", identity=identity)
                elif source == "note" and title:
                    add("note", title, "storyMemorySearch", identity=identity)
        elif tool_name == "list_notes":
            for item in _items(result, "items"):
                record = _record(item)
                if record is None or record.get("type") != "note":
                    continue
                title = _label(record.get("title"))
                note_id = _label(record.get("id"), limit=MAX_SOURCE_ID_LENGTH)
                if title:
                    add(
                        "note",
                        title,
                        "noteList",
                        identity=f"id:{note_id}" if note_id else None,
                    )
        elif tool_name == "read_note":
            title = _label(result_record.get("title")) if result_record else None
            note_id = (
                _label(result_record.get("id"), limit=MAX_SOURCE_ID_LENGTH)
                if result_record
                else None
            )
            if title:
                add(
                    "note",
                    title,
                    "noteContent",
                    identity=f"id:{note_id}" if note_id else None,
                )

        if len(sources) >= MAX_CONTEXT_SOURCES:
            break

    return sanitize_agent_context_sources(list(sources.values()))
