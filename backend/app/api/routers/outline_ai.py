# -*- coding: utf-8 -*-
"""Outline AI Router - 大纲 AI 四个动作 API（PRD §14）。

所有接口只返回候选内容，不写入任何大纲数据；
前端必须在用户确认后才调用既有大纲 API 落库。
"""

from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.ai_errors import AiModelUnavailableDetail
from app.api.schemas.outline_ai import (
    OutlineAiDraftRequest,
    OutlineAiDraftResponse,
    OutlineAiIssue,
    OutlineAiPacingRequest,
    OutlineAiPacingResponse,
    OutlineAiSplitItem,
    OutlineAiSplitRequest,
    OutlineAiSplitResponse,
    OutlineAiUpdateFromChapterRequest,
)
from app.background.llm.resolver import BackgroundModelUnavailableError
from app.core.errors import NotFoundError, ProviderError, ValidationError
from app.core.outline_ai import service as outline_ai_service
from app.storage.database import get_session

router = APIRouter(tags=["outline-ai"])

_PROVIDER_FAILURE_DETAIL = "模型服务调用失败，请稍后重试"


def _raise_http_error(exc: Exception) -> NoReturn:
    """把领域异常映射为 HTTP 状态；服务商错误不透传原始内容。"""
    if isinstance(exc, BackgroundModelUnavailableError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=AiModelUnavailableDetail(message=str(exc)).model_dump(),
        ) from exc
    if isinstance(exc, NotFoundError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    if isinstance(exc, ProviderError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=_PROVIDER_FAILURE_DETAIL
        ) from exc
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


def _draft_response(draft: outline_ai_service.OutlineAiDraft) -> OutlineAiDraftResponse:
    return OutlineAiDraftResponse(
        title=draft.title,
        content=draft.content,
        notes=draft.notes,
        model=draft.model,
        usage=draft.usage,
    )


@router.post(
    "/projects/{project_id}/outlines/ai/improve",
    response_model=OutlineAiDraftResponse,
    summary="AI 完善大纲：返回候选标题与内容",
)
async def improve_outline(
    project_id: str,
    data: OutlineAiDraftRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> OutlineAiDraftResponse:
    """仅返回建议，不写入大纲。"""
    try:
        draft = await outline_ai_service.improve_outline(
            session,
            project_id=project_id,
            outline_id=data.outline_id,
            level=data.level,
            title=data.title,
            content=data.content,
            instruction=data.instruction,
            model_id=data.model_id,
        )
    except (BackgroundModelUnavailableError, NotFoundError, ProviderError, ValidationError) as exc:
        await session.rollback()
        _raise_http_error(exc)

    return _draft_response(draft)


@router.post(
    "/projects/{project_id}/outlines/ai/check-pacing",
    response_model=OutlineAiPacingResponse,
    summary="AI 检查节奏：返回可能存在的节奏问题",
)
async def check_outline_pacing(
    project_id: str,
    data: OutlineAiPacingRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> OutlineAiPacingResponse:
    """仅返回审慎表述的建议，不写入大纲。"""
    try:
        result = await outline_ai_service.check_pacing(
            session,
            project_id=project_id,
            outline_id=data.outline_id,
            scope=data.scope,
            model_id=data.model_id,
        )
    except (BackgroundModelUnavailableError, NotFoundError, ProviderError, ValidationError) as exc:
        await session.rollback()
        _raise_http_error(exc)

    return OutlineAiPacingResponse(
        summary=result.summary,
        issues=[
            OutlineAiIssue(
                severity=issue.severity,
                message=issue.message,
                evidence=issue.evidence,
                suggestion=issue.suggestion,
            )
            for issue in result.issues
        ],
        model=result.model,
        usage=result.usage,
    )


@router.post(
    "/projects/{project_id}/outlines/ai/split-chapters",
    response_model=OutlineAiSplitResponse,
    summary="AI 拆分章节：返回候选章节大纲",
)
async def split_outline_into_chapters(
    project_id: str,
    data: OutlineAiSplitRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> OutlineAiSplitResponse:
    """仅返回候选条目，不创建任何大纲节点。"""
    try:
        result = await outline_ai_service.split_into_chapters(
            session,
            project_id=project_id,
            outline_id=data.outline_id,
            max_chapters=data.max_chapters,
            instruction=data.instruction,
            model_id=data.model_id,
        )
    except (BackgroundModelUnavailableError, NotFoundError, ProviderError, ValidationError) as exc:
        await session.rollback()
        _raise_http_error(exc)

    return OutlineAiSplitResponse(
        items=[
            OutlineAiSplitItem(title=item.title, content=item.content)
            for item in result.items
        ],
        model=result.model,
        usage=result.usage,
    )


@router.post(
    "/projects/{project_id}/outlines/ai/update-from-chapter",
    response_model=OutlineAiDraftResponse,
    summary="AI 根据正文更新大纲：返回候选大纲内容",
)
async def update_outline_from_chapter(
    project_id: str,
    data: OutlineAiUpdateFromChapterRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> OutlineAiDraftResponse:
    """仅返回建议，不写入大纲。"""
    try:
        draft = await outline_ai_service.update_from_chapter(
            session,
            project_id=project_id,
            outline_id=data.outline_id,
            chapter_id=data.chapter_id,
            instruction=data.instruction,
            model_id=data.model_id,
        )
    except (BackgroundModelUnavailableError, NotFoundError, ProviderError, ValidationError) as exc:
        await session.rollback()
        _raise_http_error(exc)

    return _draft_response(draft)
