# -*- coding: utf-8 -*-
"""DOCX 解析测试。"""

import io

import pytest
from docx import Document

from app.core.docx_parser import extract_docx_text, parse_docx_content
from app.core.project_import import parse_project_import
from app.core.txt_parser import ParseResult


def _build_docx(paragraphs: list[tuple[str | None, str]]) -> bytes:
    """构造 DOCX 字节流。paragraphs 为 (样式名或 None, 文本) 列表。"""
    document = Document()
    for style, text in paragraphs:
        paragraph = document.add_paragraph()
        if style:
            paragraph.style = document.styles[style]
        paragraph.add_run(text)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _volume_chapter_titles(result: ParseResult) -> list[list[str]]:
    """按卷分组返回章节标题，便于断言卷归属。"""
    return [[chapter.title for chapter in volume.chapters] for volume in result.volumes]


def test_parse_docx_with_heading_style() -> None:
    content = _build_docx(
        [
            ("Heading 1", "第一卷"),
            ("Heading 2", "第一章 起点"),
            (None, "他睁开眼，发现自己回到了十年前。" * 3),
            ("Heading 2", "第二章 风起"),
            (None, "江湖传言，剑冢重现于世。" * 3),
        ]
    )

    result = parse_docx_content(content)

    assert result.detected_encoding == "docx"
    assert result.chapter_count == 2
    assert [volume.title for volume in result.volumes] == ["第一卷"]
    assert [chapter.title for chapter in result.volumes[0].chapters] == [
        "第一章 起点",
        "第二章 风起",
    ]
    assert "剑冢重现" in result.volumes[0].chapters[1].content
    assert result.total_word_count > 0


def test_parse_docx_without_headings_uses_text_rules() -> None:
    body_1 = "夜色笼罩着小镇，远处传来犬吠。" * 40
    body_2 = "清晨的薄雾还未散去，商队的驼铃已经响起。" * 40
    content = _build_docx(
        [
            (None, "第一章 开始"),
            (None, body_1),
            (None, "第二章 发展"),
            (None, body_2),
        ]
    )

    result = parse_docx_content(content)

    assert result.chapter_count >= 2
    titles = [chapter.title for volume in result.volumes for chapter in volume.chapters]
    assert any("第一章" in title for title in titles)
    assert any("第二章" in title for title in titles)
    assert result.detected_encoding == "docx"


def test_parse_docx_single_body_paragraph() -> None:
    content = _build_docx([(None, "只有一段没有标题的文字。")])

    result = parse_docx_content(content)

    assert result.chapter_count == 1
    assert result.volumes[0].chapters[0].title in {"只有一段没有标题的文字。", "正文"}


def test_parse_docx_invalid_file_raises_value_error() -> None:
    with pytest.raises(ValueError, match="DOCX"):
        parse_docx_content(b"not a docx file")


def test_extract_docx_text_joins_paragraphs() -> None:
    content = _build_docx(
        [
            (None, "第一段。"),
            (None, "第二段。"),
        ]
    )

    assert extract_docx_text(content) == "第一段。\n第二段。"


def test_parse_project_import_supports_docx() -> None:
    content = _build_docx(
        [
            ("Heading 1", "第一卷"),
            ("Heading 2", "第一章"),
            (None, "正文内容若干。" * 10),
        ]
    )

    result = parse_project_import("novel.docx", content)

    assert result.chapter_count == 1
    assert result.volumes[0].title == "第一卷"


def test_parse_project_import_docx_manual_split() -> None:
    content = _build_docx(
        [
            (None, "这是一个用于手动切分的段落。" * 5),
            (None, "第二段内容同样用于切分测试。" * 5),
        ]
    )

    result = parse_project_import("novel.docx", content, split_mode="manual", chunk_size=50)

    assert result.chapter_count >= 2
    assert result.detected_encoding == "utf-8"


def test_parse_docx_preserves_short_text_before_first_heading() -> None:
    """首个卷标题之前的普通段落不能因为短而被丢弃或提升为标题。"""
    content = _build_docx(
        [
            (None, "写在最前面的一句话。"),
            ("Heading 1", "甲卷"),
            ("Heading 2", "第一章 开端"),
            (None, "第一章正文。"),
        ]
    )

    result = parse_docx_content(content)

    assert [volume.title for volume in result.volumes] == ["第一卷", "甲卷"]
    assert _volume_chapter_titles(result) == [["正文"], ["第一章 开端"]]
    assert result.volumes[0].chapters[0].content == "写在最前面的一句话。"
    assert result.volumes[1].chapters[0].content == "第一章正文。"
    assert result.chapter_count == 2


def test_parse_docx_preserves_leading_text_without_volume_heading() -> None:
    """没有卷标题时，首个章标题之前的普通段落归入默认卷。"""
    content = _build_docx(
        [
            (None, "开篇短句。"),
            ("Heading 2", "第一章 起"),
            (None, "第一章正文。"),
        ]
    )

    result = parse_docx_content(content)

    assert [volume.title for volume in result.volumes] == ["第一卷"]
    assert _volume_chapter_titles(result) == [["正文", "第一章 起"]]
    assert result.volumes[0].chapters[0].content == "开篇短句。"
    assert result.volumes[0].chapters[1].content == "第一章正文。"


def test_parse_docx_preserves_volume_preface_before_first_chapter() -> None:
    """卷标题之后、首个章标题之前的正文属于该卷。"""
    content = _build_docx(
        [
            ("Heading 1", "第一卷 风起"),
            (None, "本卷序言第一段。"),
            (None, "本卷序言第二段。"),
            ("Heading 2", "第一章 出山"),
            (None, "第一章正文。"),
        ]
    )

    result = parse_docx_content(content)

    assert [volume.title for volume in result.volumes] == ["第一卷 风起"]
    assert _volume_chapter_titles(result) == [["正文", "第一章 出山"]]
    assert result.volumes[0].chapters[0].content == "本卷序言第一段。\n本卷序言第二段。"
    assert result.volumes[0].chapters[0].word_count > 0


