# -*- coding: utf-8 -*-
"""
ScenePlan 数据模型 - 章节内的场景计划与结果。

章节是当前最小单位，只有章节级 `chapter_meta`；场景粒度的目标、视角、参与者、
前置条件、信息投放与预期变化此前无处安放。本表按 `(chapter_id, scene_index)`
唯一，`result_json` 记录场景实际产生的五类变化，仍只是候选材料，不直接改写正文。
"""

from datetime import UTC, datetime

from sqlalchemy import UniqueConstraint
from sqlmodel import Field

from app.core.ids import generate_id
from app.storage.models.narrative_provenance import NarrativeProvenanceMixin

# 场景结果固定按五类归档；每类内部是自由文本，不发明额外的必需结构。
SCENE_RESULT_CATEGORIES: tuple[str, ...] = (
    "fact_changes",
    "belief_changes",
    "relationship_changes",
    "state_changes",
    "plotline_changes",
)

EMPTY_SCENE_RESULT_JSON = (
    '{"fact_changes": [], "belief_changes": [], "relationship_changes": [],'
    ' "state_changes": [], "plotline_changes": []}'
)


class ScenePlan(NarrativeProvenanceMixin, table=True):
    """章节内的一个场景计划。"""

    __tablename__ = "scene_plans"
    __table_args__ = (
        UniqueConstraint(
            "chapter_id", "scene_index", name="uq_scene_plans_chapter_index"
        ),
    )

    id: str = Field(default_factory=generate_id, primary_key=True)
    project_id: str = Field(index=True, foreign_key="projects.id")
    chapter_id: str = Field(index=True, max_length=64, foreign_key="chapters.id")
    scene_index: int = Field(default=0, index=True)
    goal: str = Field(default="")
    pov_character_id: str | None = Field(
        default=None, max_length=64, index=True, foreign_key="characters.id"
    )
    location: str = Field(default="", max_length=200)
    tone: str = Field(default="", max_length=100)
    preconditions_json: str = Field(default="[]")
    participants_json: str = Field(default="[]")
    character_goals_json: str = Field(default="[]")
    known_information_json: str = Field(default="[]")
    hidden_information_json: str = Field(default="[]")
    active_plotline_ids_json: str = Field(default="[]")
    world_constraints_json: str = Field(default="[]")
    expected_changes_json: str = Field(default="[]")
    result_json: str = Field(default=EMPTY_SCENE_RESULT_JSON)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
