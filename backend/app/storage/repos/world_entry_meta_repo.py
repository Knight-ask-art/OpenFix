# -*- coding: utf-8 -*-
"""World Entry Meta Repository - 世界设定扩展信息数据访问层。"""

import json
from datetime import UTC, datetime

from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.storage.models.world_entry_meta import WorldEntryMeta
from app.storage.models.world_info_entry import WorldInfoEntry


def _load_ids(raw: str) -> list[str]:
    try:
        parsed = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if isinstance(item, str) and item]


def _dump_ids(values: list[str]) -> str:
    return json.dumps(list(dict.fromkeys(values)), ensure_ascii=False)


async def get_by_entry_id(session: AsyncSession, entry_id: str) -> WorldEntryMeta | None:
    """按世界书条目 ID 获取扩展信息。"""
    result = await session.execute(
        select(WorldEntryMeta).where(col(WorldEntryMeta.entry_id) == entry_id)
    )
    return result.scalar_one_or_none()


async def list_by_project(session: AsyncSession, project_id: str) -> list[WorldEntryMeta]:
    """列出项目内全部设定扩展信息。"""
    result = await session.execute(
        select(WorldEntryMeta).where(col(WorldEntryMeta.project_id) == project_id)
    )
    return list(result.scalars().all())


async def upsert(
    session: AsyncSession,
    *,
    entry_id: str,
    project_id: str,
    entry_type: str | None = None,
    tags: list[str] | None = None,
    linked_character_ids: list[str] | None = None,
    linked_chapter_ids: list[str] | None = None,
    ai_visible: bool | None = None,
    custom_type_label: str | None = None,
) -> WorldEntryMeta:
    """创建或更新世界设定扩展信息。"""
    meta = await get_by_entry_id(session, entry_id)
    if meta is None:
        meta = WorldEntryMeta(entry_id=entry_id, project_id=project_id)
    if entry_type is not None:
        meta.entry_type = entry_type
    if tags is not None:
        meta.tags_json = json.dumps(
            [tag.strip() for tag in tags if tag.strip()], ensure_ascii=False
        )
    if linked_character_ids is not None:
        meta.linked_character_ids_json = _dump_ids(linked_character_ids)
    if linked_chapter_ids is not None:
        meta.linked_chapter_ids_json = _dump_ids(linked_chapter_ids)
    if ai_visible is not None:
        meta.ai_visible = ai_visible
    if custom_type_label is not None:
        meta.custom_type_label = custom_type_label.strip()[:100]
    meta.updated_at = datetime.now(UTC)
    session.add(meta)
    await session.flush()
    await session.refresh(meta)
    return meta


async def delete_by_entry_id(session: AsyncSession, entry_id: str) -> None:
    """删除世界书条目的扩展信息。"""
    await session.execute(
        sql_delete(WorldEntryMeta).where(col(WorldEntryMeta.entry_id) == entry_id)
    )
    await session.flush()


async def delete_by_world_info(session: AsyncSession, world_info_id: str) -> None:
    """删除世界书内全部条目的扩展信息（须在删除条目之前调用）。"""
    entry_ids = select(col(WorldInfoEntry.id)).where(
        col(WorldInfoEntry.world_info_id) == world_info_id
    )
    await session.execute(
        sql_delete(WorldEntryMeta).where(col(WorldEntryMeta.entry_id).in_(entry_ids))
    )
    await session.flush()


async def delete_by_world_info_and_entry_ids(
    session: AsyncSession, world_info_id: str, entry_ids: list[str]
) -> None:
    """删除指定世界书内指定条目的扩展信息（须在删除条目之前调用）。

    条目 ID 由子查询按 world_info_id 限定，因此不属于该世界书的 ID 会被忽略。
    """
    if not entry_ids:
        return
    matched_entry_ids = select(col(WorldInfoEntry.id)).where(
        col(WorldInfoEntry.world_info_id) == world_info_id,
        col(WorldInfoEntry.id).in_(entry_ids),
    )
    await session.execute(
        sql_delete(WorldEntryMeta).where(
            col(WorldEntryMeta.entry_id).in_(matched_entry_ids)
        )
    )
    await session.flush()


async def delete_by_project(session: AsyncSession, project_id: str) -> None:
    """删除项目内全部条目扩展信息。"""
    await session.execute(
        sql_delete(WorldEntryMeta).where(col(WorldEntryMeta.project_id) == project_id)
    )
    await session.flush()


def _without_ids(existing: list[str], removed: set[str]) -> list[str]:
    return [item for item in existing if item not in removed]


async def _remove_linked_ids(
    session: AsyncSession,
    project_id: str,
    field_name: str,
    removed_ids: list[str],
) -> None:
    """从项目内条目扩展信息中移除已失效的关联 ID。"""
    removed = {item for item in removed_ids if item}
    if not removed:
        return
    for meta in await list_by_project(session, project_id):
        existing = _load_ids(getattr(meta, field_name))
        remaining = _without_ids(existing, removed)
        if len(remaining) == len(existing):
            continue
        setattr(meta, field_name, _dump_ids(remaining))
        meta.updated_at = datetime.now(UTC)
        session.add(meta)
    await session.flush()


async def remove_character_links(
    session: AsyncSession, project_id: str, character_ids: list[str]
) -> None:
    """移除已删除人物在条目扩展信息中的关联。"""
    await _remove_linked_ids(
        session, project_id, "linked_character_ids_json", character_ids
    )


async def remove_chapter_links(
    session: AsyncSession, project_id: str, chapter_ids: list[str]
) -> None:
    """移除已删除章节在条目扩展信息中的关联。"""
    await _remove_linked_ids(session, project_id, "linked_chapter_ids_json", chapter_ids)


def get_tags(meta: WorldEntryMeta) -> list[str]:
    """读取标签列表。"""
    try:
        parsed = json.loads(meta.tags_json or "[]")
    except (TypeError, ValueError):
        return []
    return [str(item) for item in parsed if isinstance(item, str) and item] if isinstance(parsed, list) else []


def get_linked_character_ids(meta: WorldEntryMeta) -> list[str]:
    """读取关联人物 ID。"""
    return _load_ids(meta.linked_character_ids_json)


def get_linked_chapter_ids(meta: WorldEntryMeta) -> list[str]:
    """读取关联章节 ID。"""
    return _load_ids(meta.linked_chapter_ids_json)
