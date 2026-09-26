# -*- coding: utf-8 -*-
"""
Outline 数据模型 - 大纲树节点。
"""

from datetime import UTC, datetime
from typing import Literal

from sqlmodel import Field, SQLModel

from app.core.ids import generate_id

OutlineLevel = Literal["book", "arc", "volume", "chapter"]

OUTLINE_LEVELS: tuple[str, ...] = ("book", "arc", "volume", "chapter")


class Outline(SQLModel, table=True):
    """大纲树节点。

    parent_id 自引用构成树；level 描述节点语义层级；volume_id / chapter_id
    是可选的关联，用于把大纲节点挂到现有卷章结构上。
    """

    __tablename__ = "outlines"

    id: str = Field(default_factory=generate_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="projects.id")
    parent_id: str | None = Field(default=None, index=True, foreign_key="outlines.id")
    volume_id: str | None = Field(default=None, index=True)
    chapter_id: str | None = Field(default=None, index=True)
    level: str = Field(default="chapter", max_length=20, index=True)
    title: str = Field(default="", max_length=200)
    content: str = Field(default="")
    sort_order: int = Field(default=0)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
