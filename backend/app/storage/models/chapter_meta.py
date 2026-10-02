# -*- coding: utf-8 -*-
"""
ChapterMeta 数据模型 - 章节的产品级附加信息。

OpenFic 原有 `chapters` 表只有标题/正文/字数，V1.0 的章节状态与本章目标字数
放在本扩展表，避免改动上游核心 Schema。
"""

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel

from app.core.ids import generate_id

# 章节状态：草稿 / 写作中 / 待修改 / 完成
CHAPTER_STATUSES: tuple[str, ...] = ("draft", "writing", "revising", "done")

DEFAULT_CHAPTER_STATUS = "draft"


class ChapterMeta(SQLModel, table=True):
    """章节产品附加信息，与 chapters 一一对应。"""

    __tablename__ = "chapter_meta"

    id: str = Field(default_factory=generate_id, primary_key=True)
    chapter_id: str = Field(index=True, unique=True, foreign_key="chapters.id")
    project_id: str = Field(index=True, foreign_key="projects.id")
    status: str = Field(default=DEFAULT_CHAPTER_STATUS, max_length=20, index=True)
    target_word_count: int = Field(default=0)
    last_ai_check_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
