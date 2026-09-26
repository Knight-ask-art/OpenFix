# -*- coding: utf-8 -*-
"""Outline schemas - 大纲树 API 数据模型。"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

OutlineLevelLiteral = Literal["book", "arc", "volume", "chapter"]


class OutlineCreate(BaseModel):
    """创建大纲节点。"""

    level: OutlineLevelLiteral = "chapter"
    title: str = Field(default="", max_length=200)
    content: str = ""
    parent_id: str | None = None
    volume_id: str | None = None
    chapter_id: str | None = None


class OutlineUpdate(BaseModel):
    """更新大纲节点。"""

    title: str | None = Field(default=None, max_length=200)
    content: str | None = None
    level: OutlineLevelLiteral | None = None
    parent_id: str | None = None
    sort_order: int | None = None
    volume_id: str | None = None
    chapter_id: str | None = None


class OutlineResponse(BaseModel):
    """大纲节点。"""

    id: str
    project_id: str
    parent_id: str | None
    volume_id: str | None
    chapter_id: str | None
    level: str
    title: str
    content: str
    sort_order: int
    created_at: datetime
    updated_at: datetime


class OutlineListResponse(BaseModel):
    """项目大纲全量节点（扁平列表，前端组树）。"""

    items: list[OutlineResponse]
    total: int


class OutlineDeleteResponse(BaseModel):
    """删除大纲节点结果。"""

    deleted_count: int
