# -*- coding: utf-8 -*-
"""
CharacterState 数据模型 - 人物在某一章节的动态状态。

与静态人物卡不同，这里记录「当前地点 / 身体状态 / 心理状态 / 当前目标 /
关系变化」，可以按章节持续更新；chapter_id 为空表示项目级的最新状态。
"""

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel

from app.core.ids import generate_id


class CharacterState(SQLModel, table=True):
    """人物动态状态（可按章节持久化）。"""

    __tablename__ = "character_states"

    id: str = Field(default_factory=generate_id, primary_key=True)
    character_id: str = Field(index=True, foreign_key="characters.id")
    project_id: str = Field(index=True, foreign_key="projects.id")
    chapter_id: str | None = Field(default=None, index=True)
    location: str = Field(default="", max_length=200)
    physical_state: str = Field(default="", max_length=500)
    mental_state: str = Field(default="", max_length=500)
    goal: str = Field(default="", max_length=500)
    relationship_note: str = Field(default="", max_length=500)
    notes: str = Field(default="")
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
