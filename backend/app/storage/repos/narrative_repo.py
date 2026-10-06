# -*- coding: utf-8 -*-
"""Narrative Repository - 世界事实 / 人物信念 / 情节线 / 场景计划的数据访问层。

四张表共享同一组溯源列（`NarrativeProvenanceMixin`），因此列表、计数、JSON 文本
列的读写都走同一套辅助函数。所有查询都强制 `project_id` 条件并分页，不做全表扫描。
"""

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete as sql_delete
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.core.errors import ConflictError
from app.storage.models.character_belief import CharacterBelief
from app.storage.models.plotline import Plotline
from app.storage.models.scene_plan import (
    SCENE_RESULT_CATEGORIES,
    ScenePlan,
)
from app.storage.models.world_fact import WorldFact

MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 50


async def confirm_atomic(
    session: AsyncSession, row: Any, *, confirmed_by: str
) -> Any:
    """确认时在同一 SQL 写入内检查版本，防止读后修改的候选被误确认。"""
    model = type(row)
    now = datetime.now(UTC)
    result = await session.execute(
        update(model)
        .where(
            col(model.id) == row.id,
            col(model.project_id) == row.project_id,
            col(model.updated_at) == row.updated_at,
            col(model.confirmation) == row.confirmation,
        )
        .values(
            confirmation="confirmed", confirmed_at=now,
            confirmed_by=confirmed_by, updated_at=now,
        )
        .returning(col(model.id))
        .execution_options(synchronize_session=False)
    )
    if result.scalar_one_or_none() != row.id:
        raise ConflictError("叙事记录已被修改，请刷新后重新确认")
    await session.refresh(row)
    return row


def clamp_limit(limit: int | None) -> int:
    """把请求的分页大小夹到合法区间。"""
    if limit is None:
        return DEFAULT_PAGE_SIZE
    return max(1, min(int(limit), MAX_PAGE_SIZE))


def clamp_offset(offset: int | None) -> int:
    """把请求的偏移量夹到非负。"""
    if offset is None:
        return 0
    return max(0, int(offset))


def load_str_list(raw: str | None) -> list[str]:
    """读取字符串列表；损坏或类型不符时返回空列表。"""
    try:
        parsed = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if isinstance(item, str) and item]


def dump_str_list(values: list[str] | None) -> str:
    """序列化字符串列表并去重保序。"""
    if not values:
        return "[]"
    return json.dumps(list(dict.fromkeys(values)), ensure_ascii=False)


