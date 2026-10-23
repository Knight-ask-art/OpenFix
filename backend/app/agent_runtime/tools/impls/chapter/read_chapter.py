import hashlib
from datetime import datetime
from textwrap import dedent

from pydantic import BaseModel, Field

from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.impls.chapter.refs import (
    ChapterRef,
    VolumeRef,
    resolve_chapter_from_list,
    resolve_volume_from_list,
)
from app.agent_runtime.tools.registry import ToolRegistry
from app.storage.database import create_session
from app.storage.repos import chapter_repo, volume_repo


class ReadChapterInput(BaseModel):
    volume_ref: VolumeRef = Field(description="目标卷")
    chapter_ref: ChapterRef = Field(description="卷内的目标章节")


class ReadChapterOutput(BaseModel):
    order: int
    title: str
    content: str
    word_count: int
    chapter_id: str
    content_sha256: str
    updated_at: str | None = None


def content_sha256(content: str) -> str:
    """Exact raw UTF-8 SHA256; never hash the numbered display form."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _timestamp_text(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def format_chapter_content_with_line_numbers(content: str) -> str:
    if not content:
        return ""
    return "\n".join(
        f"{line_number}|{line}"
        for line_number, line in enumerate(content.splitlines(), start=1)
    )


@ToolRegistry.register
class ReadChapterTool(AgentTool):
    name: str = "read_chapter"
    description: str = dedent("""\
        读取指定卷内章节的完整内容
        必须使用volume_ref指定目标卷，并使用chapter_ref指定目标章节
        返回的content是按章节内从1开始的行号格式化后的结果，原始内容不含行号标记
        每个原始换行都会拆分为单独一行，并添加行号标记，格式为 `行号|内容`
        content_sha256 是原始存储正文（不含行号）按 UTF-8 原样计算的 SHA256，
        可用于 edit_chapter 的 expected_base_sha256 基线；它只标识文本版本，
        不代表内容正确或已获批准
    """)
    access_level: str = "readonly"
    args_schema: type[BaseModel] = ReadChapterInput

    async def _execute(self, volume_ref: dict, chapter_ref: dict) -> str:
        volume = VolumeRef.model_validate(volume_ref)
        ref = ChapterRef.model_validate(chapter_ref)
        session = await create_session()
        try:
            volumes = await volume_repo.list_by_project(session, self.project_id)
            resolved_volume = resolve_volume_from_list(volumes, volume)
            matched = await chapter_repo.get_by_volume_ref(
                session,
                resolved_volume.id,
                ref_type=ref.type,
                ref_value=ref.value,
            )
            match = resolve_chapter_from_list([matched] if matched is not None else [], ref)
            raw_content = match.content or ""
            return ReadChapterOutput(
                order=match.order,
                title=match.title,
                content=format_chapter_content_with_line_numbers(match.content),
                word_count=match.word_count,
                chapter_id=match.id,
                content_sha256=content_sha256(raw_content),
                updated_at=_timestamp_text(getattr(match, "updated_at", None)),
            ).model_dump_json()
        finally:
            await session.close()
