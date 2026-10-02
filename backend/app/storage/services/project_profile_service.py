# -*- coding: utf-8 -*-
"""Project Profile Service - 项目产品属性业务逻辑层。"""

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError, ValidationError
from app.storage.models.project_profile import ProjectProfile
from app.storage.repos import project_profile_repo, project_repo

VALID_PROJECT_STATUSES = ("planning", "drafting", "revising", "completed")
MAX_TARGET_WORD_COUNT = 100_000_000


async def get_profile(session: AsyncSession, project_id: str) -> ProjectProfile:
    """获取项目产品属性；未设置时返回默认值（不落库）。"""
    project = await project_repo.get_by_id(session, project_id)
    if project is None:
        raise NotFoundError(f"项目不存在: {project_id}")
    profile = await project_profile_repo.get_by_project_id(session, project_id)
    if profile is None:
        return ProjectProfile(project_id=project_id)
    return profile


async def update_profile(
    session: AsyncSession,
    project_id: str,
    *,
    genre: str | None = None,
    synopsis: str | None = None,
    target_word_count: int | None = None,
    daily_word_goal: int | None = None,
    status: str | None = None,
) -> ProjectProfile:
    """更新项目产品属性。"""
    await get_profile(session, project_id)
    values: dict[str, object] = {}

    if genre is not None:
        values["genre"] = genre.strip()[:50]
    if synopsis is not None:
        values["synopsis"] = synopsis.strip()
    if target_word_count is not None:
        if target_word_count < 0 or target_word_count > MAX_TARGET_WORD_COUNT:
            raise ValidationError("预计字数超出允许范围")
        values["target_word_count"] = target_word_count
    if daily_word_goal is not None:
        if daily_word_goal < 0 or daily_word_goal > MAX_TARGET_WORD_COUNT:
            raise ValidationError("每日目标超出允许范围")
        values["daily_word_goal"] = daily_word_goal
    if status is not None:
        if status not in VALID_PROJECT_STATUSES:
            raise ValidationError(f"不支持的项目状态: {status}")
        values["status"] = status

    return await project_profile_repo.upsert(session, project_id, values)


async def delete_profile(session: AsyncSession, project_id: str) -> None:
    """删除项目产品属性（项目删除时级联调用）。"""
    await project_profile_repo.delete_by_project(session, project_id)


def default_updated_at() -> datetime:
    """返回当前 UTC 时间，用于响应默认值。"""
    return datetime.now(UTC)
