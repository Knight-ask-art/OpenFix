# -*- coding: utf-8 -*-
"""Snapshot of V1 extension payloads for a revision.

OpenFic 的 ``revision_*_snapshots`` 只记录核心表字段（chapters / characters /
world_info_entries）。V1.0 的人物扩展字段、人物状态、章节附加信息、世界设定扩展
信息与关联都存在独立扩展表里，回滚时会遇到两个问题：

* 回滚直接按 repo 删除核心行，不清理扩展表，留下孤立扩展行；
* 回滚恢复被 Agent 删除的核心行时，扩展数据在被删那一刻已经丢失。

因此这里把回滚点当时的扩展负载一并快照下来：新表而非给上游快照表加列，避免与
upstream 快照结构冲突。payload 为 JSON 文本，旧快照没有对应行时按「无扩展负载」
处理，保持向后兼容。
"""

from datetime import UTC, datetime

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel

from app.core.ids import generate_id

# 扩展负载对应的实体类型。
ENTITY_CHAPTER = "chapter"
ENTITY_CHARACTER = "character"
ENTITY_WORLD_ENTRY = "world_entry"

EXTENSION_ENTITY_TYPES: tuple[str, ...] = (
    ENTITY_CHAPTER,
    ENTITY_CHARACTER,
    ENTITY_WORLD_ENTRY,
)


class RevisionExtensionSnapshot(SQLModel, table=True):
    """实体在某个 revision 变更前的扩展表负载。"""

    __tablename__ = "revision_extension_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "revision_id",
            "entity_type",
            "entity_id",
            name="uq_revision_extension_snapshot",
        ),
    )

    id: str = Field(default_factory=generate_id, primary_key=True)
    revision_id: str = Field(index=True, foreign_key="revisions.id")
    entity_type: str = Field(max_length=20, index=True)
    entity_id: str = Field(index=True)
    payload_json: str = Field(default="{}")
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
