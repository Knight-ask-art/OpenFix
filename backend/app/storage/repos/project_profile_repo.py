# -*- coding: utf-8 -*-
"""Project Profile Repository - 项目产品属性数据访问层。"""

from datetime import UTC, datetime

from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.storage.models.project_profile import ProjectProfile

PROFILE_FIELDS: tuple[str, ...] = (
    "genre",
    "synopsis",
    "target_word_count",
    "daily_word_goal",
    "status",
)


async def get_by_project_id(session: AsyncSession, project_id: str) -> ProjectProfile | None:
    """按项目 ID 获取产品属性。"""
    result = await session.execute(
        select(ProjectProfile).where(col(ProjectProfile.project_id) == project_id)
    )
    return result.scalar_one_or_none()


async def upsert(
    session: AsyncSession,
    project_id: str,
    values: dict[str, object],
) -> ProjectProfile:
    """创建或更新项目产品属性。"""
    profile = await get_by_project_id(session, project_id)
    if profile is None:
        profile = ProjectProfile(project_id=project_id)
    for field in PROFILE_FIELDS:
        if field in values and values[field] is not None:
            setattr(profile, field, values[field])
    profile.updated_at = datetime.now(UTC)
    session.add(profile)
    await session.flush()
    await session.refresh(profile)
    return profile


async def delete_by_project(session: AsyncSession, project_id: str) -> None:
    """删除项目产品属性。"""
    await session.execute(
        sql_delete(ProjectProfile).where(col(ProjectProfile.project_id) == project_id)
    )
    await session.flush()
