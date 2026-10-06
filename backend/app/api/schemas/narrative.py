# -*- coding: utf-8 -*-
"""Narrative API schemas - 叙事状态请求/响应模型。

四类资源（世界事实 / 人物信念 / 情节线 / 场景计划）共用同一组溯源字段，
因此请求与响应都以共享基类承载，保持 JSON 扁平结构，前端可以直接绑定表单。
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SourceType = Literal[
    "user",
    "chapter",
    "agent",
    "inference",
    "outline",
    "world_info",
    "character_profile",
]

ConfirmationState = Literal["candidate", "inferred", "confirmed", "rejected"]

WorldFactStatus = Literal["confirmed", "uncertain", "contradicted", "retired"]

BeliefState = Literal["known", "believed", "suspected", "unknown", "mistaken"]

PlotlineState = Literal["open", "progressing", "resolved", "abandoned", "uncertain"]

MAX_TEXT_LENGTH = 20000
MAX_LINK_ITEMS = 200


class NarrativeProvenanceFields(BaseModel):
    """共享溯源字段（请求侧）。未提供的字段保持默认或原值。"""

    source_type: SourceType | None = Field(default=None, description="溯源来源类型")
    source_id: str | None = Field(default=None, max_length=64, description="溯源来源 ID")
    source_chapter_id: str | None = Field(
        default=None, max_length=64, description="溯源章节 ID"
    )
    quote_anchor: str | None = Field(
        default=None, max_length=200, description="来源文本中的定位锚点"
    )
    created_by: str | None = Field(default=None, max_length=100, description="创建者")
    confidence: float | None = Field(default=None, ge=0.0, le=1.0, description="置信度")
    confirmation: ConfirmationState | None = Field(
        default=None, description="确认状态；confirmed 只能通过确认接口设置"
    )


class NarrativeProvenanceResponse(BaseModel):
    """共享溯源字段（响应侧）。"""

    source_type: SourceType = Field(description="溯源来源类型")
    source_id: str | None = Field(description="溯源来源 ID")
    source_chapter_id: str | None = Field(description="溯源章节 ID")
    quote_anchor: str = Field(description="来源文本中的定位锚点")
    created_by: str = Field(description="创建者")
    confidence: float | None = Field(description="置信度")
    confirmation: ConfirmationState = Field(description="确认状态")
    confirmed_at: datetime | None = Field(description="确认时间")
    confirmed_by: str | None = Field(description="确认者")


class NarrativeConfirmRequest(BaseModel):
    """确认请求。必须携带读取时的 updated_at，防止基于过期数据确认。"""

    expected_updated_at: datetime = Field(description="读取时的 updated_at")
    confirmed_by: str | None = Field(default=None, max_length=100, description="确认者")


# --- 世界事实 ---------------------------------------------------------------


class WorldFactCreateRequest(NarrativeProvenanceFields):
    """创建世界事实请求。"""

    statement: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH, description="事实陈述")
    subject_ref: str | None = Field(default=None, max_length=200, description="事实主体")
    status: WorldFactStatus | None = Field(default=None, description="事实状态")


class WorldFactUpdateRequest(NarrativeProvenanceFields):
    """更新世界事实请求（仅提交需要变更的字段）。"""

    statement: str | None = Field(default=None, min_length=1, max_length=MAX_TEXT_LENGTH)
    subject_ref: str | None = Field(default=None, max_length=200)
    status: WorldFactStatus | None = None
    superseded_by_id: str | None = Field(
        default=None, max_length=64, description="取代本条的另一条事实 ID"
    )


class WorldFactResponse(NarrativeProvenanceResponse):
    """世界事实响应。"""

    id: str
    project_id: str
    statement: str
    subject_ref: str
    status: WorldFactStatus
    superseded_by_id: str | None
    created_at: datetime
    updated_at: datetime


class WorldFactListResponse(BaseModel):
    """世界事实列表响应。"""

    items: list[WorldFactResponse]
    total: int
    limit: int
    offset: int


# --- 人物信念 ---------------------------------------------------------------


class CharacterBeliefCreateRequest(NarrativeProvenanceFields):
    """创建人物信念请求。"""

    character_id: str = Field(min_length=1, max_length=64, description="人物 ID")
    proposition: str = Field(min_length=1, max_length=MAX_TEXT_LENGTH, description="信念命题")
    belief_state: BeliefState | None = Field(default=None, description="信念状态")
    learned_at_chapter_id: str | None = Field(
        default=None, max_length=64, description="得知该命题的章节 ID"
    )


class CharacterBeliefUpdateRequest(NarrativeProvenanceFields):
    """更新人物信念请求（仅提交需要变更的字段）。"""

    character_id: str | None = Field(default=None, min_length=1, max_length=64)
    proposition: str | None = Field(default=None, min_length=1, max_length=MAX_TEXT_LENGTH)
    belief_state: BeliefState | None = None
    learned_at_chapter_id: str | None = Field(default=None, max_length=64)
    superseded_by_id: str | None = Field(default=None, max_length=64)
    invalidated_at: datetime | None = Field(default=None, description="失效时间")


class CharacterBeliefResponse(NarrativeProvenanceResponse):
    """人物信念响应。"""

    id: str
    project_id: str
    character_id: str
    proposition: str
    belief_state: BeliefState
    learned_at_chapter_id: str | None
    superseded_by_id: str | None
    invalidated_at: datetime | None
    created_at: datetime
    updated_at: datetime


class CharacterBeliefListResponse(BaseModel):
    """人物信念列表响应。"""

    items: list[CharacterBeliefResponse]
    total: int
    limit: int
    offset: int


# --- 情节线 -----------------------------------------------------------------


class PlotlineCreateRequest(NarrativeProvenanceFields):
    """创建情节线请求。"""

    title: str = Field(min_length=1, max_length=200, description="情节线标题")
    description: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    current_question: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    payoff: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    state: PlotlineState | None = Field(default=None, description="情节线状态")
    introduced_chapter_id: str | None = Field(default=None, max_length=64)
    advanced_chapter_id: str | None = Field(default=None, max_length=64)
    related_character_ids: list[str] | None = Field(
        default=None, max_length=MAX_LINK_ITEMS
    )
    related_outline_ids: list[str] | None = Field(
        default=None, max_length=MAX_LINK_ITEMS
    )


class PlotlineUpdateRequest(NarrativeProvenanceFields):
    """更新情节线请求（仅提交需要变更的字段）。"""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    current_question: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    payoff: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    state: PlotlineState | None = None
    introduced_chapter_id: str | None = Field(default=None, max_length=64)
    advanced_chapter_id: str | None = Field(default=None, max_length=64)
    related_character_ids: list[str] | None = Field(
        default=None, max_length=MAX_LINK_ITEMS
    )
    related_outline_ids: list[str] | None = Field(
        default=None, max_length=MAX_LINK_ITEMS
    )


class PlotlineResponse(NarrativeProvenanceResponse):
    """情节线响应。"""

    id: str
    project_id: str
    title: str
    description: str
    current_question: str
    payoff: str
    state: PlotlineState
    introduced_chapter_id: str | None
    advanced_chapter_id: str | None
    related_character_ids: list[str]
    related_outline_ids: list[str]
    created_at: datetime
    updated_at: datetime


class PlotlineListResponse(BaseModel):
    """情节线列表响应。"""

    items: list[PlotlineResponse]
    total: int
    limit: int
    offset: int


# --- 场景计划 ---------------------------------------------------------------


class SceneCharacterGoal(BaseModel):
    """场景内某个人物的目标。"""

    character_id: str = Field(min_length=1, max_length=64)
    goal: str = Field(default="", max_length=MAX_TEXT_LENGTH)


class SceneResultPayload(BaseModel):
    """场景实际产生的五类变化。"""

    fact_changes: list[str] = Field(default_factory=list)
    belief_changes: list[str] = Field(default_factory=list)
    relationship_changes: list[str] = Field(default_factory=list)
    state_changes: list[str] = Field(default_factory=list)
    plotline_changes: list[str] = Field(default_factory=list)


class ScenePlanCreateRequest(NarrativeProvenanceFields):
    """创建场景计划请求。"""

    chapter_id: str = Field(min_length=1, max_length=64, description="所属章节 ID")
    scene_index: int = Field(default=0, ge=0, description="章节内场景序号")
    goal: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    pov_character_id: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=200)
    tone: str | None = Field(default=None, max_length=100)
    preconditions: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    participants: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    character_goals: list[SceneCharacterGoal] | None = Field(
        default=None, max_length=MAX_LINK_ITEMS
    )
    known_information: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    hidden_information: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    active_plotline_ids: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    world_constraints: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    expected_changes: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    result: SceneResultPayload | None = None


class ScenePlanUpdateRequest(NarrativeProvenanceFields):
    """更新场景计划请求（仅提交需要变更的字段；章节归属不可变更）。"""

    scene_index: int | None = Field(default=None, ge=0)
    goal: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    pov_character_id: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=200)
    tone: str | None = Field(default=None, max_length=100)
    preconditions: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    participants: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    character_goals: list[SceneCharacterGoal] | None = Field(
        default=None, max_length=MAX_LINK_ITEMS
    )
    known_information: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    hidden_information: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    active_plotline_ids: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    world_constraints: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    expected_changes: list[str] | None = Field(default=None, max_length=MAX_LINK_ITEMS)
    result: SceneResultPayload | None = None


class ScenePlanResponse(NarrativeProvenanceResponse):
    """场景计划响应。"""

    id: str
    project_id: str
    chapter_id: str
    scene_index: int
    goal: str
    pov_character_id: str | None
    location: str
    tone: str
    preconditions: list[str]
    participants: list[str]
    character_goals: list[SceneCharacterGoal]
    known_information: list[str]
    hidden_information: list[str]
    active_plotline_ids: list[str]
    world_constraints: list[str]
    expected_changes: list[str]
    result: SceneResultPayload
    created_at: datetime
    updated_at: datetime


class ScenePlanListResponse(BaseModel):
    """场景计划列表响应。"""

    items: list[ScenePlanResponse]
    total: int
    limit: int
    offset: int
