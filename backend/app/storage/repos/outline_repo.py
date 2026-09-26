# -*- coding: utf-8 -*-
"""
Outline Repository - 大纲树数据访问层。
"""

from sqlalchemy import delete as sql_delete
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.storage.models.outline import Outline


async def create(session: AsyncSession, outline: Outline) -> Outline:
    session.add(outline)
    await session.flush()
    await session.refresh(outline)
    return outline


async def get_by_id(session: AsyncSession, outline_id: str) -> Outline | None:
    result = await session.execute(
        select(Outline).where(col(Outline.id) == outline_id)
    )
    return result.scalar_one_or_none()


async def list_by_project(session: AsyncSession, project_id: str) -> list[Outline]:
    result = await session.execute(
        select(Outline)
        .where(col(Outline.project_id) == project_id)
        .order_by(col(Outline.sort_order).asc(), col(Outline.created_at).asc())
    )
    return list(result.scalars().all())


async def count_children(session: AsyncSession, project_id: str, parent_id: str | None) -> int:
    result = await session.execute(
        select(func.count(col(Outline.id))).where(
            col(Outline.project_id) == project_id,
            col(Outline.parent_id) == parent_id if parent_id is not None else col(Outline.parent_id).is_(None),
        )
    )
    return result.scalar_one()


async def get_max_sort_order(
    session: AsyncSession, project_id: str, parent_id: str | None
) -> int:
    result = await session.execute(
        select(func.max(col(Outline.sort_order))).where(
            col(Outline.project_id) == project_id,
            col(Outline.parent_id) == parent_id if parent_id is not None else col(Outline.parent_id).is_(None),
        )
    )
    max_order = result.scalar_one_or_none()
    return max_order if max_order is not None else 0


async def update_outline(session: AsyncSession, outline: Outline) -> Outline:
    session.add(outline)
    await session.flush()
    await session.refresh(outline)
    return outline


async def shift_sort_orders(
    session: AsyncSession,
    project_id: str,
    parent_id: str | None,
    start_order: int,
    delta: int,
) -> None:
    conditions = [
        col(Outline.project_id) == project_id,
        col(Outline.sort_order) >= start_order,
    ]
    if parent_id is None:
        conditions.append(col(Outline.parent_id).is_(None))
    else:
        conditions.append(col(Outline.parent_id) == parent_id)
    await session.execute(
        update(Outline).where(*conditions).values(sort_order=col(Outline.sort_order) + delta)
    )
    await session.flush()


async def delete(session: AsyncSession, outline: Outline) -> None:
    await session.delete(outline)
    await session.flush()


async def delete_subtree(session: AsyncSession, project_id: str, outline_id: str) -> int:
    """删除节点及其全部子孙，返回删除的节点数。"""
    result = await session.execute(
        select(col(Outline.id)).where(col(Outline.project_id) == project_id)
    )
    all_ids = [row_id for row_id in result.scalars().all()]
    if outline_id not in all_ids:
        return 0

    children_by_parent: dict[str | None, list[str]] = {}
    # 重新取完整行以建立父子关系。
    rows = await session.execute(select(Outline).where(col(Outline.project_id) == project_id))
    for node in rows.scalars().all():
        children_by_parent.setdefault(node.parent_id, []).append(node.id)

    to_delete: list[str] = [outline_id]
    queue = [outline_id]
    while queue:
        current = queue.pop()
        for child_id in children_by_parent.get(current, []):
            to_delete.append(child_id)
            queue.append(child_id)

    # 收尾：若删除的是根级节点，仍按项目范围删除。
    for node_id in set(to_delete):
        await session.execute(
            sql_delete(Outline).where(col(Outline.id) == node_id, col(Outline.project_id) == project_id)
        )
    await session.flush()
    return len(set(to_delete))
