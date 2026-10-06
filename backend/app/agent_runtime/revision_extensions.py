# -*- coding: utf-8 -*-
"""V1 扩展表负载的捕获与回滚辅助。

``revisions.py`` 的快照只覆盖上游核心表（chapters / characters /
world_info_entries）。V1.0 的人物扩展字段、人物状态、章节附加信息、世界设定扩展
信息与关联都在独立扩展表里，因此回滚需要额外两步：

* 按 repo 直接删除核心行时，把对应扩展行与关联一起清掉（否则留下孤立扩展行）；
* 恢复被 Agent 删除的核心行时，把回滚点当时的扩展负载写回（否则扩展数据丢失）。

负载以 JSON 文本存进 ``revision_extension_snapshots``。捕获时机很关键：删除类工具
会先调用 service 删除核心行（扩展行在同一次事务里已经级联删除），所以删除路径必须
在调用 service *之前* 捕获负载，并把结果传给 ``record_*_diffs(before_extensions=...)``；
新增 / 编辑路径在快照时刻核心行仍然存在，可以直接捕获。
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.storage.models.chapter_meta import DEFAULT_CHAPTER_STATUS
from app.storage.models.character_state import CharacterState
from app.storage.models.revision_extension_snapshot import (
    ENTITY_CHAPTER,
    ENTITY_CHARACTER,
    ENTITY_WORLD_ENTRY,
    RevisionExtensionSnapshot,
)
from app.storage.models.world_entry_meta import DEFAULT_WORLD_ENTRY_TYPE
from app.storage.repos import (
    chapter_meta_repo,
    character_extension_repo,
    world_entry_meta_repo,
)
from app.storage.services import narrative_service

PAYLOAD_VERSION = 1


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _state_payload(state: CharacterState) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": state.id,
        "character_id": state.character_id,
        "project_id": state.project_id,
        "chapter_id": state.chapter_id,
        "created_at": _iso(state.created_at),
        "updated_at": _iso(state.updated_at),
    }
    for field in character_extension_repo.STATE_TEXT_FIELDS:
        payload[field] = getattr(state, field, "") or ""
    return payload


def _state_row(payload: dict[str, Any]) -> dict[str, Any] | None:
    state_id = payload.get("id")
    character_id = payload.get("character_id")
    project_id = payload.get("project_id")
    chapter_id = payload.get("chapter_id")
    if not all(
        isinstance(value, str) and value
        for value in (state_id, character_id, project_id)
    ):
        return None
    if chapter_id is not None and not isinstance(chapter_id, str):
        return None

    row: dict[str, Any] = {
        "id": state_id,
        "character_id": character_id,
        "project_id": project_id,
        "chapter_id": chapter_id,
    }
    for field in character_extension_repo.STATE_TEXT_FIELDS:
        value = payload.get(field)
        if value is not None and not isinstance(value, str):
            return None
        row[field] = value or ""
    created_at = _parse_datetime(payload.get("created_at"))
    updated_at = _parse_datetime(payload.get("updated_at"))
    if created_at is not None:
        row["created_at"] = created_at
    if updated_at is not None:
        row["updated_at"] = updated_at
    return row


def _state_rows(
    payloads: Any,
    *,
    project_id: str,
    character_id: str | None = None,
    chapter_id: str | None = None,
) -> list[dict[str, Any]] | None:
    """Validate a captured state collection without applying partial corruption."""
    if not isinstance(payloads, list):
        return None
    rows: list[dict[str, Any]] = []
    for payload in payloads:
        if not isinstance(payload, dict):
            return None
        row = _state_row(payload)
        if row is None or row["project_id"] != project_id:
            return None
        if character_id is not None and row["character_id"] != character_id:
            return None
        if chapter_id is not None and row["chapter_id"] != chapter_id:
            return None
        rows.append(row)
    return rows


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


async def _entry_ids_linking(
    session: AsyncSession,
    project_id: str,
    *,
    chapter_id: str | None = None,
    character_id: str | None = None,
) -> list[str]:
    """列出扩展信息里关联了该章节 / 人物的世界书条目 ID。"""
    linked: list[str] = []
    for meta in await world_entry_meta_repo.list_by_project(session, project_id):
        if chapter_id is not None:
            ids = world_entry_meta_repo.get_linked_chapter_ids(meta)
        else:
            ids = world_entry_meta_repo.get_linked_character_ids(meta)
        target = chapter_id if chapter_id is not None else character_id
        if target and target in ids:
            linked.append(meta.entry_id)
    return linked


async def _restore_entry_links(
    session: AsyncSession,
    project_id: str,
    entry_ids: Iterable[str],
    *,
    chapter_id: str | None = None,
    character_id: str | None = None,
) -> None:
    """把已恢复实体的关联 ID 写回仍存在的条目扩展信息。"""
    for entry_id in entry_ids:
        meta = await world_entry_meta_repo.get_by_entry_id(session, entry_id)
        if meta is None:
            # 条目或它的扩展行已不存在（例如条目也在同一轮回滚中被删除）。
            continue
        if chapter_id is not None:
            linked = world_entry_meta_repo.get_linked_chapter_ids(meta)
            if chapter_id in linked:
                continue
            await world_entry_meta_repo.upsert(
                session,
                entry_id=entry_id,
                project_id=project_id,
                linked_chapter_ids=[*linked, chapter_id],
            )
            continue
        if character_id is None:
            continue
        linked = world_entry_meta_repo.get_linked_character_ids(meta)
        if character_id in linked:
            continue
        await world_entry_meta_repo.upsert(
            session,
            entry_id=entry_id,
            project_id=project_id,
            linked_character_ids=[*linked, character_id],
        )


async def capture_chapter_extensions(
    session: AsyncSession,
    *,
    project_id: str,
    chapter_id: str,
) -> dict[str, Any]:
    """捕获章节当前的产品级扩展信息、章节内人物状态与条目关联。"""
    meta = await chapter_meta_repo.get_by_chapter_id(session, chapter_id)
    states = await character_extension_repo.list_states_by_chapter(session, chapter_id)
    return {
        "version": PAYLOAD_VERSION,
        "meta": (
            {
                "status": meta.status,
                "target_word_count": meta.target_word_count,
                "last_ai_check_at": _iso(meta.last_ai_check_at),
            }
            if meta is not None
            else None
        ),
        "character_states": [_state_payload(state) for state in states],
        "world_entry_links": await _entry_ids_linking(
            session, project_id, chapter_id=chapter_id
        ),
    }


async def capture_character_extensions(
    session: AsyncSession,
    *,
    project_id: str,
    character_id: str,
) -> dict[str, Any]:
    """捕获人物当前的作者扩展字段、动态状态与条目关联。"""
    profile = await character_extension_repo.get_profile(session, character_id)
    states = await character_extension_repo.list_states(session, character_id)
    return {
        "version": PAYLOAD_VERSION,
        "profile": (
            {
                field: getattr(profile, field, "") or ""
                for field in character_extension_repo.PROFILE_TEXT_FIELDS
            }
            if profile is not None
            else None
        ),
        "states": [_state_payload(state) for state in states],
        "world_entry_links": await _entry_ids_linking(
            session, project_id, character_id=character_id
        ),
    }


async def capture_world_entry_extensions(
    session: AsyncSession,
    *,
    entry_id: str,
) -> dict[str, Any]:
    """捕获世界设定条目当前的扩展信息（类型 / 标签 / 关联 / AI 可见性）。"""
    meta = await world_entry_meta_repo.get_by_entry_id(session, entry_id)
    return {
        "version": PAYLOAD_VERSION,
        "meta": (
            {
                "entry_type": meta.entry_type,
                "tags": world_entry_meta_repo.get_tags(meta),
                "linked_character_ids": world_entry_meta_repo.get_linked_character_ids(meta),
                "linked_chapter_ids": world_entry_meta_repo.get_linked_chapter_ids(meta),
                "ai_visible": meta.ai_visible,
                "custom_type_label": meta.custom_type_label,
            }
            if meta is not None
            else None
        ),
    }


def parse_payload(raw: str | None) -> dict[str, Any]:
    """把快照里的 JSON 文本解析成负载字典；损坏时按空负载处理。"""
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def map_payloads(
    snapshots: Iterable[RevisionExtensionSnapshot],
    entity_type: str,
) -> dict[str, dict[str, Any]]:
    """按实体 ID 归并某类型的扩展负载；同一实体保留最早的一条。"""
    payloads: dict[str, dict[str, Any]] = {}
    for snapshot in snapshots:
        if snapshot.entity_type != entity_type:
            continue
        payloads.setdefault(snapshot.entity_id, parse_payload(snapshot.payload_json))
    return payloads


async def delete_chapter_extensions(
    session: AsyncSession,
    *,
    project_id: str,
    chapter_id: str,
) -> None:
    """删除章节时同步清理其扩展行、条目关联与叙事状态（与章节 service 的级联一致）。"""
    await chapter_meta_repo.delete_by_chapter(session, chapter_id)
    await character_extension_repo.delete_states_for_chapters(session, [chapter_id])
    await world_entry_meta_repo.remove_chapter_links(session, project_id, [chapter_id])
    await narrative_service.delete_chapter_narrative_data(
        session, project_id, [chapter_id]
    )


async def delete_character_extensions(
    session: AsyncSession,
    *,
    project_id: str,
    character_id: str,
) -> None:
    """删除人物时同步清理其扩展字段、状态、条目关联与叙事状态。"""
    await character_extension_repo.delete_states_for_character(session, character_id)
    await character_extension_repo.delete_profile(session, character_id)
    await world_entry_meta_repo.remove_character_links(session, project_id, [character_id])
    await narrative_service.delete_character_narrative_data(
        session, project_id, [character_id]
    )


async def delete_world_entry_extensions(
    session: AsyncSession,
    *,
    entry_id: str,
) -> None:
    """删除世界设定条目时同步清理其扩展信息。"""
    await world_entry_meta_repo.delete_by_entry_id(session, entry_id)


async def restore_chapter_extensions(
    session: AsyncSession,
    *,
    project_id: str,
    chapter_id: str,
    payload: dict[str, Any],
) -> None:
    """按快照负载恢复章节的扩展信息、章节内人物状态与条目关联。"""
    meta = payload.get("meta")
    if isinstance(meta, dict):
        await chapter_meta_repo.upsert(
            session,
            chapter_id=chapter_id,
            project_id=project_id,
            values={
                "status": meta.get("status") or DEFAULT_CHAPTER_STATUS,
                "target_word_count": int(meta.get("target_word_count") or 0),
                "last_ai_check_at": _parse_datetime(meta.get("last_ai_check_at")),
            },
        )
    states = payload.get("character_states")
    if isinstance(states, list):
        rows = _state_rows(
            states, project_id=project_id, chapter_id=chapter_id
        )
        if rows is not None:
            await character_extension_repo.replace_states(
                session, rows, chapter_id=chapter_id
            )
    await _restore_entry_links(
        session, project_id, _string_list(payload.get("world_entry_links")), chapter_id=chapter_id
    )


async def restore_character_extensions(
    session: AsyncSession,
    *,
    project_id: str,
    character_id: str,
    payload: dict[str, Any],
    existing_chapter_ids: set[str] | None = None,
) -> None:
    """按快照负载恢复人物的作者扩展字段、状态与条目关联。

    ``existing_chapter_ids`` 给出当前仍存在的章节 ID；绑定到已删除章节的状态记录
    与章节删除时的级联行为保持一致，不再恢复。
    """
    profile = payload.get("profile")
    if isinstance(profile, dict):
        await character_extension_repo.upsert_profile(
            session,
            character_id,
            {
                field: str(profile.get(field) or "")
                for field in character_extension_repo.PROFILE_TEXT_FIELDS
            },
        )
    states = payload.get("states")
    if isinstance(states, list):
        rows = _state_rows(
            states, project_id=project_id, character_id=character_id
        )
        if rows is not None:
            rows = [
                row
                for row in rows
                if not row["chapter_id"]
                or existing_chapter_ids is None
                or row["chapter_id"] in existing_chapter_ids
            ]
            await character_extension_repo.replace_states(
                session, rows, character_id=character_id
            )
    await _restore_entry_links(
        session,
        project_id,
        _string_list(payload.get("world_entry_links")),
        character_id=character_id,
    )


async def restore_world_entry_extensions(
    session: AsyncSession,
    *,
    project_id: str,
    entry_id: str,
    payload: dict[str, Any],
) -> None:
    """按快照负载恢复世界设定条目的扩展信息。"""
    meta = payload.get("meta")
    if not isinstance(meta, dict):
        return
    await world_entry_meta_repo.upsert(
        session,
        entry_id=entry_id,
        project_id=project_id,
        entry_type=str(meta.get("entry_type") or DEFAULT_WORLD_ENTRY_TYPE),
        tags=[tag for tag in meta.get("tags") or [] if isinstance(tag, str)],
        linked_character_ids=_string_list(meta.get("linked_character_ids")),
        linked_chapter_ids=_string_list(meta.get("linked_chapter_ids")),
        ai_visible=bool(meta.get("ai_visible", True)),
        custom_type_label=str(meta.get("custom_type_label") or ""),
    )


__all__ = [
    "ENTITY_CHAPTER",
    "ENTITY_CHARACTER",
    "ENTITY_WORLD_ENTRY",
    "PAYLOAD_VERSION",
    "capture_chapter_extensions",
    "capture_character_extensions",
    "capture_world_entry_extensions",
    "delete_chapter_extensions",
    "delete_character_extensions",
    "delete_world_entry_extensions",
    "map_payloads",
    "parse_payload",
    "restore_chapter_extensions",
    "restore_character_extensions",
    "restore_world_entry_extensions",
]
