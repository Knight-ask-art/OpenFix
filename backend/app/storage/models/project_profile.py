# -*- coding: utf-8 -*-
"""
ProjectProfile 数据模型 - 项目的产品级属性。

OpenFic 原有 `projects` 表只有标题与简介，V1.0 的类型、预计字数、每日目标
放在本扩展表，避免改动上游核心 Schema。
"""

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel

from app.core.ids import generate_id


class ProjectProfile(SQLModel, table=True):
    """项目产品属性，与 projects 一一对应。"""

    __tablename__ = "project_profiles"

    id: str = Field(default_factory=generate_id, primary_key=True)
    project_id: str = Field(index=True, unique=True, foreign_key="projects.id")
    genre: str = Field(default="", max_length=50)
    synopsis: str = Field(default="")
    target_word_count: int = Field(default=0)
    daily_word_goal: int = Field(default=0)
    status: str = Field(default="drafting", max_length=30)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
