import json

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

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


def test_reports_mention_sources_from_the_final_user_message() -> None:
    messages = [
        HumanMessage(
            content=(
                "请参考 @chapter:第一卷/雨夜 的节奏，"
                "并核对 @character:林洛 与 @world_info_entry:北城 的设定，"
                "另外看看 @note:写作笔记，最后用 @skill:节奏控制。"
            )
        )
    ]

    sources = build_agent_context_sources(messages)

    assert sources == [
        {
            "id": "chapter:title:第一卷/雨夜",
            "category": "chapter",
            "title": "第一卷/雨夜",
            "sourceTypes": ["mentionReference"],
        },
        {
            "id": "character:title:林洛",
            "category": "character",
            "title": "林洛",
            "sourceTypes": ["mentionReference"],
        },
        {
            "id": "worldEntry:title:北城",
            "category": "worldEntry",
            "title": "北城",
            "sourceTypes": ["mentionReference"],
        },
        {
            "id": "note:title:写作笔记",
            "category": "note",
            "title": "写作笔记",
            "sourceTypes": ["mentionReference"],
        },
        {
            "id": "skill:title:节奏控制",
            "category": "skill",
            "title": "节奏控制",
            "sourceTypes": ["mentionReference"],
        },
    ]


def test_mention_label_stops_at_chinese_sentence_punctuation() -> None:
    messages = [
        HumanMessage(content="@note:写作笔记，最后用 @skill:节奏控制"),
    ]

    sources = build_agent_context_sources(messages)

    assert sources == [
        {
            "id": "note:title:写作笔记",
            "category": "note",
            "title": "写作笔记",
            "sourceTypes": ["mentionReference"],
        },
        {
            "id": "skill:title:节奏控制",
            "category": "skill",
            "title": "节奏控制",
            "sourceTypes": ["mentionReference"],
        },
    ]
    assert "最后用" not in json.dumps(sources, ensure_ascii=False)


def test_reports_expanded_mention_excerpt_without_retaining_the_quoted_text() -> None:
    messages = [
        HumanMessage(
            content="@chapter:第一卷/雨夜:12-30\n```\nEXCERPT-SENTINEL 正文摘录\n```\n请接着写。"
        )
    ]

    sources = build_agent_context_sources(messages)

    assert sources == [
        {
            "id": "chapter:title:第一卷/雨夜",
            "category": "chapter",
            "title": "第一卷/雨夜",
            "sourceTypes": ["mentionExcerpt"],
        }
    ]
    assert "EXCERPT-SENTINEL" not in json.dumps(sources, ensure_ascii=False)


def test_reports_injected_rules_and_available_skills_without_their_text() -> None:
    messages = [
        SystemMessage(content="你是一位长篇小说写作助手。"),
        SystemMessage(content="<rules>\n- RULE-SENTINEL 保持第一人称\n</rules>"),
        SystemMessage(
            content=(
                "<available_skills>\n"
                "The following skills provide specialized instructions for specific tasks.\n"
                "<skill>\n"
                "  <name>节奏控制</name>\n"
                "  <description>SKILL-DESC-SENTINEL</description>\n"
                "</skill>\n"
                "</available_skills>"
            )
        ),
    ]

    sources = build_agent_context_sources(messages)

    assert sources == [
        {
            "id": "rule:prompt-rules",
            "category": "rule",
            "title": "",
            "sourceTypes": ["agentRules"],
        },
        {
            "id": "skill:title:节奏控制",
            "category": "skill",
            "title": "节奏控制",
            "sourceTypes": ["availableSkill"],
        },
    ]
    serialized = json.dumps(sources, ensure_ascii=False)
    assert "RULE-SENTINEL" not in serialized
    assert "SKILL-DESC-SENTINEL" not in serialized


def test_reports_rules_and_skills_when_system_prompts_are_merged() -> None:
    merged = (
        "你是一位长篇小说写作助手。\n\n"
        "<rules>\n- 保持第一人称\n</rules>\n\n"
        "<available_skills>\n"
        "<skill>\n  <name>节奏控制</name>\n  <description>说明</description>\n</skill>\n"
        "</available_skills>"
    )

    sources = build_agent_context_sources([SystemMessage(content=merged)])

    assert [source["id"] for source in sources] == [
        "rule:prompt-rules",
        "skill:title:节奏控制",
    ]


def test_reports_activated_skill_name_without_its_instructions() -> None:
    messages = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "call-1",
                    "name": "activate_skill",
                    "args": {"skill_name": "节奏控制"},
                }
            ],
        ),
        ToolMessage(
            content='<skill_content name="节奏控制">\nBODY-SENTINEL 完整技能说明\n</skill_content>',
            tool_call_id="call-1",
        ),
    ]

    sources = build_agent_context_sources(messages)

    assert sources == [
        {
            "id": "skill:title:节奏控制",
            "category": "skill",
            "title": "节奏控制",
            "sourceTypes": ["activatedSkill"],
        }
    ]
    assert "BODY-SENTINEL" not in json.dumps(sources, ensure_ascii=False)


def test_ignores_sources_that_are_absent_from_the_final_request() -> None:
    messages = [
        HumanMessage(
            content=(
                "<compaction-summary>\n"
                "用户之前引用了 @chapter:第一卷/雨夜，并读取了 @character:林洛。\n"
                "</compaction-summary>"
            )
        ),
        HumanMessage(content="[世界设定已对 AI 隐藏] 继续写下一段。"),
        HumanMessage(content="@volume:第一卷 @note_category:资料 仅供参考。"),
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


def test_sanitizer_keeps_mention_rule_and_skill_sources() -> None:
    sources = sanitize_agent_context_sources(
        [
            {
                "id": "chapter:title:第一卷/雨夜",
                "category": "chapter",
                "title": "第一卷/雨夜",
                "sourceTypes": ["mentionExcerpt"],
            },
            {
                "id": "rule:prompt-rules",
                "category": "rule",
                "title": "",
                "sourceTypes": ["agentRules"],
            },
            {
                "id": "skill:title:节奏控制",
                "category": "skill",
                "title": "节奏控制",
                "sourceTypes": ["availableSkill", "mentionReference"],
            },
            {
                "id": "skill:title:越权",
                "category": "skill",
                "title": "越权",
                "sourceTypes": ["chapterBody"],
            },
            {
                "id": "chapter:title:越权",
                "category": "chapter",
                "title": "越权",
                "sourceTypes": ["availableSkill"],
            },
        ]
    )

    assert sources == [
        {
            "id": "chapter:title:第一卷/雨夜",
            "category": "chapter",
            "title": "第一卷/雨夜",
            "sourceTypes": ["mentionExcerpt"],
        },
        {
            "id": "rule:prompt-rules",
            "category": "rule",
            "title": "",
            "sourceTypes": ["agentRules"],
        },
        {
            "id": "skill:title:节奏控制",
            "category": "skill",
            "title": "节奏控制",
            "sourceTypes": ["availableSkill", "mentionReference"],
        },
    ]
