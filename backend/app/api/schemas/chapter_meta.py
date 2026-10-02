# -*- coding: utf-8 -*-
"""Chapter meta API schemas - 章节状态与目标字数请求/响应模型。"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ChapterStatus = Literal["draft", "writing", "revising", "done"]


class ChapterMetaResponse(BaseModel):
    """章节附加信息响应。"""

    chapter_id: str = Field(description="章节 ID")
    project_id: str = Field(description="所属项目 ID")
    status: ChapterStatus = Field(description="章节状态")
    target_word_count: int = Field(description="本章目标字数")
    last_ai_check_at: datetime | None = Field(default=None, description="最近一致性检查时间")
    updated_at: datetime = Field(description="更新时间")


class ChapterMetaUpdateRequest(BaseModel):
    """更新章节附加信息请求（未提供的字段保持不变）。"""

    status: ChapterStatus | None = None
    target_word_count: int | None = Field(default=None, ge=0)


class ChapterMetaListResponse(BaseModel):
    """章节附加信息列表响应。"""

    items: list[ChapterMetaResponse] = Field(description="附加信息列表")
    total: int = Field(description="总数")
