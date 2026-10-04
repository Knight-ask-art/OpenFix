# -*- coding: utf-8 -*-
"""Outline service - 大纲树业务校验与操作。"""

from datetime import UTC, datetime
from enum import Enum

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError, ValidationError
from app.storage.models.outline import OUTLINE_LEVELS, Outline
from app.storage.repos import chapter_repo, outline_repo, volume_repo


class _Unset(Enum):
    VALUE = "unset"


UNSET = _Unset.VALUE


async def _require_project_outline(
    session: AsyncSession, project_id: str, outline_id: str
) -> Outline:
    outline = await outline_repo.get_by_id(session, outline_id)
    if outline is None or outline.project_id != project_id:
        raise NotFoundError(f"大纲节点不存在: {outline_id}")
    return outline


async def _collect_descendant_ids(
    session: AsyncSession, project_id: str, outline_id: str
) -> set[str]:
    nodes = await outline_repo.list_by_project(session, project_id)
    children_by_parent: dict[str | None, list[str]] = {}
    for node in nodes:
        children_by_parent.setdefault(node.parent_id, []).append(node.id)
    descendants: set[str] = set()
    queue = [outline_id]
    while queue:
        current = queue.pop()
        for child_id in children_by_parent.get(current, []):
            if child_id in descendants:
                continue
            descendants.add(child_id)
            queue.append(child_id)
    return descendants


def _validate_level_for_parent(parent: Outline | None, level: str) -> None:
    if parent is None:
        return
    parent_rank = OUTLINE_LEVELS.index(parent.level)
    child_rank = OUTLINE_LEVELS.index(level)
    if child_rank <= parent_rank:
        raise ValidationError(
            f"子节点层级（{level}）必须比父节点（{parent.level}）更细"
        )


async def _validate_story_links(
    session: AsyncSession,
    *,
    project_id: str,
    volume_id: str | None,
    chapter_id: str | None,
) -> None:
    if volume_id is not None:
        volume = await volume_repo.get_by_id(session, volume_id)
        if volume is None or volume.project_id != project_id:
            raise ValidationError("关联卷不存在或不属于当前项目")
    if chapter_id is not None:
        chapter = await chapter_repo.get_by_id(session, chapter_id)
        if chapter is None or chapter.project_id != project_id:
            raise ValidationError("关联章节不存在或不属于当前项目")
        if volume_id is not None and chapter.volume_id != volume_id:
            raise ValidationError("关联章节必须属于所选卷")


async def create_outline(
    session: AsyncSession,
    *,
    project_id: str,
    level: str,
    title: str,
    content: str,
    parent_id: str | None,
    volume_id: str | None,
    chapter_id: str | None,
) -> Outline:
    parent: Outline | None = None
    if parent_id is not None:
        parent = await _require_project_outline(session, project_id, parent_id)
    if level not in OUTLINE_LEVELS:
        raise ValidationError(f"大纲层级无效: {level}")
    _validate_level_for_parent(parent, level)
    await _validate_story_links(
        session,
        project_id=project_id,
        volume_id=volume_id,
        chapter_id=chapter_id,
    )

    max_order = await outline_repo.get_max_sort_order(session, project_id, parent_id)
    outline = Outline(
        project_id=project_id,
        parent_id=parent_id,
        volume_id=volume_id,
        chapter_id=chapter_id,
        level=level,
        title=title.strip()[:200],
        content=content,
        sort_order=max_order + 1,
    )
    return await outline_repo.create(session, outline)


async def list_outlines(session: AsyncSession, project_id: str) -> list[Outline]:
    return await outline_repo.list_by_project(session, project_id)


async def update_outline(
    session: AsyncSession,
    *,
    project_id: str,
    outline_id: str,
    title: str | None,
    content: str | None,
    level: str | None,
    parent_id: str | None | _Unset = UNSET,
    sort_order: int | None,
    volume_id: str | None | _Unset = UNSET,
    chapter_id: str | None | _Unset = UNSET,
) -> Outline:
    outline = await _require_project_outline(session, project_id, outline_id)

    if level is not None and level not in OUTLINE_LEVELS:
        raise ValidationError(f"大纲层级无效: {level}")

    next_parent_id = outline.parent_id if isinstance(parent_id, _Unset) else parent_id
    if next_parent_id != outline.parent_id:
        if next_parent_id == outline_id:
            raise ValidationError("大纲节点不能作为自己的父节点")
        descendants = await _collect_descendant_ids(session, project_id, outline_id)
        if next_parent_id is not None and next_parent_id in descendants:
            raise ValidationError("大纲节点不能移动到自己的子节点下")
    parent = (
        await _require_project_outline(session, project_id, next_parent_id)
        if next_parent_id is not None
        else None
    )
    effective_level = level or outline.level
    _validate_level_for_parent(parent, effective_level)

    if effective_level != outline.level:
        nodes = await outline_repo.list_by_project(session, project_id)
        child_rank = OUTLINE_LEVELS.index(effective_level)
        for child in nodes:
            if child.parent_id == outline.id and OUTLINE_LEVELS.index(child.level) <= child_rank:
                raise ValidationError(
                    f"当前层级无法包含层级为（{child.level}）的子节点"
                )
        outline.level = effective_level

    outline.parent_id = next_parent_id

    if title is not None:
        outline.title = title.strip()[:200]
    if content is not None:
        outline.content = content
    if sort_order is not None:
        outline.sort_order = sort_order
    effective_chapter_id = outline.chapter_id if isinstance(chapter_id, _Unset) else chapter_id
    effective_volume_id = outline.volume_id if isinstance(volume_id, _Unset) else volume_id
    if isinstance(chapter_id, str) and isinstance(volume_id, _Unset):
        chapter = await chapter_repo.get_by_id(session, chapter_id)
        if chapter is not None:
            effective_volume_id = chapter.volume_id
    await _validate_story_links(
        session,
        project_id=project_id,
        volume_id=effective_volume_id,
        chapter_id=effective_chapter_id,
    )
    outline.volume_id = effective_volume_id
    outline.chapter_id = effective_chapter_id

    outline.updated_at = datetime.now(UTC)

    return await outline_repo.update_outline(session, outline)


async def reorder_outline_siblings(
    session: AsyncSession,
    *,
    project_id: str,
    parent_id: str | None,
    node_ids: list[str],
) -> int:
    """只接受项目内完整的同级节点集合，避免拖动后遗漏或跨层级改序。"""
    if parent_id is not None:
        await _require_project_outline(session, project_id, parent_id)
    nodes = await outline_repo.list_by_project(session, project_id)
    sibling_ids = {
        node.id for node in nodes if node.parent_id == parent_id
    }
    if len(node_ids) != len(set(node_ids)) or set(node_ids) != sibling_ids:
        raise ValidationError("排序请求必须包含当前父节点下的全部节点，且不能重复")
    await outline_repo.update_sort_orders(session, node_ids)
    return len(node_ids)


async def delete_outline(session: AsyncSession, *, project_id: str, outline_id: str) -> int:
    await _require_project_outline(session, project_id, outline_id)
    return await outline_repo.delete_subtree(session, project_id, outline_id)
