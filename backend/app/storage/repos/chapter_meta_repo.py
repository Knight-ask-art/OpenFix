# -*- coding: utf-8 -*-
"""Chapter Meta Repository - 章节状态与目标字数数据访问层。"""

from datetime import UTC, datetime

from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.storage.models.chapter_meta import ChapterMeta

META_FIELDS: tuple[str, ...] = ("status", "target_word_count", "last_ai_check_at")


async def get_by_chapter_id(session: AsyncSession, chapter_id: str) -> ChapterMeta | None:
    """按章节 ID 获取附加信息。"""
    result = await session.execute(
        select(ChapterMeta).where(col(ChapterMeta.chapter_id) == chapter_id)
    )
    return result.scalar_one_or_none()


async def list_by_project(session: AsyncSession, project_id: str) -> list[ChapterMeta]:
    """列出项目内全部章节附加信息。"""
    result = await session.execute(
        select(ChapterMeta).where(col(ChapterMeta.project_id) == project_id)
    )
    return list(result.scalars().all())


async def upsert(
    session: AsyncSession,
    *,
    chapter_id: str,
    project_id: str,
    values: dict[str, object],
) -> ChapterMeta:
    """创建或更新章节附加信息。"""
    meta = await get_by_chapter_id(session, chapter_id)
    if meta is None:
        meta = ChapterMeta(chapter_id=chapter_id, project_id=project_id)
    for field in META_FIELDS:
        if field in values and values[field] is not None:
            setattr(meta, field, values[field])
    meta.updated_at = datetime.now(UTC)
    session.add(meta)
    await session.flush()
    await session.refresh(meta)
    return meta


async def delete_by_chapter(session: AsyncSession, chapter_id: str) -> None:
    """删除单章附加信息。"""
    await session.execute(
        sql_delete(ChapterMeta).where(col(ChapterMeta.chapter_id) == chapter_id)
    )
    await session.flush()


async def delete_by_chapters(session: AsyncSession, chapter_ids: list[str]) -> None:
    """批量删除章节附加信息。"""
    if not chapter_ids:
        return
    await session.execute(
        sql_delete(ChapterMeta).where(col(ChapterMeta.chapter_id).in_(chapter_ids))
    )
    await session.flush()


async def delete_by_project(session: AsyncSession, project_id: str) -> None:
    """删除项目内全部章节附加信息。"""
    await session.execute(
        sql_delete(ChapterMeta).where(col(ChapterMeta.project_id) == project_id)
    )
    await session.flush()
