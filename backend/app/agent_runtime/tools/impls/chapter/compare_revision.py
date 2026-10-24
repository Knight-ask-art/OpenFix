"""Bounded, version-bound evidence for reviewing an unsaved revision."""

import json

from pydantic import BaseModel, ConfigDict, Field

from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.chapter.diff_preview import (
    ChapterPreviewData,
    build_chapter_diff_preview,
)
from app.agent_runtime.tools.impls.chapter.measure_text import content_sha256
from app.agent_runtime.tools.registry import ToolRegistry
from app.core.utils.tiktoken import count_tokens
from app.core.word_count import count_words


class CompareRevisionInput(BaseModel):
    model_config = ConfigDict(hide_input_in_errors=True)
    before: str = Field(description="修订基稿全文，最多24000字符、1000行")
    after: str = Field(description="修订候选全文，最多24000字符、1000行；不保存")
    expected_before_sha256: str = Field(
        pattern=r"^[0-9a-fA-F]{64}$", description="基稿已有的精确UTF8哈希，不猜测"
    )
    expected_after_sha256: str = Field(
        pattern=r"^[0-9a-fA-F]{64}$", description="最终候选实测的精确UTF8哈希"
    )
    preserve_exact: list[str] = Field(
        default_factory=list, max_length=12,
        description="明确要求字面保留的片段，最多12项、每项500字符；不证明事实语义未变",
    )


@ToolRegistry.register
class CompareRevisionTool(AgentTool):
    name: str = "compare_revision"
    description: str = (
        "只读比较未保存基稿与修订稿，核对前后实测哈希，返回有界变化行和字面保留结果。"
        "供Reviewer核对新引入/删除的事实、人物认知、伤势与资源变化；"
        "不调用模型，不写正文，不判断语义正确，不代表已审通过。截短输出必须补查原稿。"
    )
    access_level: str = "readonly"
    args_schema: type[BaseModel] = CompareRevisionInput

    async def _execute(
        self, before: str, after: str, expected_before_sha256: str,
        expected_after_sha256: str, preserve_exact: list[str] | None = None,
    ) -> str:
        for text in (before, after):
            if len(text) > 24_000 or len(text.splitlines()) > 1000:
                raise ToolExecutionError("只比较单章候选，输入超过24000字符或1000行。", code="limit_exceeded")
        if content_sha256(before) != expected_before_sha256.lower():
            raise ToolExecutionError("基稿哈希不匹配，请重新确认版本。", code="conflict")
        if content_sha256(after) != expected_after_sha256.lower():
            raise ToolExecutionError("修订稿哈希不匹配，请测量当前候选。", code="conflict")
        preserve = preserve_exact or []
        if len(preserve) > 12 or any(not s or len(s) > 500 for s in preserve):
            raise ToolExecutionError("字面保留项必须为1—500字符，最多12项。", code="validation_error")
        checks = [
            {"index": i, "status": "not_in_base" if s not in before else "present" if s in after else "missing"}
            for i, s in enumerate(preserve)
        ]
        preview = build_chapter_diff_preview(
            ChapterPreviewData(None, "", "", "", before),
            ChapterPreviewData(None, "", "", "", after),
        )
        lines = [line for section in preview["sections"] for line in section["lines"]]
        excerpts = []
        tokens = 0
        for line in lines:
            item = {**line, "text": line["text"][:240], "truncated": len(line["text"]) > 240}
            size = count_tokens(json.dumps(item, ensure_ascii=False))
            if len(excerpts) >= 24 or tokens + size > 1600:
                break
            excerpts.append(item)
            tokens += size
        return json.dumps({
            "before_sha256": content_sha256(before), "after_sha256": content_sha256(after),
            "before_words": count_words(before), "after_words": count_words(after),
            "changed_lines": len(lines), "shown_lines": len(excerpts),
            "partial": len(excerpts) < len(lines) or any(x["truncated"] for x in excerpts),
            "changes": excerpts, "preserve_checks": checks,
            "semantic_review_required": True, "approved": False,
            "review_scope": "只证明差异与字面保留；核新增/删除事实及来源、知情范围、伤势、资源与时序，证据不足标未验证。",
        }, ensure_ascii=False)
