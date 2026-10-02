# -*- coding: utf-8 -*-
"""
CharacterProfile 数据模型 - 人物作者扩展字段。

OpenFic 原有 `characters` 表只有 name / description，V1.0 的作者字段
（别名、年龄、阵营、目标、动机……）放在本扩展表，避免改动上游核心 Schema。
"""

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel

from app.core.ids import generate_id


class CharacterProfile(SQLModel, table=True):
    """人物作者扩展字段，与 characters 一一对应。"""

    __tablename__ = "character_profiles"

    id: str = Field(default_factory=generate_id, primary_key=True)
    character_id: str = Field(index=True, unique=True, foreign_key="characters.id")
    alias: str = Field(default="", max_length=200)
    age: str = Field(default="", max_length=100)
    gender: str = Field(default="", max_length=50)
    identity: str = Field(default="", max_length=200)
    faction: str = Field(default="", max_length=200)
    personality: str = Field(default="")
    appearance: str = Field(default="")
    background: str = Field(default="")
    goal: str = Field(default="")
    motivation: str = Field(default="")
    fear: str = Field(default="")
    secret: str = Field(default="")
    abilities: str = Field(default="")
    weakness: str = Field(default="")
    arc: str = Field(default="")
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
