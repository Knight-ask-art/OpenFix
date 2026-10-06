# -*- coding: utf-8 -*-
"""
CharacterBelief 数据模型 - 人物相信的命题。

`character_states` 记录的是人物当下快照（地点 / 身体 / 心理 / 目标 / 关系），
不能表达「人物相信命题 P」这种**可错**的陈述。信念因此单独建表：

* `belief_state` 描述人物对这一命题的把握程度；
* `confidence` 沿用共享溯源列，表示系统对该条记录本身的置信度；
* 一条已人工确认的信念仍然可以是错的（`belief_state="mistaken"`），
  它作为「人物信念」依然有效，绝不能被当成世界事实。
"""

from datetime import UTC, datetime

from sqlmodel import Field

from app.core.ids import generate_id
from app.storage.models.narrative_provenance import NarrativeProvenanceMixin

BELIEF_STATES: tuple[str, ...] = (
    "known",
    "believed",
    "suspected",
    "unknown",
    "mistaken",
)

DEFAULT_BELIEF_STATE = "believed"


class CharacterBelief(NarrativeProvenanceMixin, table=True):
    """某个人物相信 / 怀疑 / 误解的一条命题。"""

    __tablename__ = "character_beliefs"

    id: str = Field(default_factory=generate_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="projects.id")
    character_id: str = Field(index=True, foreign_key="characters.id")
    proposition: str = Field(default="")
    belief_state: str = Field(default=DEFAULT_BELIEF_STATE, max_length=20, index=True)
    learned_at_chapter_id: str | None = Field(
        default=None, max_length=64, index=True, foreign_key="chapters.id"
    )
    superseded_by_id: str | None = Field(
        default=None, max_length=64, index=True, foreign_key="character_beliefs.id"
    )
    invalidated_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
