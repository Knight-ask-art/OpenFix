# -*- coding: utf-8 -*-
"""Project Profile Router - 项目产品属性 API。"""

from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.project_profile import (
    ProjectProfileResponse,
    ProjectProfileUpdateRequest,
)
from app.core.errors import NotFoundError, ValidationError
from app.storage.database import get_session
from app.storage.models.project_profile import ProjectProfile
from app.storage.services import project_profile_service

router = APIRouter(tags=["projects"])


def to_response(profile: ProjectProfile) -> ProjectProfileResponse:
    """转换项目产品属性响应。"""
    status_value = profile.status or "drafting"
    if status_value not in ("planning", "drafting", "revising", "completed"):
        status_value = "drafting"
    return ProjectProfileResponse(
        project_id=profile.project_id,
        genre=profile.genre,
        synopsis=profile.synopsis,
        target_word_count=profile.target_word_count,
        daily_word_goal=profile.daily_word_goal,
        status=cast(Literal["planning", "drafting", "revising", "completed"], status_value),
        updated_at=profile.updated_at,
    )


@router.get(
    "/projects/{project_id}/profile",
    response_model=ProjectProfileResponse,
    summary="获取项目产品属性",
)
async def get_project_profile(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ProjectProfileResponse:
    """获取类型、简介、预计字数与每日目标；未设置时返回默认值。"""
    try:
        profile = await project_profile_service.get_profile(session, project_id)
        return to_response(profile)
    except NotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.put(
    "/projects/{project_id}/profile",
    response_model=ProjectProfileResponse,
    summary="更新项目产品属性",
)
async def update_project_profile(
    project_id: str,
    data: ProjectProfileUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ProjectProfileResponse:
    """更新项目产品属性；不影响项目标题与简介字段。"""
    try:
        profile = await project_profile_service.update_profile(
            session,
            project_id,
            genre=data.genre,
            synopsis=data.synopsis,
            target_word_count=data.target_word_count,
            daily_word_goal=data.daily_word_goal,
            status=data.status,
        )
        return to_response(profile)
    except NotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except ValidationError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
