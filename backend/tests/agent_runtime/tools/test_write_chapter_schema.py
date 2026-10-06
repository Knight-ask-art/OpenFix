from app.agent_runtime.tools.impls.chapter.write_chapter import WriteChapterInput


def test_append_does_not_require_existing_chapter_anchor():
    args = WriteChapterInput(
        volume_ref={"type": "order", "value": 1},
        title="第二章",
        content="新章节正文",
    )
    assert args.chapter_ref is None
    description = WriteChapterInput.model_json_schema()["properties"]["chapter_ref"]["description"]
    assert "已存在章节" in description
    assert "省略" in description
    assert "不要传新章节的序号或标题" in description
