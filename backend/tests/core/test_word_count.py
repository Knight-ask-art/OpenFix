# -*- coding: utf-8 -*-
"""
字数统计单元测试。

用例与 CJK 区间表来自 fixtures/word-count-cases.json，前后端共用同一份协议，
因此这里不复制规则表，只校验后端实现对共享 fixture 的符合程度。
控制字符与不可见字符在用例里统一按码点构造，避免转义被改写后口径漂移。
"""

import json
from pathlib import Path

import pytest

from app.core.word_count import CJK_RANGES, count_words

FIXTURE_PATH = Path(__file__).resolve().parents[3] / "fixtures" / "word-count-cases.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
CASES = FIXTURE["cases"]
CJK_RANGE_CASES = [(start, end) for start, end in FIXTURE["cjkRanges"]]

LINE_FEED = chr(10)


def _case_text(case: dict) -> str:
    """用例正文：给出 text，或给出 codePoints（控制字符、组合音标、emoji 等）。"""
    if "codePoints" in case:
        return "".join(chr(code_point) for code_point in case["codePoints"])
    return case["text"]


def test_cjk_ranges_match_shared_fixture() -> None:
    """后端 CJK 区间表必须与共享 fixture 完全一致（前端引用同一份表）。"""
    assert [[start, end] for start, end in CJK_RANGES] == FIXTURE["cjkRanges"]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_count_words_matches_shared_fixture(case: dict) -> None:
    assert count_words(_case_text(case)) == case["words"]


@pytest.mark.parametrize(
    ("start", "end"),
    CJK_RANGE_CASES,
    ids=[f"{start:05X}-{end:05X}" for start, end in CJK_RANGE_CASES],
)
def test_cjk_range_endpoints_count_per_character(start: int, end: int) -> None:
    """每个 CJK 区间的首尾码点逐字符计 1，并且不与相邻字母串合并。"""
    assert count_words(chr(start)) == 1
    assert count_words(chr(end)) == 1
    assert count_words(f"{chr(start)}{chr(end)}") == 2
    assert count_words(f"a{chr(start)}b") == 3


def test_empty_and_blank_text_count_as_zero() -> None:
    blank = "".join(chr(code_point) for code_point in (32, 9, 10, 13, 12288))

    assert count_words("") == 0
    assert count_words(blank) == 0


def test_apostrophe_splits_english_words() -> None:
    """英文撇号属于标点，按边界处理：直引号与弯引号都不并入单词。"""
    assert count_words("don't") == 2
    assert count_words("don" + chr(0x2019) + "t") == 2


def test_letters_and_digits_form_one_token() -> None:
    assert count_words("abc123") == 1
    assert count_words("abc123 xyz789") == 2
    assert count_words("abc-123") == 2


def test_combining_marks_attach_to_previous_character() -> None:
    combining_acute = chr(0x301)

    assert count_words("cafe" + combining_acute) == 1
    assert count_words("cafe" + combining_acute + " bar") == 2
    assert count_words("字" + combining_acute) == 1


def test_punctuation_whitespace_and_emoji_are_boundaries() -> None:
    emoji = chr(0x1F600)

    assert count_words("你好，世界！") == 4
    assert count_words("一。" + LINE_FEED + "二") == 2
    assert count_words("ab" + emoji + "cd") == 2
    assert count_words(emoji) == 0