def test_parse_docx_preserves_body_only_volumes() -> None:
    """只有正文、没有章节标题的卷（中间卷与末尾卷）不能整卷丢失。"""
    content = _build_docx(
        [
            ("Heading 1", "第一卷"),
            ("Heading 2", "第一章"),
            (None, "第一卷正文。"),
            ("Heading 1", "第二卷"),
            (None, "第二卷只有正文第一段。"),
            (None, "第二卷只有正文第二段。"),
            ("Heading 1", "第三卷"),
            ("Heading 2", "第三章"),
            (None, "第三卷正文。"),
            ("Heading 1", "第四卷"),
            (None, "第四卷只有正文第一段。"),
            (None, "第四卷只有正文第二段。"),
        ]
    )

    result = parse_docx_content(content)

    assert [volume.title for volume in result.volumes] == [
        "第一卷",
        "第二卷",
        "第三卷",
        "第四卷",
    ]
    assert _volume_chapter_titles(result) == [["第一章"], ["正文"], ["第三章"], ["正文"]]
    assert (
        result.volumes[1].chapters[0].content
        == "第二卷只有正文第一段。\n第二卷只有正文第二段。"
    )
    assert (
        result.volumes[3].chapters[0].content
        == "第四卷只有正文第一段。\n第四卷只有正文第二段。"
    )
    assert result.volumes[3].chapters[0].word_count > 0
    assert [
        (volume.title, chapter.title)
        for volume in result.volumes
        for chapter in volume.chapters
    ] == [
        ("第一卷", "第一章"),
        ("第二卷", "正文"),
        ("第三卷", "第三章"),
        ("第四卷", "正文"),
    ]
    assert result.chapter_count == 4


def test_parse_docx_volumes_without_chapter_headings_keep_body() -> None:
    """整本只有卷标题、没有章标题时，短句与多行正文都不能被丢弃或提升为标题。"""
    content = _build_docx(
        [
            ("Heading 1", "上卷"),
            (None, "短句甲。"),
            (None, "上卷第二行。"),
            (None, "上卷第三行。"),
            ("Heading 1", "下卷"),
            (None, "短句乙。"),
            (None, "下卷第二行。"),
        ]
    )

    result = parse_docx_content(content)

    assert [volume.title for volume in result.volumes] == ["上卷", "下卷"]
    assert _volume_chapter_titles(result) == [["正文"], ["正文"]]
    contents = [
        chapter.content for volume in result.volumes for chapter in volume.chapters
    ]
    assert contents == [
        "短句甲。\n上卷第二行。\n上卷第三行。",
        "短句乙。\n下卷第二行。",
    ]
    joined = "\n".join(contents)
    for sentinel in ("短句甲。", "上卷第二行。", "上卷第三行。", "短句乙。", "下卷第二行。"):
        assert joined.count(sentinel) == 1
    assert result.chapter_count == 2
    assert result.total_word_count == sum(
        chapter.word_count for volume in result.volumes for chapter in volume.chapters
    )
    assert result.total_word_count > 0


def test_parse_docx_keeps_body_lines_in_order_exactly_once() -> None:
    """正文行保持输入顺序，且每行只出现一次。"""
    content = _build_docx(
        [
            (None, "开篇甲"),
            ("Heading 1", "甲卷"),
            (None, "卷首乙"),
            ("Heading 2", "第一章"),
            (None, "正文丙"),
            (None, "正文丁"),
        ]
    )

    result = parse_docx_content(content)

    contents = [chapter.content for volume in result.volumes for chapter in volume.chapters]
    assert contents == ["开篇甲", "卷首乙", "正文丙\n正文丁"]
    joined = "\n".join(contents)
    for sentinel in ("开篇甲", "卷首乙", "正文丙", "正文丁"):
        assert joined.count(sentinel) == 1
    assert result.total_word_count == sum(
        chapter.word_count for volume in result.volumes for chapter in volume.chapters
    )
    assert result.total_word_count > 0


def test_parse_docx_blank_paragraphs_create_no_synthetic_chapter() -> None:
    """空段落不产生合成章节。"""
    content = _build_docx(
        [
            ("Heading 1", "第一卷"),
            (None, ""),
            ("Heading 2", "第一章"),
            (None, ""),
            (None, "第一章正文。"),
            (None, ""),
        ]
    )

    result = parse_docx_content(content)

    assert _volume_chapter_titles(result) == [["第一章"]]
    assert result.volumes[0].chapters[0].content == "第一章正文。"


def test_parse_docx_empty_chapters_stay_empty() -> None:
    """连续章标题产生的空章节保持空内容，不额外生成「正文」章节。"""
    content = _build_docx(
        [
            ("Heading 1", "第一卷"),
            ("Heading 2", "第一章"),
            ("Heading 2", "第二章"),
        ]
    )

    result = parse_docx_content(content)

    assert _volume_chapter_titles(result) == [["第一章", "第二章"]]
    assert [chapter.content for chapter in result.volumes[0].chapters] == ["", ""]


def test_parse_docx_heading_only_document_keeps_text_fallback() -> None:
    """只有卷标题、没有任何章节内容时仍退回文本规则。"""
    content = _build_docx([("Heading 1", "只有卷标题")])

    result = parse_docx_content(content)

    assert result.chapter_count == 1
    assert result.volumes[0].title == "第一卷"
    assert result.volumes[0].chapters[0].title == "只有卷标题"
