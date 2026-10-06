# -*- coding: utf-8 -*-
"""
Narrative Engine 共享溯源列。

世界事实 / 人物信念 / 情节线 / 场景计划四张表是彼此独立的扩展表，但共用同一组
溯源与确认列。这里用非 table 的 SQLModel 基类承载这些列，避免多态孤儿表：
确认一条记录只是一次单行 UPDATE，也不需要 join 才能判断「是否已确认」。

两条正交的轴：

* `confirmation`：这条记录是否经过人工确认（候选 / 推断 / 已确认 / 已拒绝）。
* 各表自己的状态列（如世界事实的 `status`、信念的 `belief_state`）：断言在故事
  世界中的成立状态。已确认的信念依然可能是错的，两者不能互相推导。
"""

from datetime import datetime

from sqlmodel import Field, SQLModel

# 溯源来源：人工 / 章节正文 / Agent / 推断 / 大纲 / 世界设定 / 人物档案。
SOURCE_TYPES: tuple[str, ...] = (
    "user",
    "chapter",
    "agent",
    "inference",
    "outline",
    "world_info",
    "character_profile",
)

DEFAULT_SOURCE_TYPE = "user"

# 需要校验实体归属的来源类型；其余来源的 source_id 只作为自由标识保存。
PROJECT_SCOPED_SOURCE_TYPES: tuple[str, ...] = (
    "chapter",
    "outline",
    "world_info",
    "character_profile",
)

# 人工确认状态。candidate / inferred 都是「未确认」，区别只是来源是显式提议还是推断。
CONFIRMATION_STATES: tuple[str, ...] = ("candidate", "inferred", "confirmed", "rejected")

DEFAULT_CONFIRMATION = "candidate"

# 常规写入（创建 / 更新）允许出现的确认状态；confirmed 只能由确认接口设置。
WRITABLE_CONFIRMATIONS: tuple[str, ...] = ("candidate", "inferred", "rejected")


class NarrativeProvenanceMixin(SQLModel):
    """四张叙事状态表共享的溯源与确认列。"""

    source_type: str = Field(default=DEFAULT_SOURCE_TYPE, max_length=30, index=True)
    source_id: str | None = Field(default=None, max_length=64)
    source_chapter_id: str | None = Field(
        default=None, max_length=64, index=True, foreign_key="chapters.id"
    )
    quote_anchor: str = Field(default="", max_length=200)
    created_by: str = Field(default="", max_length=100)
    confidence: float | None = Field(default=None)
    confirmation: str = Field(default=DEFAULT_CONFIRMATION, max_length=20, index=True)
    confirmed_at: datetime | None = Field(default=None)
    confirmed_by: str | None = Field(default=None, max_length=100)
