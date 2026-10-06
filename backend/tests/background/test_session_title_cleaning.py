import pytest

from app.background.jobs.definitions.session_title import _clean_title


@pytest.mark.parametrize("payload", [
    "<tool_call><function=list_directory><parameter=path>…",
    "<think>internal reasoning</think>第二章写作",
    '<TOOL_CALL>{"name":"read_chapter"}</TOOL_CALL>',
    '{"title": "第二章写作"}',
    '["第二章写作"]',
    "```json\n{}\n```",
])
def test_provider_structured_output_is_not_saved_as_title(payload):
    assert _clean_title(payload) == ""


@pytest.mark.parametrize(("raw", "expected"), [
    ("第二章剑术对练", "第二章剑术对练"),
    ('  “修订第一章。”  ', "修订第一章"),
    ("# 第二章写作\nextra explanation", "第二章写作"),
])
def test_plain_titles_keep_existing_cleaning(raw, expected):
    assert _clean_title(raw) == expected
