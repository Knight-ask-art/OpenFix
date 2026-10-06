# -*- coding: utf-8 -*-
"""
Plotline 数据模型 - 情节线与其 setup/payoff 义务。

`outlines` 是 book/arc/volume/chapter 树 + 自由文本，没有状态，也没有
「埋下的伏笔是否兑现」的义务追踪。情节线独立建表，只通过可选关联 ID 指向
大纲节点与人物，不嵌套进大纲树，也不替换它。
"""

from datetime import UTC, datetime

from sqlmodel import Field

from app.core.ids import generate_id
from app.storage.models.narrative_provenance import NarrativeProvenanceMixin

PLOTLINE_STATES: tuple[str, ...] = (
    "open",
    "progressing",
    "resolved",
    "abandoned",
    "uncertain",
)

DEFAULT_PLOTLINE_STATE = "open"


class Plotline(NarrativeProvenanceMixin, table=True):
    """一条情节线。"""

    __tablename__ = "plotlines"

    id: str = Field(default_factory=generate_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="projects.id")
    title: str = Field(default="", max_length=200)
    description: str = Field(default="")
    current_question: str = Field(default="")
    payoff: str = Field(default="")
    state: str = Field(default=DEFAULT_PLOTLINE_STATE, max_length=20, index=True)
    introduced_chapter_id: str | None = Field(
        default=None, max_length=64, index=True, foreign_key="chapters.id"
    )
    advanced_chapter_id: str | None = Field(
        default=None, max_length=64, index=True, foreign_key="chapters.id"
    )
    # 关联 ID 以 JSON 字符串存储，避免为小体量关联再建关联表。
    related_character_ids_json: str = Field(default="[]")
    related_outline_ids_json: str = Field(default="[]")
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
