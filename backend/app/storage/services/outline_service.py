# -*- coding: utf-8 -*-
"""Outline service - 大纲树业务校验与操作。"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError, ValidationError
from app.storage.models.outline import OUTLINE_LEVELS, Outline
from app.storage.repos import outline_repo


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
    parent_id: str | None,
    sort_order: int | None,
    volume_id: str | None,
    chapter_id: str | None,
) -> Outline:
    outline = await _require_project_outline(session, project_id, outline_id)

    if parent_id is not None and parent_id != outline.parent_id:
        if parent_id == outline_id:
            raise ValidationError("大纲节点不能作为自己的父节点")
        descendants = await _collect_descendant_ids(session, project_id, outline_id)
        if parent_id in descendants:
            raise ValidationError("大纲节点不能移动到自己的子节点下")
        parent = await _require_project_outline(session, project_id, parent_id)
        effective_level = level or outline.level
        _validate_level_for_parent(parent, effective_level)
        outline.parent_id = parent_id

    if level is not None and level != outline.level:
        if level not in OUTLINE_LEVELS:
            raise ValidationError(f"大纲层级无效: {level}")
        outline.level = level

    if title is not None:
        outline.title = title.strip()[:200]
    if content is not None:
        outline.content = content
    if sort_order is not None:
        outline.sort_order = sort_order
    if volume_id is not None:
        outline.volume_id = volume_id
    if chapter_id is not None:
        outline.chapter_id = chapter_id

    return await outline_repo.update_outline(session, outline)


async def delete_outline(session: AsyncSession, *, project_id: str, outline_id: str) -> int:
    await _require_project_outline(session, project_id, outline_id)
    return await outline_repo.delete_subtree(session, project_id, outline_id)
