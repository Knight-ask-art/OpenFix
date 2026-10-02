# -*- coding: utf-8 -*-
"""Story setup schemas - 新书 AI 辅助搭建草案请求与响应。"""

from typing import Any

from pydantic import BaseModel, Field

# ============================================
# Story setup draft - 首次创建小说的 AI 辅助搭建草案
#
# 仅返回可编辑草案，不写入任何项目数据；持久化由前端在用户确认后调用既有 API 完成。
# ============================================

MAX_STORY_SETUP_DRAFT_INSPIRATION_CHARS = 6_000
MAX_STORY_SETUP_DRAFT_TITLE_CHARS = 120
MAX_STORY_SETUP_DRAFT_GENRE_CHARS = 60
MAX_STORY_SETUP_DRAFT_SYNOPSIS_CHARS = 1_200
MAX_STORY_SETUP_DRAFT_WORLD_BACKGROUND_CHARS = 4_000
MAX_STORY_SETUP_DRAFT_PROTAGONIST_NAME_CHARS = 100
MAX_STORY_SETUP_DRAFT_PROTAGONIST_DESCRIPTION_CHARS = 2_500
MAX_STORY_SETUP_DRAFT_PROTAGONIST_IDENTITY_CHARS = 1_000
MAX_STORY_SETUP_DRAFT_PROTAGONIST_MOTIVATION_CHARS = 1_000
MAX_STORY_SETUP_DRAFT_PROTAGONIST_GOAL_CHARS = 800
MAX_STORY_SETUP_DRAFT_CORE_CONFLICT_CHARS = 1_200
MAX_STORY_SETUP_DRAFT_OUTLINE_ITEMS = 12
MAX_STORY_SETUP_DRAFT_OUTLINE_ITEM_TITLE_CHARS = 200
MAX_STORY_SETUP_DRAFT_OUTLINE_ITEM_CONTENT_CHARS = 1_500


class StorySetupDraftRequest(BaseModel):
    """AI 辅助搭建草案生成请求。"""

    inspiration: str = Field(
        min_length=1,
        max_length=MAX_STORY_SETUP_DRAFT_INSPIRATION_CHARS,
        description="用户输入的灵感文本，仅作为创作素材。",
    )
    model_id: str | None = Field(default=None, description="可选：指定模型 ID。")


class StorySetupDraftProtagonist(BaseModel):
    """主角草案。未生成的字段为空字符串。"""

    name: str = Field(
        default="", max_length=MAX_STORY_SETUP_DRAFT_PROTAGONIST_NAME_CHARS
    )
    description: str = Field(
        default="", max_length=MAX_STORY_SETUP_DRAFT_PROTAGONIST_DESCRIPTION_CHARS
    )
    identity: str = Field(
        default="", max_length=MAX_STORY_SETUP_DRAFT_PROTAGONIST_IDENTITY_CHARS
    )
    motivation: str = Field(
        default="", max_length=MAX_STORY_SETUP_DRAFT_PROTAGONIST_MOTIVATION_CHARS
    )
    goal: str = Field(
        default="", max_length=MAX_STORY_SETUP_DRAFT_PROTAGONIST_GOAL_CHARS
    )


class StorySetupDraftOutlineItem(BaseModel):
    """初始大纲条目。"""

    title: str = Field(
        default="", max_length=MAX_STORY_SETUP_DRAFT_OUTLINE_ITEM_TITLE_CHARS
    )
    content: str = Field(
        default="", max_length=MAX_STORY_SETUP_DRAFT_OUTLINE_ITEM_CONTENT_CHARS
    )


class StorySetupDraftResponse(BaseModel):
    """AI 辅助搭建草案结果。仅返回草案，不写入任何数据。

    未生成的条目为 null / 空列表，前端应只展示实际生成的条目。
    """

    title: str | None = Field(default=None, max_length=MAX_STORY_SETUP_DRAFT_TITLE_CHARS)
    genre: str | None = Field(default=None, max_length=MAX_STORY_SETUP_DRAFT_GENRE_CHARS)
    synopsis: str | None = Field(
        default=None, max_length=MAX_STORY_SETUP_DRAFT_SYNOPSIS_CHARS
    )
    world_background: str | None = Field(
        default=None, max_length=MAX_STORY_SETUP_DRAFT_WORLD_BACKGROUND_CHARS
    )
    protagonist: StorySetupDraftProtagonist | None = None
    core_conflict: str | None = Field(
        default=None, max_length=MAX_STORY_SETUP_DRAFT_CORE_CONFLICT_CHARS
    )
    initial_outline: list[StorySetupDraftOutlineItem] = Field(
        default_factory=list, max_length=MAX_STORY_SETUP_DRAFT_OUTLINE_ITEMS
    )
    model: str
    usage: dict[str, Any] | None = None
