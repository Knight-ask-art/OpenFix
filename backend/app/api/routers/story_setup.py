# -*- coding: utf-8 -*-
"""Story setup Router - 新书 AI 辅助搭建草案 API。"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.story_setup import (
    StorySetupDraftOutlineItem,
    StorySetupDraftProtagonist,
    StorySetupDraftRequest,
    StorySetupDraftResponse,
)
from app.background.llm.resolver import BackgroundModelUnavailableError
from app.core import story_setup as story_setup_service
from app.core.errors import ProviderError, ValidationError
from app.storage.database import get_session

router = APIRouter(tags=["story-setup"])


@router.post(
    "/story-setup/draft",
    response_model=StorySetupDraftResponse,
    summary="根据灵感生成新书搭建草案（书名、类型、简介、世界背景、主角、核心冲突、初始大纲）",
)
async def story_setup_draft(
    data: StorySetupDraftRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StorySetupDraftResponse:
    """仅返回可编辑草案，不写入任何项目 / 人物 / 世界观 / 大纲数据。"""
    try:
        draft = await story_setup_service.generate_story_setup_draft(
            session,
            inspiration=data.inspiration,
            model_id=data.model_id,
        )
    except BackgroundModelUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except ProviderError as exc:
        # 统一映射为 502：既不向客户端透传服务商原始错误内容，
        # 也避免服务商认证失败被前端误判为登录态失效。
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="模型服务调用失败，请稍后重试",
        ) from exc
    except ValidationError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return StorySetupDraftResponse(
        title=draft.title,
        genre=draft.genre,
        synopsis=draft.synopsis,
        world_background=draft.world_background,
        protagonist=(
            StorySetupDraftProtagonist(
                name=draft.protagonist.name,
                description=draft.protagonist.description,
                identity=draft.protagonist.identity,
                motivation=draft.protagonist.motivation,
                goal=draft.protagonist.goal,
            )
            if draft.protagonist is not None
            else None
        ),
        core_conflict=draft.core_conflict,
        initial_outline=[
            StorySetupDraftOutlineItem(title=item.title, content=item.content)
            for item in draft.initial_outline
        ],
        model=draft.model,
        usage=draft.usage,
    )
