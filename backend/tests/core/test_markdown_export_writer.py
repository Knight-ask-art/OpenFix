"""生成 Markdown 标题的字面文本回归。"""

from string import punctuation

import pytest

from app.chapter_export.markdown_writer import format_heading


@pytest.mark.parametrize("character", list(punctuation))
def test_heading_escapes_every_commonmark_ascii_punctuation(character: str) -> None:
    assert format_heading(f"甲{character}乙", level=1) == f"# 甲\\{character}乙\n\n"


def test_heading_folds_line_breaks_and_preserves_unicode() -> None:
    assert format_heading("第一章\r\n\n第二行\r第三行 汉字", level=2) == (
        "## 第一章 第二行 第三行 汉字\n\n"
    )


def test_heading_escapes_entities_links_and_atx_closing_marks() -> None:
    assert format_heading("[章](path) &amp; <tag> \\ ###", level=2) == (
        "## \\[章\\]\\(path\\) \\&amp\\; \\<tag\\> \\\\ \\#\\#\\#\n\n"
    )
