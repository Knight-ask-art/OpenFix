# -*- coding: utf-8 -*-
"""Chapter Meta Router - 章节状态与目标字数 API。"""

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.chapter_meta import (
    ChapterMetaListResponse,
    ChapterMetaResponse,
    ChapterMetaUpdateRequest,
    ChapterStatus,
)
from app.core.errors import NotFoundError, ValidationError
from app.storage.database import get_session
from app.storage.models.chapter_meta import ChapterMeta
from app.storage.services import chapter_meta_service

router = APIRouter(tags=["chapters"])


def to_response(meta: ChapterMeta) -> ChapterMetaResponse:
    """转换章节附加信息响应。"""
    status_value = meta.status or "draft"
    if status_value not in ("draft", "writing", "revising", "done"):
        status_value = "draft"
    return ChapterMetaResponse(
        chapter_id=meta.chapter_id,
        project_id=meta.project_id,
        status=cast(ChapterStatus, status_value),
        target_word_count=meta.target_word_count,
        last_ai_check_at=meta.last_ai_check_at,
        updated_at=meta.updated_at,
    )


@router.get(
    "/projects/{project_id}/chapter-meta",
    response_model=ChapterMetaListResponse,
    summary="获取项目内章节附加信息列表",
)
async def list_project_chapter_meta(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ChapterMetaListResponse:
    """返回项目内已显式设置过状态的章节。"""
    metas = await chapter_meta_service.list_meta_by_project(session, project_id)
    return ChapterMetaListResponse(
        items=[to_response(meta) for meta in metas],
        total=len(metas),
    )


@router.get(
    "/chapters/{chapter_id}/meta",
    response_model=ChapterMetaResponse,
    summary="获取章节附加信息",
)
async def get_chapter_meta(
    chapter_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ChapterMetaResponse:
    """获取章节状态与本章目标字数；未设置时返回默认值。"""
    try:
        meta = await chapter_meta_service.get_meta(session, chapter_id)
        return to_response(meta)
    except NotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.put(
    "/chapters/{chapter_id}/meta",
    response_model=ChapterMetaResponse,
    summary="更新章节附加信息",
)
async def update_chapter_meta(
    chapter_id: str,
    data: ChapterMetaUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ChapterMetaResponse:
    """更新章节状态与本章目标字数；不修改章节正文。"""
    try:
        meta = await chapter_meta_service.update_meta(
            session,
            chapter_id,
            status=data.status,
            target_word_count=data.target_word_count,
        )
        return to_response(meta)
    except NotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except ValidationError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
