# -*- coding: utf-8 -*-
"""Consistency Router - 章节一致性检查 API。"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.consistency import (
    ConsistencyCheckRequest,
    ConsistencyCheckResponse,
    ConsistencyIssueResponse,
)
from app.background.llm.resolver import BackgroundModelUnavailableError
from app.core.consistency import service as consistency_service
from app.core.errors import ValidationError
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
            chapter_id=data.chapter_id,
            model_id=data.model_id,
        )
    except BackgroundModelUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except ValidationError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return ConsistencyCheckResponse(
        chapter_id=result.chapter_id,
        model=result.model,
        context_source=result.context_source,
        issues=[
            ConsistencyIssueResponse(
                type=issue.type,
                severity=issue.severity,
                message=issue.message,
                evidence=issue.evidence,
                suggestion=issue.suggestion,
            )
            for issue in result.issues
        ],
    )
