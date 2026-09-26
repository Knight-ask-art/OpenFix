# -*- coding: utf-8 -*-
"""Outline Router - 大纲树 API。"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.outline import (
    OutlineCreate,
    OutlineDeleteResponse,
    OutlineListResponse,
    OutlineResponse,
    OutlineUpdate,
)
from app.core.errors import ValidationError
from app.storage.database import get_session
from app.storage.services import outline_service

router = APIRouter(tags=["outlines"])


def _to_response(outline) -> OutlineResponse:
    return OutlineResponse.model_validate(outline, from_attributes=True)


@router.get(
    "/projects/{project_id}/outlines",
    response_model=OutlineListResponse,
    summary="获取项目大纲全量节点",
)
async def list_outlines(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> OutlineListResponse:
    items = await outline_service.list_outlines(session, project_id)
    return OutlineListResponse(
        items=[_to_response(item) for item in items],
        total=len(items),
    )


@router.post(
    "/projects/{project_id}/outlines",
    response_model=OutlineResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建大纲节点",
)
async def create_outline(
    project_id: str,
    data: OutlineCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> OutlineResponse:
    try:
        outline = await outline_service.create_outline(
            session,
            project_id=project_id,
            level=data.level,
            title=data.title,
            content=data.content,
            parent_id=data.parent_id,
            volume_id=data.volume_id,
            chapter_id=data.chapter_id,
        )
    except ValidationError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    await session.commit()
    return _to_response(outline)


@router.patch(
    "/projects/{project_id}/outlines/{outline_id}",
    response_model=OutlineResponse,
    summary="更新大纲节点",
)
async def update_outline(
    project_id: str,
    outline_id: str,
    data: OutlineUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> OutlineResponse:
    try:
        outline = await outline_service.update_outline(
            session,
            project_id=project_id,
            outline_id=outline_id,
            title=data.title,
            content=data.content,
            level=data.level,
            parent_id=data.parent_id,
            sort_order=data.sort_order,
            volume_id=data.volume_id,
            chapter_id=data.chapter_id,
        )
    except ValidationError as exc:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    await session.commit()
    return _to_response(outline)


@router.delete(
    "/projects/{project_id}/outlines/{outline_id}",
    response_model=OutlineDeleteResponse,
    summary="删除大纲节点及其子树",
)
async def delete_outline(
    project_id: str,
    outline_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> OutlineDeleteResponse:
    deleted_count = await outline_service.delete_outline(
        session, project_id=project_id, outline_id=outline_id
    )
    await session.commit()
    return OutlineDeleteResponse(deleted_count=deleted_count)
