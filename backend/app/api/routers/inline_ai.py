# -*- coding: utf-8 -*-
"""Inline AI Router - 编辑器内联 AI 改写 API。"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.inline_ai import InlineAiTransformRequest, InlineAiTransformResponse
from app.background.llm.resolver import BackgroundModelUnavailableError
from app.core.errors import ValidationError
from app.core.inline_ai import service as inline_ai_service
from app.storage.database import get_session

router = APIRouter(tags=["inline-ai"])


@router.post(
    "/inline-ai/transform",
    response_model=InlineAiTransformResponse,
    summary="对选中文本执行 AI 改写并返回建议",
)
async def inline_ai_transform(
    data: InlineAiTransformRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> InlineAiTransformResponse:
    """执行内联 AI 改写。仅返回建议，不修改章节正文。"""
    try:
        result = await inline_ai_service.transform(
            session,
            project_id=data.project_id,
            chapter_id=data.chapter_id,
            action=data.action,
            selected_text=data.selected_text,
            instruction=data.instruction,
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

    return InlineAiTransformResponse(
        original=result.original,
        result=result.result,
        model=result.model,
        usage=result.usage,
    )
