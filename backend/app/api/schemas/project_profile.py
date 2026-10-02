# -*- coding: utf-8 -*-
"""Project profile API schemas - 项目产品属性请求/响应模型。"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ProjectProfileResponse(BaseModel):
    """项目产品属性响应。"""

    project_id: str = Field(description="项目 ID")
    genre: str = Field(description="小说类型")
    synopsis: str = Field(description="一句话简介")
    target_word_count: int = Field(description="预计字数")
    daily_word_goal: int = Field(description="每日字数目标")
    status: Literal["planning", "drafting", "revising", "completed"] = Field(
        description="项目状态"
    )
    updated_at: datetime = Field(description="更新时间")


class ProjectProfileUpdateRequest(BaseModel):
    """更新项目产品属性请求（未提供的字段保持不变）。"""

    genre: str | None = Field(default=None, max_length=50)
    synopsis: str | None = None
    target_word_count: int | None = Field(default=None, ge=0)
    daily_word_goal: int | None = Field(default=None, ge=0)
    status: Literal["planning", "drafting", "revising", "completed"] | None = None
