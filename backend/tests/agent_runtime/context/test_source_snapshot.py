import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.agent_runtime.context.source_snapshot import (
    build_agent_context_sources,
    sanitize_agent_context_sources,
)


def _read_result(tool_name: str, args: dict, result: object) -> list:
    return [
        AIMessage(
            content="",
            tool_calls=[{"id": "call-1", "name": tool_name, "args": args}],
        ),
        ToolMessage(
            content=json.dumps(result, ensure_ascii=False),
            tool_call_id="call-1",
        ),
    ]


def test_builds_snapshot_from_only_read_results_present_in_exact_model_input() -> None:
    messages = [
        HumanMessage(content="帮我续写"),
        *_read_result(
            "read_chapter",
            {"chapter_ref": {"type": "order", "value": 8}},
            {
                "success": True,
                "data": {
                    "order": 8,
                    "title": "雨夜",
                    "content": "正文机密片段，不得进入快照",
                },
            },
        ),
    ]

    sources = build_agent_context_sources(messages)

    assert sources == [
        {
            "id": "chapter:order:8",
            "category": "chapter",
            "title": "雨夜",
            "sourceTypes": ["chapterBody"],
            "chapterOrder": 8,
        }
    ]
    assert "正文机密片段" not in json.dumps(sources, ensure_ascii=False)


def test_builds_snapshot_after_compaction_without_old_read_results() -> None:
    messages = [
        HumanMessage(content="压缩后的摘要：之前读过第 3 章"),
        *_read_result(
            "read_chapter",
            {"chapter_ref": {"type": "order", "value": 9}},
            {
                "success": True,
                "data": {"order": 9, "title": "新章节", "content": "正文"},
            },
        ),
    ]

    sources = build_agent_context_sources(messages)

    assert [source["id"] for source in sources] == ["chapter:order:9"]


def test_reports_compacted_history_without_claiming_its_old_resources_are_current() -> (
    None
):
    messages = [
        HumanMessage(
            content="<compaction-summary>摘要提到第 3 章和林洛</compaction-summary>"
        )
    ]

    sources = build_agent_context_sources(messages)

    assert sources == [
        {
            "id": "conversation:compaction-summary",
            "category": "conversation",
            "title": "压缩后的对话摘要",
            "sourceTypes": ["compactionSummary"],
        }
    ]


def test_ignores_failed_and_approval_preview_reads() -> None:
    failed = _read_result(
        "read_character",
        {"name": "林洛"},
        {"success": False, "error": "not found", "data": {"name": "林洛"}},
    )
    preview = _read_result(
        "read_world_entry",
        {"title": "北城"},
        {
            "success": True,
            "type": "preview",
            "reason": "approval_preview",
            "title": "北城",
        },
    )

    assert build_agent_context_sources([*failed, *preview]) == []


def test_does_not_persist_labels_from_tool_arguments() -> None:
    sentinel_values = [
        "ARG-SENTINEL-CHAPTER",
        "ARG-SENTINEL-CHARACTER",
        "ARG-SENTINEL-WORLD",
    ]
    messages = [
        *_read_result(
            "read_chapter",
            {"chapter_ref": {"type": "title", "value": sentinel_values[0]}},
            {"success": True, "data": {"content": "chapter text"}},
        ),
        *_read_result(
            "read_character",
            {"name": sentinel_values[1]},
            {"success": True, "data": {"description": "character profile"}},
        ),
        *_read_result(
            "read_world_entry",
            {"title": sentinel_values[2]},
            {"success": True, "data": {"description": "world entry"}},
        ),
    ]

    sources = build_agent_context_sources(messages)
    serialized_sources = json.dumps(sources, ensure_ascii=False)

    assert sources == []
    assert all(value not in serialized_sources for value in sentinel_values)


def test_sanitizer_drops_unapproved_fields_and_invalid_source_types() -> None:
    sources = sanitize_agent_context_sources(
        [
            {
                "id": "chapter:order:1",
                "category": "chapter",
                "title": "第一章",
                "chapterOrder": 1,
                "sourceTypes": ["chapterBody", "unapproved"],
                "content": "do not retain",
                "prompt": "do not retain",
            },
            {
                "id": "note:any",
                "category": "note",
                "title": "笔记",
                "sourceTypes": ["chapterBody"],
            },
        ]
    )

    assert sources == [
        {
            "id": "chapter:order:1",
            "category": "chapter",
            "title": "第一章",
            "chapterOrder": 1,
            "sourceTypes": ["chapterBody"],
        }
    ]
