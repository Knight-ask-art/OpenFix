# -*- coding: utf-8 -*-
"""
WorldEntryMeta 数据模型 - 世界设定的产品级扩展信息。

OpenFic 原有 `world_info_entries` 只有 name / content / order / is_enabled，
V1.0 的设定类型、标签、关联人物 / 章节与 AI 可见性放在本扩展表，
避免改动上游核心 Schema。
"""

from datetime import UTC, datetime

from sqlmodel import Field, SQLModel

from app.core.ids import generate_id

# 世界设定类型；custom 为「自定义」。
WORLD_ENTRY_TYPES: tuple[str, ...] = (
    "location",
    "organization",
    "nation",
    "faction",
    "rule",
    "history",
    "power_system",
    "technology",
    "custom",
)

DEFAULT_WORLD_ENTRY_TYPE = "custom"


class WorldEntryMeta(SQLModel, table=True):
    """世界设定扩展信息，与 world_info_entries 一一对应。"""

    __tablename__ = "world_entry_meta"

    id: str = Field(default_factory=generate_id, primary_key=True)
    entry_id: str = Field(index=True, unique=True, foreign_key="world_info_entries.id")
    project_id: str = Field(index=True, foreign_key="projects.id")
    entry_type: str = Field(default=DEFAULT_WORLD_ENTRY_TYPE, max_length=30, index=True)
    # 标签 / 关联 ID 以 JSON 字符串存储，避免为小体量关联再建关联表。
    tags_json: str = Field(default="[]")
    linked_character_ids_json: str = Field(default="[]")
    linked_chapter_ids_json: str = Field(default="[]")
    ai_visible: bool = Field(default=True, index=True)
    custom_type_label: str = Field(default="", max_length=100)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
