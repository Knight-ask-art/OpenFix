# -*- coding: utf-8 -*-
"""Consistency Router - 章节一致性检查 API。"""

from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.consistency import (
    ConsistencyCheckRequest,
    ConsistencyCheckResponse,
    ConsistencyIssueAnalysisRequest,
    ConsistencyIssueAnalysisResponse,
    ConsistencyIssueResponse,
    ConsistencySourceResponse,
)
from app.background.llm.resolver import BackgroundModelUnavailableError
from app.core.consistency import service as consistency_service
from app.core.errors import NotFoundError, ValidationError
from app.storage.database import get_session

router = APIRouter(tags=["consistency"])


@router.post(
    "/projects/{project_id}/consistency/check",
    response_model=ConsistencyCheckResponse,
    summary="检查章节与设定的一致性，返回可能存在的问题列表",
)
async def check_consistency(
    project_id: str,
    data: ConsistencyCheckRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ConsistencyCheckResponse:
    """仅返回分析建议，不修改正文。"""
    try:
        result = await consistency_service.run_consistency_check(
            session,
            project_id=project_id,
            scope=data.scope,
            chapter_id=data.chapter_id,
            volume_id=data.volume_id,
            model_id=data.model_id,
        )
    except BackgroundModelUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except NotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except ValidationError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return ConsistencyCheckResponse(
        scope=cast(Literal["chapter", "volume", "book"], result.scope),
        label=result.label,
        chapter_id=result.chapter_id,
        volume_id=result.volume_id,
        chapter_count=result.chapter_count,
        model=result.model,
        context_source=cast(Literal["story_memory", "inventory"], result.context_source),
        failed_segments=result.failed_segments,
        issues=[
            ConsistencyIssueResponse(
                type=issue.type,
                severity=cast(Literal["info", "warning", "high"], issue.severity),
                message=issue.message,
                evidence=issue.evidence,
                suggestion=issue.suggestion,
                sources=[
                    ConsistencySourceResponse(
                        chapter_id=source.chapter_id,
                        chapter_order=source.chapter_order,
                        chapter_title=source.chapter_title,
                        excerpt=source.excerpt,
                        quote=source.quote,
                    )
                    for source in issue.sources
                ],
            )
            for issue in result.issues
        ],
    )


@router.post(
    "/projects/{project_id}/consistency/analyze",
    response_model=ConsistencyIssueAnalysisResponse,
    summary="基于项目当前正文与资料复核一条一致性问题",
)
async def analyze_consistency_issue(
    project_id: str,
    data: ConsistencyIssueAnalysisRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ConsistencyIssueAnalysisResponse:
    try:
        result = await consistency_service.analyze_consistency_issue(
            session,
            project_id=project_id,
            scope=data.scope,
            chapter_id=data.chapter_id,
            volume_id=data.volume_id,
            issue_type=data.issue.type,
            severity=data.issue.severity,
            message=data.issue.message,
            evidence=data.issue.evidence,
            suggestion=data.issue.suggestion,
        )
    except BackgroundModelUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except NotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except ValidationError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return ConsistencyIssueAnalysisResponse(
        model=result.model,
        analysis=result.analysis,
    )
