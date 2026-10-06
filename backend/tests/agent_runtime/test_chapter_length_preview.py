from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.agent_runtime.tools.impls.chapter import diff_preview
from app.core.word_count import count_words


@pytest.fixture
def preview_records(monkeypatch):
    volume = SimpleNamespace(id="v", title="卷一")
    chapter = SimpleNamespace(
        id="c", project_id="p", volume_id="v", title="章节", content="旧正文。", order=1, word_count=99
    )
    monkeypatch.setattr(diff_preview, "_resolve_volume", AsyncMock(return_value=volume))
    monkeypatch.setattr(diff_preview, "_resolve_chapter", AsyncMock(return_value=chapter))
    monkeypatch.setattr(diff_preview, "_resolve_write_order", AsyncMock(return_value=2))
    return chapter


@pytest.mark.asyncio
async def test_edit_preview_counts_candidate_instead_of_old_metadata(preview_records):
    result = await diff_preview.build_edit_chapter_tool_result_preview(
        object(), "p", volume_ref={}, chapter_ref={}, old_content="旧正文。", new_content="新正文，Hello world!"
    )
    assert result["chapter"]["word_count"] == count_words("新正文，Hello world!")
    assert preview_records.content == "旧正文。"
    assert preview_records.word_count == 99


@pytest.mark.asyncio
async def test_stale_anchor_returns_actionable_preview_without_manuscript(preview_records):
    result = await diff_preview.build_edit_chapter_tool_result_preview(
        object(), "p", volume_ref={}, chapter_ref={}, old_content="过期候选", new_content="另一版正文"
    )
    assert result["success"] is False
    assert result["code"] == "stale_chapter_anchor"
    assert "重新读取" in result["message"]
    assert "chapter" not in result
    assert preview_records.content == "旧正文。"


@pytest.mark.asyncio
async def test_write_preview_does_not_trust_supplied_count(preview_records):
    result = await diff_preview.build_write_chapter_tool_result_preview(
        object(), "p", volume_ref={}, title="新章", content="你好，世界！", word_count=9000
    )
    assert result["chapter"]["word_count"] == 4
