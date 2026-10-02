# -*- coding: utf-8 -*-
"""World Entry Meta Service - 世界设定扩展信息业务逻辑层。"""

from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError, ValidationError
from app.storage.models.world_entry_meta import (
    DEFAULT_WORLD_ENTRY_TYPE,
    WORLD_ENTRY_TYPES,
    WorldEntryMeta,
)
from app.storage.repos import (
    character_repo,
    chapter_repo,
    world_entry_meta_repo,
    world_info_entry_repo,
    world_info_repo,
)

MAX_TAGS = 50
MAX_TAG_LENGTH = 50
MAX_LINKS = 200


@dataclass
class WorldEntryMetaView:
    """世界设定扩展信息视图对象。"""

    entry_id: str
    project_id: str
    entry_type: str = DEFAULT_WORLD_ENTRY_TYPE
    custom_type_label: str = ""
    tags: list[str] = field(default_factory=list)
    linked_character_ids: list[str] = field(default_factory=list)
    linked_chapter_ids: list[str] = field(default_factory=list)
    ai_visible: bool = True
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))


def _to_view(meta: WorldEntryMeta) -> WorldEntryMetaView:
    return WorldEntryMetaView(
        entry_id=meta.entry_id,
        project_id=meta.project_id,
        entry_type=meta.entry_type,
        custom_type_label=meta.custom_type_label,
        tags=world_entry_meta_repo.get_tags(meta),
        linked_character_ids=world_entry_meta_repo.get_linked_character_ids(meta),
        linked_chapter_ids=world_entry_meta_repo.get_linked_chapter_ids(meta),
        ai_visible=meta.ai_visible,
        updated_at=meta.updated_at,
    )


async def _resolve_project_id(session: AsyncSession, entry_id: str) -> str:
    entry = await world_info_entry_repo.get_by_id(session, entry_id)
    if entry is None:
        raise NotFoundError(f"世界书条目不存在: {entry_id}")
    world_info = await world_info_repo.get_by_id(session, entry.world_info_id)
    if world_info is None or not world_info.project_id:
        raise NotFoundError(f"世界书条目未关联项目: {entry_id}")
    return world_info.project_id


def _validate_type(entry_type: str) -> str:
    normalized = entry_type.strip()
    if normalized not in WORLD_ENTRY_TYPES:
        raise ValidationError(f"不支持的设定类型: {entry_type}")
    return normalized


def _normalize_tags(tags: list[str]) -> list[str]:
    normalized: list[str] = []
    for tag in tags:
        stripped = tag.strip()[:MAX_TAG_LENGTH]
        if stripped and stripped not in normalized:
            normalized.append(stripped)
    if len(normalized) > MAX_TAGS:
        raise ValidationError(f"标签数量不能超过 {MAX_TAGS} 个")
    return normalized


async def _validate_links(
    session: AsyncSession, project_id: str, character_ids: list[str], chapter_ids: list[str]
) -> tuple[list[str], list[str]]:
    unique_characters = list(dict.fromkeys(character_ids))
    unique_chapters = list(dict.fromkeys(chapter_ids))
    if len(unique_characters) > MAX_LINKS or len(unique_chapters) > MAX_LINKS:
        raise ValidationError(f"关联数量不能超过 {MAX_LINKS} 个")

    if unique_characters:
        found = await character_repo.list_by_project_and_ids(
            session, project_id, unique_characters
        )
        found_ids = {character.id for character in found}
        missing = [item for item in unique_characters if item not in found_ids]
        if missing:
            raise ValidationError(f"关联人物不存在于当前项目: {missing[0]}")

    for chapter_id in unique_chapters:
        chapter = await chapter_repo.get_by_id(session, chapter_id)
        if chapter is None or chapter.project_id != project_id:
            raise ValidationError(f"关联章节不存在于当前项目: {chapter_id}")

    return unique_characters, unique_chapters


async def get_meta(session: AsyncSession, entry_id: str) -> WorldEntryMetaView:
    """获取条目扩展信息；未设置时返回默认值。"""
    project_id = await _resolve_project_id(session, entry_id)
    meta = await world_entry_meta_repo.get_by_entry_id(session, entry_id)
    if meta is None:
        return WorldEntryMetaView(entry_id=entry_id, project_id=project_id)
    return _to_view(meta)


async def list_meta_by_project(
    session: AsyncSession, project_id: str
) -> list[WorldEntryMetaView]:
    """列出项目内全部条目扩展信息（仅返回已显式设置的条目）。"""
    metas = await world_entry_meta_repo.list_by_project(session, project_id)
    return [_to_view(meta) for meta in metas]


async def update_meta(
    session: AsyncSession,
    entry_id: str,
    *,
    entry_type: str | None = None,
    custom_type_label: str | None = None,
    tags: list[str] | None = None,
    linked_character_ids: list[str] | None = None,
    linked_chapter_ids: list[str] | None = None,
    ai_visible: bool | None = None,
) -> WorldEntryMetaView:
    """更新条目扩展信息。"""
    project_id = await _resolve_project_id(session, entry_id)

    resolved_type = _validate_type(entry_type) if entry_type is not None else None
    resolved_tags = _normalize_tags(tags) if tags is not None else None
    resolved_characters: list[str] | None = None
    resolved_chapters: list[str] | None = None
    if linked_character_ids is not None or linked_chapter_ids is not None:
        # 未提供的关联字段沿用已保存的值，校验时同样按生效后的完整关联判断
        existing = await world_entry_meta_repo.get_by_entry_id(session, entry_id)
        effective_characters = (
            linked_character_ids
            if linked_character_ids is not None
            else (
                world_entry_meta_repo.get_linked_character_ids(existing)
                if existing is not None
                else []
            )
        )
        effective_chapters = (
            linked_chapter_ids
            if linked_chapter_ids is not None
            else (
                world_entry_meta_repo.get_linked_chapter_ids(existing)
                if existing is not None
                else []
            )
        )
        resolved_characters, resolved_chapters = await _validate_links(
            session,
            project_id,
            effective_characters,
            effective_chapters,
        )

    meta = await world_entry_meta_repo.upsert(
        session,
        entry_id=entry_id,
        project_id=project_id,
        entry_type=resolved_type,
        tags=resolved_tags,
        linked_character_ids=resolved_characters,
        linked_chapter_ids=resolved_chapters,
        ai_visible=ai_visible,
        custom_type_label=custom_type_label,
    )
    return _to_view(meta)


async def delete_meta_for_entry(session: AsyncSession, entry_id: str) -> None:
    """删除条目扩展信息（条目删除时级联调用）。"""
    await world_entry_meta_repo.delete_by_entry_id(session, entry_id)


async def is_entry_ai_visible(session: AsyncSession, entry_id: str) -> bool:
    """条目是否对 AI 可见（未设置时默认可见）。"""
    meta = await world_entry_meta_repo.get_by_entry_id(session, entry_id)
    return True if meta is None else meta.ai_visible
