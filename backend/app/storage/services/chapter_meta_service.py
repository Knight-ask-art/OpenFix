# -*- coding: utf-8 -*-
"""Chapter Meta Service - 章节状态与目标字数业务逻辑层。"""

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError, ValidationError
from app.storage.models.chapter_meta import CHAPTER_STATUSES, ChapterMeta
from app.storage.repos import chapter_meta_repo, chapter_repo

MAX_TARGET_WORD_COUNT = 10_000_000


async def _require_chapter(session: AsyncSession, chapter_id: str):
    chapter = await chapter_repo.get_by_id(session, chapter_id)
    if chapter is None:
        raise NotFoundError(f"章节不存在: {chapter_id}")
    return chapter


async def get_meta(session: AsyncSession, chapter_id: str) -> ChapterMeta:
    """获取章节附加信息；未设置时返回默认值（不落库）。"""
    chapter = await _require_chapter(session, chapter_id)
    meta = await chapter_meta_repo.get_by_chapter_id(session, chapter_id)
    if meta is None:
        return ChapterMeta(chapter_id=chapter_id, project_id=chapter.project_id)
    return meta


async def list_meta_by_project(session: AsyncSession, project_id: str) -> list[ChapterMeta]:
    """列出项目内已显式设置的章节附加信息。"""
    return await chapter_meta_repo.list_by_project(session, project_id)


async def update_meta(
    session: AsyncSession,
    chapter_id: str,
    *,
    status: str | None = None,
    target_word_count: int | None = None,
    mark_ai_check: bool = False,
) -> ChapterMeta:
    """更新章节状态与目标字数。"""
    chapter = await _require_chapter(session, chapter_id)
    values: dict[str, object] = {}

    if status is not None:
        if status not in CHAPTER_STATUSES:
            raise ValidationError(f"不支持的章节状态: {status}")
        values["status"] = status
    if target_word_count is not None:
        if target_word_count < 0 or target_word_count > MAX_TARGET_WORD_COUNT:
            raise ValidationError("本章目标字数超出允许范围")
        values["target_word_count"] = target_word_count
    if mark_ai_check:
        values["last_ai_check_at"] = datetime.now(UTC)

    return await chapter_meta_repo.upsert(
        session,
        chapter_id=chapter.id,
        project_id=chapter.project_id,
        values=values,
    )


async def record_ai_check(session: AsyncSession, chapter_id: str) -> None:
    """记录该章节最近一次一致性检查时间（不创建额外字段）。"""
    chapter = await chapter_repo.get_by_id(session, chapter_id)
    if chapter is None:
        return
    await chapter_meta_repo.upsert(
        session,
        chapter_id=chapter.id,
        project_id=chapter.project_id,
        values={"last_ai_check_at": datetime.now(UTC)},
    )


async def delete_meta_for_chapter(session: AsyncSession, chapter_id: str) -> None:
    """删除单章附加信息（章节删除时级联调用）。"""
    await chapter_meta_repo.delete_by_chapter(session, chapter_id)


async def delete_meta_for_chapters(session: AsyncSession, chapter_ids: list[str]) -> None:
    """批量删除章节附加信息。"""
    await chapter_meta_repo.delete_by_chapters(session, chapter_ids)


async def delete_meta_for_project(session: AsyncSession, project_id: str) -> None:
    """删除项目内全部章节附加信息。"""
    await chapter_meta_repo.delete_by_project(session, project_id)