def load_character_goals(raw: str | None) -> list[dict[str, str]]:
    """读取场景内的人物目标列表。"""
    try:
        parsed = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    goals: list[dict[str, str]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        character_id = item.get("character_id")
        goal = item.get("goal")
        if isinstance(character_id, str) and character_id:
            goals.append(
                {"character_id": character_id, "goal": goal if isinstance(goal, str) else ""}
            )
    return goals


def dump_character_goals(values: list[dict[str, str]] | None) -> str:
    """序列化场景内的人物目标列表。"""
    if not values:
        return "[]"
    return json.dumps(
        [
            {"character_id": item["character_id"], "goal": item.get("goal", "")}
            for item in values
        ],
        ensure_ascii=False,
    )


def load_scene_result(raw: str | None) -> dict[str, list[str]]:
    """读取场景结果；缺失的分类补空列表，未知分类丢弃。"""
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    return {category: load_str_list(json.dumps(parsed.get(category, []))) for category in SCENE_RESULT_CATEGORIES}


def dump_scene_result(values: dict[str, list[str]] | None) -> str:
    """序列化场景结果，只保留固定分类。"""
    source = values or {}
    return json.dumps(
        {category: list(source.get(category, [])) for category in SCENE_RESULT_CATEGORIES},
        ensure_ascii=False,
    )


async def _list_page(
    session: AsyncSession,
    model: Any,
    project_id: str,
    *,
    conditions: list[Any],
    order_by: list[Any],
    limit: int,
    offset: int,
) -> tuple[list[Any], int]:
    """按项目分页查询并返回 (行, 总数)。"""
    where = [col(model.project_id) == project_id, *conditions]
    total = await session.scalar(select(func.count()).select_from(model).where(*where))
    result = await session.execute(
        select(model).where(*where).order_by(*order_by).limit(limit).offset(offset)
    )
    return list(result.scalars().all()), int(total or 0)


async def _get_scoped(session: AsyncSession, model: Any, project_id: str, item_id: str) -> Any | None:
    """按 (项目, 主键) 定位一行，跨项目 ID 一律视为不存在。"""
    result = await session.execute(
        select(model).where(
            col(model.id) == item_id, col(model.project_id) == project_id
        )
    )
    return result.scalar_one_or_none()


async def _save(session: AsyncSession, row: Any) -> Any:
    """写入并刷新一行，同时推进 `updated_at`。"""
    row.updated_at = datetime.now(UTC)
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return row


def _default_order(model: Any) -> list[Any]:
    return [col(model.created_at), col(model.id)]


async def existing_ids(
    session: AsyncSession, model: Any, project_id: str, ids: list[str]
) -> set[str]:
    """返回给定 ID 中确实存在于该项目内的子集（用于批量归属校验）。"""
    unique_ids = [item for item in dict.fromkeys(ids) if item]
    if not unique_ids:
        return set()
    result = await session.execute(
        select(col(model.id)).where(
            col(model.project_id) == project_id, col(model.id).in_(unique_ids)
        )
    )
    return {row for row in result.scalars().all()}


# --- 世界事实 ---------------------------------------------------------------


async def create_world_fact(session: AsyncSession, fact: WorldFact) -> WorldFact:
    """创建世界事实。"""
    session.add(fact)
    await session.flush()
    await session.refresh(fact)
    return fact


async def get_world_fact(
    session: AsyncSession, project_id: str, fact_id: str
) -> WorldFact | None:
    """按项目与 ID 获取世界事实。"""
    return await _get_scoped(session, WorldFact, project_id, fact_id)


async def list_world_facts(
    session: AsyncSession,
    project_id: str,
    *,
    status: str | None = None,
    confirmation: str | None = None,
    limit: int,
    offset: int,
) -> tuple[list[WorldFact], int]:
    """分页列出项目内的世界事实。"""
    conditions: list[Any] = []
    if status is not None:
        conditions.append(col(WorldFact.status) == status)
    if confirmation is not None:
        conditions.append(col(WorldFact.confirmation) == confirmation)
    return await _list_page(
        session,
        WorldFact,
        project_id,
        conditions=conditions,
        order_by=_default_order(WorldFact),
        limit=limit,
        offset=offset,
    )


async def save_world_fact(session: AsyncSession, fact: WorldFact) -> WorldFact:
    """保存世界事实变更。"""
    return await _save(session, fact)


async def delete_world_fact(session: AsyncSession, project_id: str, fact_id: str) -> None:
    """删除单条世界事实。"""
    await session.execute(
        sql_delete(WorldFact).where(
            col(WorldFact.id) == fact_id, col(WorldFact.project_id) == project_id
        )
    )
    await session.flush()


# --- 人物信念 ---------------------------------------------------------------


async def create_character_belief(
    session: AsyncSession, belief: CharacterBelief
) -> CharacterBelief:
    """创建人物信念。"""
    session.add(belief)
    await session.flush()
    await session.refresh(belief)
    return belief


async def get_character_belief(
    session: AsyncSession, project_id: str, belief_id: str
) -> CharacterBelief | None:
    """按项目与 ID 获取人物信念。"""
    return await _get_scoped(session, CharacterBelief, project_id, belief_id)


async def list_character_beliefs(
    session: AsyncSession,
    project_id: str,
    *,
    character_id: str | None = None,
    belief_state: str | None = None,
    confirmation: str | None = None,
    limit: int,
    offset: int,
) -> tuple[list[CharacterBelief], int]:
    """分页列出项目内的人物信念。"""
    conditions: list[Any] = []
    if character_id is not None:
        conditions.append(col(CharacterBelief.character_id) == character_id)
    if belief_state is not None:
        conditions.append(col(CharacterBelief.belief_state) == belief_state)
    if confirmation is not None:
        conditions.append(col(CharacterBelief.confirmation) == confirmation)
    return await _list_page(
        session,
        CharacterBelief,
        project_id,
        conditions=conditions,
        order_by=_default_order(CharacterBelief),
        limit=limit,
        offset=offset,
    )


async def save_character_belief(
    session: AsyncSession, belief: CharacterBelief
) -> CharacterBelief:
    """保存人物信念变更。"""
    return await _save(session, belief)


async def delete_character_belief(
    session: AsyncSession, project_id: str, belief_id: str
) -> None:
    """删除单条人物信念。"""
    await session.execute(
        sql_delete(CharacterBelief).where(
            col(CharacterBelief.id) == belief_id,
            col(CharacterBelief.project_id) == project_id,
        )
    )
    await session.flush()


# --- 情节线 -----------------------------------------------------------------


async def create_plotline(session: AsyncSession, plotline: Plotline) -> Plotline:
    """创建情节线。"""
    session.add(plotline)
    await session.flush()
    await session.refresh(plotline)
    return plotline


async def get_plotline(
    session: AsyncSession, project_id: str, plotline_id: str
) -> Plotline | None:
    """按项目与 ID 获取情节线。"""
    return await _get_scoped(session, Plotline, project_id, plotline_id)


async def list_plotlines(
    session: AsyncSession,
    project_id: str,
    *,
    state: str | None = None,
    confirmation: str | None = None,
    limit: int,
    offset: int,
) -> tuple[list[Plotline], int]:
    """分页列出项目内的情节线。"""
    conditions: list[Any] = []
    if state is not None:
        conditions.append(col(Plotline.state) == state)
    if confirmation is not None:
        conditions.append(col(Plotline.confirmation) == confirmation)
    return await _list_page(
        session,
        Plotline,
        project_id,
        conditions=conditions,
        order_by=_default_order(Plotline),
        limit=limit,
        offset=offset,
    )


async def save_plotline(session: AsyncSession, plotline: Plotline) -> Plotline:
    """保存情节线变更。"""
    return await _save(session, plotline)


async def delete_plotline(session: AsyncSession, project_id: str, plotline_id: str) -> None:
    """删除单条情节线。"""
    await session.execute(
        sql_delete(Plotline).where(
            col(Plotline.id) == plotline_id, col(Plotline.project_id) == project_id
        )
    )
    await session.flush()


# --- 场景计划 ---------------------------------------------------------------


async def create_scene_plan(session: AsyncSession, plan: ScenePlan) -> ScenePlan:
    """创建场景计划。"""
    session.add(plan)
    await session.flush()
    await session.refresh(plan)
    return plan


async def get_scene_plan(
    session: AsyncSession, project_id: str, plan_id: str
) -> ScenePlan | None:
    """按项目与 ID 获取场景计划。"""
    return await _get_scoped(session, ScenePlan, project_id, plan_id)


async def list_scene_plans(
    session: AsyncSession,
    project_id: str,
    *,
    chapter_id: str | None = None,
    confirmation: str | None = None,
    limit: int,
    offset: int,
) -> tuple[list[ScenePlan], int]:
    """分页列出项目内的场景计划。"""
    conditions: list[Any] = []
    if chapter_id is not None:
        conditions.append(col(ScenePlan.chapter_id) == chapter_id)
    if confirmation is not None:
        conditions.append(col(ScenePlan.confirmation) == confirmation)
    return await _list_page(
        session,
        ScenePlan,
        project_id,
        conditions=conditions,
        order_by=[
            col(ScenePlan.chapter_id),
            col(ScenePlan.scene_index),
            col(ScenePlan.id),
        ],
        limit=limit,
        offset=offset,
    )


async def find_scene_plan_by_index(
    session: AsyncSession, project_id: str, chapter_id: str, scene_index: int
) -> ScenePlan | None:
    """按章节与场景序号定位，用于唯一性校验。"""
    result = await session.execute(
        select(ScenePlan).where(
            col(ScenePlan.project_id) == project_id,
            col(ScenePlan.chapter_id) == chapter_id,
            col(ScenePlan.scene_index) == scene_index,
        )
    )
    return result.scalars().first()


async def save_scene_plan(session: AsyncSession, plan: ScenePlan) -> ScenePlan:
    """保存场景计划变更。"""
    return await _save(session, plan)


async def delete_scene_plan(session: AsyncSession, project_id: str, plan_id: str) -> None:
    """删除单条场景计划。"""
    await session.execute(
        sql_delete(ScenePlan).where(
            col(ScenePlan.id) == plan_id, col(ScenePlan.project_id) == project_id
        )
    )
    await session.flush()


# --- 项目级清理 -------------------------------------------------------------


async def delete_by_project(session: AsyncSession, project_id: str) -> None:
    """删除项目内全部叙事状态（场景计划 -> 情节线 -> 信念 -> 事实）。

    调用方必须在删除人物 / 章节 / 大纲 / 世界书等被引用行之前执行。
    """
    for model in (ScenePlan, Plotline, CharacterBelief, WorldFact):
        await session.execute(
            sql_delete(model).where(col(model.project_id) == project_id)
        )
    await session.flush()
