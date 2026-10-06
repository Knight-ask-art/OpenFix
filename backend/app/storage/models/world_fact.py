# -*- coding: utf-8 -*-
"""
WorldFact 数据模型 - 故事世界的原子事实断言。

OpenFic 原有 `world_info_entries` 是自由散文条目，无法表达「一条可判定真伪、
可被推翻、可被取代的断言」。本扩展表与人物信念严格分离：事实是故事世界成立的
断言，信念是某个人物相信的命题（可能是错的）。
"""

from datetime import UTC, datetime

from sqlmodel import Field

from app.core.ids import generate_id
from app.storage.models.narrative_provenance import NarrativeProvenanceMixin

# 断言在故事世界中的成立状态。
WORLD_FACT_STATUSES: tuple[str, ...] = (
    "confirmed",
    "uncertain",
    "contradicted",
    "retired",
)

DEFAULT_WORLD_FACT_STATUS = "uncertain"


class WorldFact(NarrativeProvenanceMixin, table=True):
    """一条原子世界事实。"""

    __tablename__ = "world_facts"

    id: str = Field(default_factory=generate_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="projects.id")
    statement: str = Field(default="")
    subject_ref: str = Field(default="", max_length=200)
    status: str = Field(default=DEFAULT_WORLD_FACT_STATUS, max_length=20, index=True)
    superseded_by_id: str | None = Field(
        default=None, max_length=64, index=True, foreign_key="world_facts.id"
    )
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
