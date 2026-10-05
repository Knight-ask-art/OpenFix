import pytest

from app.agent_runtime.tools.impls.chapter.content_edit import edit_chapter_content
from app.agent_runtime.tools.impls.chapter.edit_chapter import EditChapterInput


def test_initialize_empty_chapter_without_recreation():
    assert edit_chapter_content("", "", "新正文") == "新正文"
    args = EditChapterInput(
        volume_ref={"type": "order", "value": 1},
        chapter_ref={"type": "order", "value": 1},
        old_content="",
        new_content="新正文",
    )
    assert args.old_content == ""


@pytest.mark.parametrize("existing", ["原正文", " ", "\n", "\u3000"])
def test_empty_anchor_cannot_overwrite_or_append(existing):
    assert edit_chapter_content(existing, "", "新正文") is None


def test_existing_chapter_still_uses_anchored_edit():
    assert (
        edit_chapter_content("前段。原句。后段。", "原句", "新句")
        == "前段。新句。后段。"
    )
    assert edit_chapter_content("原句", "不存在", "新句") is None
