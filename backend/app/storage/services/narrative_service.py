# -*- coding: utf-8 -*-
"""Narrative Service - 叙事状态业务逻辑层。

职责：

* 项目作用域解析与归属校验（人物 / 章节 / 大纲 / 世界设定必须属于当前项目）；
* 枚举、文本长度、置信度区间的规范化与校验；
* 「候选 -> 已确认」的升级防护：创建与常规更新都只能产生未确认记录，
  确认只能走确认接口，并且必须携带未过期的 `updated_at` 令牌；
* 取代与失效：保留行，不静默删除。

四张表（世界事实 / 人物信念 / 情节线 / 场景计划）是彼此独立的扩展表，共享同一组
溯源列。事实与信念不共用接口、不共用状态枚举，绝不互相推导。
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.storage.models.character_belief import (
    BELIEF_STATES,
    DEFAULT_BELIEF_STATE,
    CharacterBelief,
)
from app.storage.models.narrative_provenance import (
    CONFIRMATION_STATES,
    DEFAULT_CONFIRMATION,
    DEFAULT_SOURCE_TYPE,
    PROJECT_SCOPED_SOURCE_TYPES,
    SOURCE_TYPES,
    WRITABLE_CONFIRMATIONS,
)
from app.storage.models.plotline import (
    DEFAULT_PLOTLINE_STATE,
    PLOTLINE_STATES,
    Plotline,
)
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.world_fact import (
    DEFAULT_WORLD_FACT_STATUS,
    WORLD_FACT_STATUSES,
    WorldFact,
)
from app.storage.repos import (
    chapter_repo,
    character_repo,
    narrative_repo,
    outline_repo,
    project_repo,
    world_info_entry_repo,
    world_info_repo,
)

MAX_LIST_ITEMS = 200
MAX_ITEM_LENGTH = 500
MAX_TEXT_LENGTH = 20000

# 人类通过确认接口确认时写入的默认主体；调用方可以覆盖。
DEFAULT_CONFIRMER = "user"


def resolve_page(limit: int | None, offset: int | None) -> tuple[int, int]:
    """把请求的分页参数夹到合法区间，用于回显与查询。"""
    return narrative_repo.clamp_limit(limit), narrative_repo.clamp_offset(offset)


# --- 视图对象 ---------------------------------------------------------------


@dataclass
class ProvenanceView:
    """共享溯源与确认信息。"""

    source_type: str = DEFAULT_SOURCE_TYPE
    source_id: str | None = None
    source_chapter_id: str | None = None
    quote_anchor: str = ""
    created_by: str = ""
    confidence: float | None = None
    confirmation: str = DEFAULT_CONFIRMATION
    confirmed_at: datetime | None = None
    confirmed_by: str | None = None


@dataclass
class WorldFactView:
    """世界事实视图。"""

    id: str
    project_id: str
    statement: str
    subject_ref: str
    status: str
    superseded_by_id: str | None
    provenance: ProvenanceView
    created_at: datetime
    updated_at: datetime


@dataclass
class CharacterBeliefView:
    """人物信念视图。"""

    id: str
    project_id: str
    character_id: str
    proposition: str
    belief_state: str
    learned_at_chapter_id: str | None
    superseded_by_id: str | None
    invalidated_at: datetime | None
    provenance: ProvenanceView
    created_at: datetime
    updated_at: datetime


@dataclass
class PlotlineView:
    """情节线视图。"""

    id: str
    project_id: str
    title: str
    description: str
    current_question: str
    payoff: str
    state: str
    introduced_chapter_id: str | None
    advanced_chapter_id: str | None
    related_character_ids: list[str] = field(default_factory=list)
    related_outline_ids: list[str] = field(default_factory=list)
    provenance: ProvenanceView = field(default_factory=ProvenanceView)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class ScenePlanView:
    """场景计划视图。"""

    id: str
    project_id: str
    chapter_id: str
    scene_index: int
    goal: str
    pov_character_id: str | None
    location: str
    tone: str
    preconditions: list[str] = field(default_factory=list)
    participants: list[str] = field(default_factory=list)
    character_goals: list[dict[str, str]] = field(default_factory=list)
    known_information: list[str] = field(default_factory=list)
    hidden_information: list[str] = field(default_factory=list)
    active_plotline_ids: list[str] = field(default_factory=list)
    world_constraints: list[str] = field(default_factory=list)
    expected_changes: list[str] = field(default_factory=list)
    result: dict[str, list[str]] = field(default_factory=dict)
    provenance: ProvenanceView = field(default_factory=ProvenanceView)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))


def _to_provenance(row: Any) -> ProvenanceView:
    return ProvenanceView(
        source_type=row.source_type,
        source_id=row.source_id,
        source_chapter_id=row.source_chapter_id,
        quote_anchor=row.quote_anchor,
        created_by=row.created_by,
        confidence=row.confidence,
        confirmation=row.confirmation,
        confirmed_at=row.confirmed_at,
        confirmed_by=row.confirmed_by,
    )


# --- 基础校验 ---------------------------------------------------------------


def _as_utc(value: datetime) -> datetime:
    """把数据库返回的时间统一成 UTC；SQLite 返回的是 naive 值。"""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _normalize_enum(value: Any, allowed: tuple[str, ...], label: str) -> str:
    normalized = str(value).strip()
    if normalized not in allowed:
        raise ValidationError(f"不支持的{label}: {value}")
    return normalized


def _normalize_text(value: Any, *, label: str, max_length: int = MAX_TEXT_LENGTH) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if len(text) > max_length:
        raise ValidationError(f"{label}长度不能超过 {max_length} 个字符")
    return text


def _normalize_required_text(value: Any, *, label: str) -> str:
    text = _normalize_text(value, label=label)
    if not text:
        raise ValidationError(f"{label}不能为空")
    return text


def _normalize_optional_id(value: Any, *, label: str) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > 64:
        raise ValidationError(f"{label}长度不能超过 64 个字符")
    return text


def _normalize_confidence(value: Any) -> float | None:
    if value is None:
        return None
    try:
        confidence = float(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"置信度必须是数字: {value}") from exc
    if confidence < 0.0 or confidence > 1.0:
        raise ValidationError("置信度必须在 0 到 1 之间")
    return confidence


def _normalize_str_list(value: Any, *, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError(f"{label}必须是列表")
    if len(value) > MAX_LIST_ITEMS:
        raise ValidationError(f"{label}数量不能超过 {MAX_LIST_ITEMS} 个")
    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValidationError(f"{label}只能包含字符串")
        text = item.strip()
        if not text:
            continue
        if len(text) > MAX_ITEM_LENGTH:
            raise ValidationError(f"{label}单项长度不能超过 {MAX_ITEM_LENGTH} 个字符")
        if text not in normalized:
            normalized.append(text)
    return normalized


def _normalize_character_goals(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError("人物目标必须是列表")
    if len(value) > MAX_LIST_ITEMS:
        raise ValidationError(f"人物目标数量不能超过 {MAX_LIST_ITEMS} 个")
    goals: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValidationError("人物目标每一项必须是对象")
        character_id = _normalize_optional_id(
            item.get("character_id"), label="人物目标的人物 ID"
        )
        if character_id is None:
            raise ValidationError("人物目标缺少 character_id")
        goals.append(
            {
                "character_id": character_id,
                "goal": _normalize_text(item.get("goal"), label="人物目标内容"),
            }
        )
    return goals


def _normalize_scene_result(value: Any) -> dict[str, list[str]]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValidationError("场景结果必须是对象")
    return {
        category: _normalize_str_list(value.get(category), label=f"场景结果 {category}")
        for category in ("fact_changes", "belief_changes", "relationship_changes", "state_changes", "plotline_changes")
    }


# --- 确认状态防护 -----------------------------------------------------------


def _guard_create_confirmation(requested: Any) -> str:
    """创建只允许产生未确认记录。"""
    if requested is None:
        return DEFAULT_CONFIRMATION
    confirmation = _normalize_enum(requested, CONFIRMATION_STATES, "确认状态")
    if confirmation not in WRITABLE_CONFIRMATIONS:
        raise ValidationError("创建记录不能直接写入已确认状态，请使用确认接口")
    return confirmation


def _guard_update_confirmation(current: str, requested: Any) -> None:
    """常规更新不允许升级为已确认，也不允许把已确认记录改回未确认。"""
    if requested is None:
        return
    confirmation = _normalize_enum(requested, CONFIRMATION_STATES, "确认状态")
    if confirmation not in WRITABLE_CONFIRMATIONS:
        raise ValidationError("确认状态只能通过确认接口设置")
    if current == "confirmed":
        raise ValidationError("已确认记录不能通过常规更新改回未确认状态")


async def _confirm_row(
    session: AsyncSession,
    *,
    project_id: str,
    item_id: str,
    expected_updated_at: datetime,
    confirmed_by: str | None,
    getter: Any,
    label: str,
) -> Any:
    """通用确认流程：先做乐观锁校验，再写入确认信息。"""
    row = await getter(session, project_id, item_id)
    if row is None:
        raise NotFoundError(f"{label}不存在: {item_id}")
    if _as_utc(row.updated_at) != _as_utc(expected_updated_at):
        raise ConflictError(f"{label}已被修改，请刷新后重新确认")
    if row.confirmation == "confirmed":
        # 幂等：已经确认过的记录在令牌匹配时原样返回。
        return row
    return await narrative_repo.confirm_atomic(
        session, row,
        confirmed_by=(confirmed_by or DEFAULT_CONFIRMER).strip()[:100],
    )


# --- 项目与归属校验 ---------------------------------------------------------


async def _require_project(session: AsyncSession, project_id: str) -> None:
    project = await project_repo.get_by_id(session, project_id)
    if project is None:
        raise NotFoundError(f"项目不存在: {project_id}")


async def _require_chapter(session: AsyncSession, project_id: str, chapter_id: str, label: str) -> str:
    chapter = await chapter_repo.get_by_id(session, chapter_id)
    if chapter is None or chapter.project_id != project_id:
        raise ValidationError(f"{label}不存在于当前项目: {chapter_id}")
    return chapter_id


async def _require_characters(
    session: AsyncSession, project_id: str, character_ids: list[str], label: str
) -> list[str]:
    unique_ids = [item for item in dict.fromkeys(character_ids) if item]
    if not unique_ids:
        return []
    found = await character_repo.list_by_project_and_ids(session, project_id, unique_ids)
    found_ids = {character.id for character in found}
    missing = [item for item in unique_ids if item not in found_ids]
    if missing:
        raise ValidationError(f"{label}不存在于当前项目: {missing[0]}")
    return unique_ids


async def _require_outlines(
    session: AsyncSession, project_id: str, outline_ids: list[str], label: str
) -> list[str]:
    unique_ids = [item for item in dict.fromkeys(outline_ids) if item]
    for outline_id in unique_ids:
        outline = await outline_repo.get_by_id(session, outline_id)
        if outline is None or outline.project_id != project_id:
            raise ValidationError(f"{label}不存在于当前项目: {outline_id}")
    return unique_ids


async def _require_world_entries(
    session: AsyncSession, project_id: str, entry_ids: list[str], label: str
) -> list[str]:
    unique_ids = [item for item in dict.fromkeys(entry_ids) if item]
    for entry_id in unique_ids:
        entry = await world_info_entry_repo.get_by_id(session, entry_id)
        if entry is None:
            raise ValidationError(f"{label}不存在: {entry_id}")
        world_info = await world_info_repo.get_by_id(session, entry.world_info_id)
        if world_info is None or world_info.project_id != project_id:
            raise ValidationError(f"{label}不存在于当前项目: {entry_id}")
    return unique_ids


async def _require_plotlines(
    session: AsyncSession, project_id: str, plotline_ids: list[str], label: str
) -> list[str]:
    unique_ids = [item for item in dict.fromkeys(plotline_ids) if item]
    if not unique_ids:
        return []
    existing = await narrative_repo.existing_ids(
        session, Plotline, project_id, unique_ids
    )
    missing = [item for item in unique_ids if item not in existing]
    if missing:
        raise ValidationError(f"{label}不存在于当前项目: {missing[0]}")
    return unique_ids


async def _validate_provenance_source(
    session: AsyncSession,
    project_id: str,
    *,
    source_type: str | None,
    source_id: str | None,
    source_chapter_id: str | None,
) -> None:
    """校验溯源来源；只对项目内实体做归属校验，其余来源只保存标识。"""
    if source_chapter_id is not None:
        await _require_chapter(session, project_id, source_chapter_id, "溯源章节")
    if source_id is None or source_type not in PROJECT_SCOPED_SOURCE_TYPES:
        return
    if source_type == "chapter":
        await _require_chapter(session, project_id, source_id, "溯源来源章节")
    elif source_type == "outline":
        await _require_outlines(session, project_id, [source_id], "溯源来源大纲")
    elif source_type == "world_info":
        await _require_world_entries(session, project_id, [source_id], "溯源来源世界设定")
    elif source_type == "character_profile":
        await _require_characters(session, project_id, [source_id], "溯源来源人物")


def _apply_provenance(
    row: Any,
    *,
    source_type: str | None = None,
    source_id: Any = ...,
    source_chapter_id: Any = ...,
    quote_anchor: str | None = None,
    created_by: str | None = None,
    confidence: Any = ...,
) -> None:
    """把溯源字段写入行；省略号表示「保持不变」，None 表示「显式清空」。"""
    if source_type is not None:
        row.source_type = _normalize_enum(source_type, SOURCE_TYPES, "溯源来源")
    if source_id is not ...:
        row.source_id = _normalize_optional_id(source_id, label="溯源来源 ID")
    if source_chapter_id is not ...:
        row.source_chapter_id = _normalize_optional_id(
            source_chapter_id, label="溯源章节 ID"
        )
    if quote_anchor is not None:
        row.quote_anchor = _normalize_text(
            quote_anchor, label="引用锚点", max_length=200
        )
    if created_by is not None:
        row.created_by = _normalize_text(created_by, label="创建者", max_length=100)
    if confidence is not ...:
        row.confidence = _normalize_confidence(confidence)


PROVENANCE_KEYS = frozenset(
    {
        "source_type",
        "source_id",
        "source_chapter_id",
        "quote_anchor",
        "created_by",
        "confidence",
    }
)


def _reject_unknown_keys(changes: dict[str, Any], allowed: frozenset[str]) -> None:
    unknown = [key for key in changes if key not in allowed]
    if unknown:
        raise ValidationError(f"不支持的字段: {unknown[0]}")


# --- 世界事实 ---------------------------------------------------------------


def _to_world_fact_view(fact: WorldFact) -> WorldFactView:
    return WorldFactView(
        id=fact.id,
        project_id=fact.project_id,
        statement=fact.statement,
        subject_ref=fact.subject_ref,
        status=fact.status,
        superseded_by_id=fact.superseded_by_id,
        provenance=_to_provenance(fact),
        created_at=fact.created_at,
        updated_at=fact.updated_at,
    )


async def create_world_fact(
    session: AsyncSession,
    project_id: str,
    *,
    statement: Any,
    subject_ref: Any = None,
    status: Any = None,
    source_type: Any = None,
    source_id: Any = None,
    source_chapter_id: Any = None,
    quote_anchor: Any = None,
    created_by: Any = None,
    confidence: Any = None,
    confirmation: Any = None,
) -> WorldFactView:
    """创建世界事实；默认只能产生候选或推断，不会直接成为已确认事实。"""
    await _require_project(session, project_id)
    resolved_confirmation = _guard_create_confirmation(confirmation)
    resolved_source_type = (
        _normalize_enum(source_type, SOURCE_TYPES, "溯源来源")
        if source_type is not None
        else DEFAULT_SOURCE_TYPE
    )
    resolved_source_id = _normalize_optional_id(source_id, label="溯源来源 ID")
    resolved_source_chapter_id = _normalize_optional_id(
        source_chapter_id, label="溯源章节 ID"
    )
    await _validate_provenance_source(
        session,
        project_id,
        source_type=resolved_source_type,
        source_id=resolved_source_id,
        source_chapter_id=resolved_source_chapter_id,
    )

    fact = WorldFact(
        project_id=project_id,
        statement=_normalize_required_text(statement, label="事实陈述"),
        subject_ref=_normalize_text(subject_ref, label="事实主体", max_length=200),
        status=(
            _normalize_enum(status, WORLD_FACT_STATUSES, "事实状态")
            if status is not None
            else DEFAULT_WORLD_FACT_STATUS
        ),
        source_type=resolved_source_type,
        source_id=resolved_source_id,
        source_chapter_id=resolved_source_chapter_id,
        quote_anchor=_normalize_text(quote_anchor, label="引用锚点", max_length=200),
        created_by=_normalize_text(created_by, label="创建者", max_length=100),
        confidence=_normalize_confidence(confidence),
        confirmation=resolved_confirmation,
    )
    return _to_world_fact_view(await narrative_repo.create_world_fact(session, fact))


async def get_world_fact(
    session: AsyncSession, project_id: str, fact_id: str
) -> WorldFactView:
    """获取单条世界事实。"""
    await _require_project(session, project_id)
    fact = await narrative_repo.get_world_fact(session, project_id, fact_id)
    if fact is None:
        raise NotFoundError(f"世界事实不存在: {fact_id}")
    return _to_world_fact_view(fact)


async def list_world_facts(
    session: AsyncSession,
    project_id: str,
    *,
    status: str | None = None,
    confirmation: str | None = None,
    limit: int | None = None,
    offset: int | None = None,
) -> tuple[list[WorldFactView], int]:
    """分页列出项目内的世界事实。"""
    await _require_project(session, project_id)
    resolved_status = (
        _normalize_enum(status, WORLD_FACT_STATUSES, "事实状态") if status is not None else None
    )
    resolved_confirmation = (
        _normalize_enum(confirmation, CONFIRMATION_STATES, "确认状态")
        if confirmation is not None
        else None
    )
    rows, total = await narrative_repo.list_world_facts(
        session,
        project_id,
        status=resolved_status,
        confirmation=resolved_confirmation,
        limit=narrative_repo.clamp_limit(limit),
        offset=narrative_repo.clamp_offset(offset),
    )
    return [_to_world_fact_view(row) for row in rows], total


WORLD_FACT_UPDATE_KEYS = PROVENANCE_KEYS | frozenset(
    {"statement", "subject_ref", "status", "superseded_by_id", "confirmation"}
)


async def update_world_fact(
    session: AsyncSession,
    project_id: str,
    fact_id: str,
    *,
    changes: dict[str, Any],
) -> WorldFactView:
    """常规更新世界事实；拒绝升级为已确认状态。"""
    await _require_project(session, project_id)
    fact = await narrative_repo.get_world_fact(session, project_id, fact_id)
    if fact is None:
        raise NotFoundError(f"世界事实不存在: {fact_id}")
    _reject_unknown_keys(changes, WORLD_FACT_UPDATE_KEYS)
    _guard_update_confirmation(fact.confirmation, changes.get("confirmation"))

    if "superseded_by_id" in changes and changes["superseded_by_id"] is not None:
        replacement_id = _normalize_optional_id(
            changes["superseded_by_id"], label="取代事实 ID"
        )
        if replacement_id == fact.id:
            raise ValidationError("事实不能取代自身")
        await _require_world_fact(session, project_id, replacement_id)

    await _validate_provenance_source(
        session,
        project_id,
        source_type=changes.get("source_type", fact.source_type),
        source_id=(
            changes["source_id"] if "source_id" in changes else fact.source_id
        ),
        source_chapter_id=(
            changes["source_chapter_id"]
            if "source_chapter_id" in changes
            else fact.source_chapter_id
        ),
    )

    if "statement" in changes:
        fact.statement = _normalize_required_text(changes["statement"], label="事实陈述")
    if "subject_ref" in changes:
        fact.subject_ref = _normalize_text(
            changes["subject_ref"], label="事实主体", max_length=200
        )
    if "status" in changes:
        fact.status = _normalize_enum(changes["status"], WORLD_FACT_STATUSES, "事实状态")
    if "confirmation" in changes:
        fact.confirmation = _normalize_enum(
            changes["confirmation"], CONFIRMATION_STATES, "确认状态"
        )
    if "superseded_by_id" in changes:
        replacement_id = _normalize_optional_id(
            changes["superseded_by_id"], label="取代事实 ID"
        )
        fact.superseded_by_id = replacement_id
        if replacement_id is not None:
            # 被取代的事实保留行，但状态退场，避免静默消失。
            fact.status = "retired"

    _apply_provenance(
        fact,
        source_type=changes.get("source_type"),
        source_id=changes.get("source_id", ...),
        source_chapter_id=changes.get("source_chapter_id", ...),
        quote_anchor=changes.get("quote_anchor"),
        created_by=changes.get("created_by"),
        confidence=changes.get("confidence", ...),
    )
    return _to_world_fact_view(await narrative_repo.save_world_fact(session, fact))


async def _require_world_fact(
    session: AsyncSession, project_id: str, fact_id: str | None
) -> str | None:
    if fact_id is None:
        return None
    existing = await narrative_repo.existing_ids(
        session, WorldFact, project_id, [fact_id]
    )
    if fact_id not in existing:
        raise ValidationError(f"取代事实不存在于当前项目: {fact_id}")
    return fact_id


async def delete_world_fact(session: AsyncSession, project_id: str, fact_id: str) -> None:
    """删除单条世界事实（显式操作；建议优先使用取代或 retired 状态）。"""
    await _require_project(session, project_id)
    fact = await narrative_repo.get_world_fact(session, project_id, fact_id)
    if fact is None:
        raise NotFoundError(f"世界事实不存在: {fact_id}")
    await narrative_repo.delete_world_fact(session, project_id, fact_id)


async def confirm_world_fact(
    session: AsyncSession,
    project_id: str,
    fact_id: str,
    *,
    expected_updated_at: datetime,
    confirmed_by: str | None = None,
) -> WorldFactView:
    """人工确认世界事实；令牌过期时拒绝，防止基于旧数据确认。"""
    await _require_project(session, project_id)
    fact = await _confirm_row(
        session,
        project_id=project_id,
        item_id=fact_id,
        expected_updated_at=expected_updated_at,
        confirmed_by=confirmed_by,
        getter=narrative_repo.get_world_fact,
        label="世界事实",
    )
    return _to_world_fact_view(fact)


# --- 人物信念 ---------------------------------------------------------------


def _to_character_belief_view(belief: CharacterBelief) -> CharacterBeliefView:
    return CharacterBeliefView(
        id=belief.id,
        project_id=belief.project_id,
        character_id=belief.character_id,
        proposition=belief.proposition,
        belief_state=belief.belief_state,
        learned_at_chapter_id=belief.learned_at_chapter_id,
        superseded_by_id=belief.superseded_by_id,
        invalidated_at=belief.invalidated_at,
        provenance=_to_provenance(belief),
        created_at=belief.created_at,
        updated_at=belief.updated_at,
    )


async def create_character_belief(
    session: AsyncSession,
    project_id: str,
    *,
    character_id: Any,
    proposition: Any,
    belief_state: Any = None,
    learned_at_chapter_id: Any = None,
    source_type: Any = None,
    source_id: Any = None,
    source_chapter_id: Any = None,
    quote_anchor: Any = None,
    created_by: Any = None,
    confidence: Any = None,
    confirmation: Any = None,
) -> CharacterBeliefView:
    """创建人物信念；事实与信念分开建模，这里只产生「人物相信」的记录。"""
    await _require_project(session, project_id)
    resolved_confirmation = _guard_create_confirmation(confirmation)
    resolved_character_id = _normalize_optional_id(character_id, label="人物 ID")
    if resolved_character_id is None:
        raise ValidationError("人物信念必须指定 character_id")
    await _require_characters(
        session, project_id, [resolved_character_id], "关联人物"
    )
    resolved_learned_at = _normalize_optional_id(
        learned_at_chapter_id, label="得知章节 ID"
    )
    if resolved_learned_at is not None:
        await _require_chapter(session, project_id, resolved_learned_at, "得知章节")

    resolved_source_type = (
        _normalize_enum(source_type, SOURCE_TYPES, "溯源来源")
        if source_type is not None
        else DEFAULT_SOURCE_TYPE
    )
    resolved_source_id = _normalize_optional_id(source_id, label="溯源来源 ID")
    resolved_source_chapter_id = _normalize_optional_id(
        source_chapter_id, label="溯源章节 ID"
    )
    await _validate_provenance_source(
        session,
        project_id,
        source_type=resolved_source_type,
        source_id=resolved_source_id,
        source_chapter_id=resolved_source_chapter_id,
    )

    belief = CharacterBelief(
        project_id=project_id,
        character_id=resolved_character_id,
        proposition=_normalize_required_text(proposition, label="信念命题"),
        belief_state=(
            _normalize_enum(belief_state, BELIEF_STATES, "信念状态")
            if belief_state is not None
            else DEFAULT_BELIEF_STATE
        ),
        learned_at_chapter_id=resolved_learned_at,
        source_type=resolved_source_type,
        source_id=resolved_source_id,
        source_chapter_id=resolved_source_chapter_id,
        quote_anchor=_normalize_text(quote_anchor, label="引用锚点", max_length=200),
        created_by=_normalize_text(created_by, label="创建者", max_length=100),
        confidence=_normalize_confidence(confidence),
        confirmation=resolved_confirmation,
    )
    return _to_character_belief_view(
        await narrative_repo.create_character_belief(session, belief)
    )


async def get_character_belief(
    session: AsyncSession, project_id: str, belief_id: str
) -> CharacterBeliefView:
    """获取单条人物信念。"""
    await _require_project(session, project_id)
    belief = await narrative_repo.get_character_belief(session, project_id, belief_id)
    if belief is None:
        raise NotFoundError(f"人物信念不存在: {belief_id}")
    return _to_character_belief_view(belief)


async def list_character_beliefs(
    session: AsyncSession,
    project_id: str,
    *,
    character_id: str | None = None,
    belief_state: str | None = None,
    confirmation: str | None = None,
    limit: int | None = None,
    offset: int | None = None,
) -> tuple[list[CharacterBeliefView], int]:
    """分页列出项目内的人物信念。"""
    await _require_project(session, project_id)
    resolved_character_id = (
        _normalize_optional_id(character_id, label="人物 ID")
        if character_id is not None
        else None
    )
    resolved_state = (
        _normalize_enum(belief_state, BELIEF_STATES, "信念状态")
        if belief_state is not None
        else None
    )
    resolved_confirmation = (
        _normalize_enum(confirmation, CONFIRMATION_STATES, "确认状态")
        if confirmation is not None
        else None
    )
    rows, total = await narrative_repo.list_character_beliefs(
        session,
        project_id,
        character_id=resolved_character_id,
        belief_state=resolved_state,
        confirmation=resolved_confirmation,
        limit=narrative_repo.clamp_limit(limit),
        offset=narrative_repo.clamp_offset(offset),
    )
    return [_to_character_belief_view(row) for row in rows], total


CHARACTER_BELIEF_UPDATE_KEYS = PROVENANCE_KEYS | frozenset(
    {
        "character_id",
        "proposition",
        "belief_state",
        "learned_at_chapter_id",
        "superseded_by_id",
        "invalidated_at",
        "confirmation",
    }
)


async def update_character_belief(
    session: AsyncSession,
    project_id: str,
    belief_id: str,
    *,
    changes: dict[str, Any],
) -> CharacterBeliefView:
    """常规更新人物信念；拒绝升级为已确认状态。

    `belief_state="mistaken"` 与 `confirmation="confirmed"` 可以共存：已确认的信念
    依然是人物信念，不因为它是错的就失效。
    """
    await _require_project(session, project_id)
    belief = await narrative_repo.get_character_belief(session, project_id, belief_id)
    if belief is None:
        raise NotFoundError(f"人物信念不存在: {belief_id}")
    _reject_unknown_keys(changes, CHARACTER_BELIEF_UPDATE_KEYS)
    _guard_update_confirmation(belief.confirmation, changes.get("confirmation"))

    if "character_id" in changes:
        resolved_character_id = _normalize_optional_id(
            changes["character_id"], label="人物 ID"
        )
        if resolved_character_id is None:
            raise ValidationError("人物信念必须指定 character_id")
        await _require_characters(session, project_id, [resolved_character_id], "关联人物")
    if "learned_at_chapter_id" in changes and changes["learned_at_chapter_id"] is not None:
        await _require_chapter(
            session,
            project_id,
            _normalize_optional_id(
                changes["learned_at_chapter_id"], label="得知章节 ID"
            )
            or "",
            "得知章节",
        )
    if "superseded_by_id" in changes and changes["superseded_by_id"] is not None:
        replacement_id = _normalize_optional_id(
            changes["superseded_by_id"], label="取代信念 ID"
        )
        if replacement_id == belief.id:
            raise ValidationError("信念不能取代自身")
        existing = await narrative_repo.existing_ids(
            session, CharacterBelief, project_id, [replacement_id or ""]
        )
        if replacement_id not in existing:
            raise ValidationError(f"取代信念不存在于当前项目: {replacement_id}")

    await _validate_provenance_source(
        session,
        project_id,
        source_type=changes.get("source_type", belief.source_type),
        source_id=changes["source_id"] if "source_id" in changes else belief.source_id,
        source_chapter_id=(
            changes["source_chapter_id"]
            if "source_chapter_id" in changes
            else belief.source_chapter_id
        ),
    )

    if "character_id" in changes:
        belief.character_id = _normalize_optional_id(
            changes["character_id"], label="人物 ID"
        ) or belief.character_id
    if "proposition" in changes:
        belief.proposition = _normalize_required_text(
            changes["proposition"], label="信念命题"
        )
    if "belief_state" in changes:
        belief.belief_state = _normalize_enum(
            changes["belief_state"], BELIEF_STATES, "信念状态"
        )
    if "learned_at_chapter_id" in changes:
        belief.learned_at_chapter_id = _normalize_optional_id(
            changes["learned_at_chapter_id"], label="得知章节 ID"
        )
    if "invalidated_at" in changes:
        invalidated_at = changes["invalidated_at"]
        belief.invalidated_at = (
            _as_utc(invalidated_at) if isinstance(invalidated_at, datetime) else None
        )
    if "superseded_by_id" in changes:
        replacement_id = _normalize_optional_id(
            changes["superseded_by_id"], label="取代信念 ID"
        )
        belief.superseded_by_id = replacement_id
        if replacement_id is not None and belief.invalidated_at is None:
            # 被取代的信念保留行，只做失效标记。
            belief.invalidated_at = datetime.now(UTC)
    if "confirmation" in changes:
        belief.confirmation = _normalize_enum(
            changes["confirmation"], CONFIRMATION_STATES, "确认状态"
        )

    _apply_provenance(
        belief,
        source_type=changes.get("source_type"),
        source_id=changes.get("source_id", ...),
        source_chapter_id=changes.get("source_chapter_id", ...),
        quote_anchor=changes.get("quote_anchor"),
        created_by=changes.get("created_by"),
        confidence=changes.get("confidence", ...),
    )
    return _to_character_belief_view(
        await narrative_repo.save_character_belief(session, belief)
    )


async def delete_character_belief(
    session: AsyncSession, project_id: str, belief_id: str
) -> None:
    """删除单条人物信念（显式操作；建议优先使用取代或失效）。"""
    await _require_project(session, project_id)
    belief = await narrative_repo.get_character_belief(session, project_id, belief_id)
    if belief is None:
        raise NotFoundError(f"人物信念不存在: {belief_id}")
    await narrative_repo.delete_character_belief(session, project_id, belief_id)


async def confirm_character_belief(
    session: AsyncSession,
    project_id: str,
    belief_id: str,
    *,
    expected_updated_at: datetime,
    confirmed_by: str | None = None,
) -> CharacterBeliefView:
    """人工确认人物信念；已确认的信念依然可以是错的。"""
    await _require_project(session, project_id)
    belief = await _confirm_row(
        session,
        project_id=project_id,
        item_id=belief_id,
        expected_updated_at=expected_updated_at,
        confirmed_by=confirmed_by,
        getter=narrative_repo.get_character_belief,
        label="人物信念",
    )
    return _to_character_belief_view(belief)


# --- 情节线 -----------------------------------------------------------------


def _to_plotline_view(plotline: Plotline) -> PlotlineView:
    return PlotlineView(
        id=plotline.id,
        project_id=plotline.project_id,
        title=plotline.title,
        description=plotline.description,
        current_question=plotline.current_question,
        payoff=plotline.payoff,
        state=plotline.state,
        introduced_chapter_id=plotline.introduced_chapter_id,
        advanced_chapter_id=plotline.advanced_chapter_id,
        related_character_ids=narrative_repo.load_str_list(
            plotline.related_character_ids_json
        ),
        related_outline_ids=narrative_repo.load_str_list(
            plotline.related_outline_ids_json
        ),
        provenance=_to_provenance(plotline),
        created_at=plotline.created_at,
        updated_at=plotline.updated_at,
    )


async def create_plotline(
    session: AsyncSession,
    project_id: str,
    *,
    title: Any,
    description: Any = None,
    current_question: Any = None,
    payoff: Any = None,
    state: Any = None,
    introduced_chapter_id: Any = None,
    advanced_chapter_id: Any = None,
    related_character_ids: Any = None,
    related_outline_ids: Any = None,
    source_type: Any = None,
    source_id: Any = None,
    source_chapter_id: Any = None,
    quote_anchor: Any = None,
    created_by: Any = None,
    confidence: Any = None,
    confirmation: Any = None,
) -> PlotlineView:
    """创建情节线。"""
    await _require_project(session, project_id)
    resolved_confirmation = _guard_create_confirmation(confirmation)
    resolved_introduced = _normalize_optional_id(
        introduced_chapter_id, label="引入章节 ID"
    )
    if resolved_introduced is not None:
        await _require_chapter(session, project_id, resolved_introduced, "引入章节")
    resolved_advanced = _normalize_optional_id(
        advanced_chapter_id, label="推进章节 ID"
    )
    if resolved_advanced is not None:
        await _require_chapter(session, project_id, resolved_advanced, "推进章节")

    resolved_characters = await _require_characters(
        session,
        project_id,
        _normalize_str_list(related_character_ids, label="关联人物"),
        "关联人物",
    )
    resolved_outlines = await _require_outlines(
        session,
        project_id,
        _normalize_str_list(related_outline_ids, label="关联大纲"),
        "关联大纲",
    )

    resolved_source_type = (
        _normalize_enum(source_type, SOURCE_TYPES, "溯源来源")
        if source_type is not None
        else DEFAULT_SOURCE_TYPE
    )
    resolved_source_id = _normalize_optional_id(source_id, label="溯源来源 ID")
    resolved_source_chapter_id = _normalize_optional_id(
        source_chapter_id, label="溯源章节 ID"
    )
    await _validate_provenance_source(
        session,
        project_id,
        source_type=resolved_source_type,
        source_id=resolved_source_id,
        source_chapter_id=resolved_source_chapter_id,
    )

    plotline = Plotline(
        project_id=project_id,
        title=_normalize_required_text(title, label="情节线标题"),
        description=_normalize_text(description, label="情节线描述"),
        current_question=_normalize_text(current_question, label="当前悬念"),
        payoff=_normalize_text(payoff, label="兑现方式"),
        state=(
            _normalize_enum(state, PLOTLINE_STATES, "情节线状态")
            if state is not None
            else DEFAULT_PLOTLINE_STATE
        ),
        introduced_chapter_id=resolved_introduced,
        advanced_chapter_id=resolved_advanced,
        related_character_ids_json=narrative_repo.dump_str_list(resolved_characters),
        related_outline_ids_json=narrative_repo.dump_str_list(resolved_outlines),
        source_type=resolved_source_type,
        source_id=resolved_source_id,
        source_chapter_id=resolved_source_chapter_id,
        quote_anchor=_normalize_text(quote_anchor, label="引用锚点", max_length=200),
        created_by=_normalize_text(created_by, label="创建者", max_length=100),
        confidence=_normalize_confidence(confidence),
        confirmation=resolved_confirmation,
    )
    return _to_plotline_view(await narrative_repo.create_plotline(session, plotline))


async def get_plotline(
    session: AsyncSession, project_id: str, plotline_id: str
) -> PlotlineView:
    """获取单条情节线。"""
    await _require_project(session, project_id)
    plotline = await narrative_repo.get_plotline(session, project_id, plotline_id)
    if plotline is None:
        raise NotFoundError(f"情节线不存在: {plotline_id}")
    return _to_plotline_view(plotline)


async def list_plotlines(
    session: AsyncSession,
    project_id: str,
    *,
    state: str | None = None,
    confirmation: str | None = None,
    limit: int | None = None,
    offset: int | None = None,
) -> tuple[list[PlotlineView], int]:
    """分页列出项目内的情节线。"""
    await _require_project(session, project_id)
    resolved_state = (
        _normalize_enum(state, PLOTLINE_STATES, "情节线状态") if state is not None else None
    )
    resolved_confirmation = (
        _normalize_enum(confirmation, CONFIRMATION_STATES, "确认状态")
        if confirmation is not None
        else None
    )
    rows, total = await narrative_repo.list_plotlines(
        session,
        project_id,
        state=resolved_state,
        confirmation=resolved_confirmation,
        limit=narrative_repo.clamp_limit(limit),
        offset=narrative_repo.clamp_offset(offset),
    )
    return [_to_plotline_view(row) for row in rows], total


PLOTLINE_UPDATE_KEYS = PROVENANCE_KEYS | frozenset(
    {
        "title",
        "description",
        "current_question",
        "payoff",
        "state",
        "introduced_chapter_id",
        "advanced_chapter_id",
        "related_character_ids",
        "related_outline_ids",
        "confirmation",
    }
)


async def update_plotline(
    session: AsyncSession,
    project_id: str,
    plotline_id: str,
    *,
    changes: dict[str, Any],
) -> PlotlineView:
    """常规更新情节线；拒绝升级为已确认状态。"""
    await _require_project(session, project_id)
    plotline = await narrative_repo.get_plotline(session, project_id, plotline_id)
    if plotline is None:
        raise NotFoundError(f"情节线不存在: {plotline_id}")
    _reject_unknown_keys(changes, PLOTLINE_UPDATE_KEYS)
    _guard_update_confirmation(plotline.confirmation, changes.get("confirmation"))

    for key, label in (
        ("introduced_chapter_id", "引入章节"),
        ("advanced_chapter_id", "推进章节"),
    ):
        if key in changes and changes[key] is not None:
            await _require_chapter(
                session,
                project_id,
                _normalize_optional_id(changes[key], label=f"{label} ID") or "",
                label,
            )
    resolved_characters: list[str] | None = None
    if "related_character_ids" in changes:
        resolved_characters = await _require_characters(
            session,
            project_id,
            _normalize_str_list(changes["related_character_ids"], label="关联人物"),
            "关联人物",
        )
    resolved_outlines: list[str] | None = None
    if "related_outline_ids" in changes:
        resolved_outlines = await _require_outlines(
            session,
            project_id,
            _normalize_str_list(changes["related_outline_ids"], label="关联大纲"),
            "关联大纲",
        )

    await _validate_provenance_source(
        session,
        project_id,
        source_type=changes.get("source_type", plotline.source_type),
        source_id=changes["source_id"] if "source_id" in changes else plotline.source_id,
        source_chapter_id=(
            changes["source_chapter_id"]
            if "source_chapter_id" in changes
            else plotline.source_chapter_id
        ),
    )

    if "title" in changes:
        plotline.title = _normalize_required_text(changes["title"], label="情节线标题")
    if "description" in changes:
        plotline.description = _normalize_text(changes["description"], label="情节线描述")
    if "current_question" in changes:
        plotline.current_question = _normalize_text(
            changes["current_question"], label="当前悬念"
        )
    if "payoff" in changes:
        plotline.payoff = _normalize_text(changes["payoff"], label="兑现方式")
    if "state" in changes:
        plotline.state = _normalize_enum(changes["state"], PLOTLINE_STATES, "情节线状态")
    if "introduced_chapter_id" in changes:
        plotline.introduced_chapter_id = _normalize_optional_id(
            changes["introduced_chapter_id"], label="引入章节 ID"
        )
    if "advanced_chapter_id" in changes:
        plotline.advanced_chapter_id = _normalize_optional_id(
            changes["advanced_chapter_id"], label="推进章节 ID"
        )
    if resolved_characters is not None:
        plotline.related_character_ids_json = narrative_repo.dump_str_list(
            resolved_characters
        )
    if resolved_outlines is not None:
        plotline.related_outline_ids_json = narrative_repo.dump_str_list(
            resolved_outlines
        )
    if "confirmation" in changes:
        plotline.confirmation = _normalize_enum(
            changes["confirmation"], CONFIRMATION_STATES, "确认状态"
        )

    _apply_provenance(
        plotline,
        source_type=changes.get("source_type"),
        source_id=changes.get("source_id", ...),
        source_chapter_id=changes.get("source_chapter_id", ...),
        quote_anchor=changes.get("quote_anchor"),
        created_by=changes.get("created_by"),
        confidence=changes.get("confidence", ...),
    )
    return _to_plotline_view(await narrative_repo.save_plotline(session, plotline))


async def delete_plotline(
    session: AsyncSession, project_id: str, plotline_id: str
) -> None:
    """删除单条情节线（显式操作）。"""
    await _require_project(session, project_id)
    plotline = await narrative_repo.get_plotline(session, project_id, plotline_id)
    if plotline is None:
        raise NotFoundError(f"情节线不存在: {plotline_id}")
    await narrative_repo.delete_plotline(session, project_id, plotline_id)


async def confirm_plotline(
    session: AsyncSession,
    project_id: str,
    plotline_id: str,
    *,
    expected_updated_at: datetime,
    confirmed_by: str | None = None,
) -> PlotlineView:
    """人工确认情节线。"""
    await _require_project(session, project_id)
    plotline = await _confirm_row(
        session,
        project_id=project_id,
        item_id=plotline_id,
        expected_updated_at=expected_updated_at,
        confirmed_by=confirmed_by,
        getter=narrative_repo.get_plotline,
        label="情节线",
    )
    return _to_plotline_view(plotline)


# --- 场景计划 ---------------------------------------------------------------


def _to_scene_plan_view(plan: ScenePlan) -> ScenePlanView:
    return ScenePlanView(
        id=plan.id,
        project_id=plan.project_id,
        chapter_id=plan.chapter_id,
        scene_index=plan.scene_index,
        goal=plan.goal,
        pov_character_id=plan.pov_character_id,
        location=plan.location,
        tone=plan.tone,
        preconditions=narrative_repo.load_str_list(plan.preconditions_json),
        participants=narrative_repo.load_str_list(plan.participants_json),
        character_goals=narrative_repo.load_character_goals(plan.character_goals_json),
        known_information=narrative_repo.load_str_list(plan.known_information_json),
        hidden_information=narrative_repo.load_str_list(plan.hidden_information_json),
        active_plotline_ids=narrative_repo.load_str_list(plan.active_plotline_ids_json),
        world_constraints=narrative_repo.load_str_list(plan.world_constraints_json),
        expected_changes=narrative_repo.load_str_list(plan.expected_changes_json),
        result=narrative_repo.load_scene_result(plan.result_json),
        provenance=_to_provenance(plan),
        created_at=plan.created_at,
        updated_at=plan.updated_at,
    )


async def _validate_scene_references(
    session: AsyncSession,
    project_id: str,
    *,
    pov_character_id: str | None,
    participants: list[str],
    character_goals: list[dict[str, str]],
    active_plotline_ids: list[str],
) -> None:
    """校验场景内引用的全部实体归属。"""
    character_ids = list(participants)
    if pov_character_id:
        character_ids.append(pov_character_id)
    character_ids.extend(goal["character_id"] for goal in character_goals)
    await _require_characters(session, project_id, character_ids, "场景关联人物")
    await _require_plotlines(
        session, project_id, active_plotline_ids, "场景关联情节线"
    )


def _normalize_scene_index(value: Any) -> int:
    if value is None:
        return 0
    try:
        index = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"场景序号必须是整数: {value}") from exc
    if index < 0:
        raise ValidationError("场景序号不能为负数")
    return index


async def create_scene_plan(
    session: AsyncSession,
    project_id: str,
    *,
    chapter_id: Any,
    scene_index: Any = None,
    goal: Any = None,
    pov_character_id: Any = None,
    location: Any = None,
    tone: Any = None,
    preconditions: Any = None,
    participants: Any = None,
    character_goals: Any = None,
    known_information: Any = None,
    hidden_information: Any = None,
    active_plotline_ids: Any = None,
    world_constraints: Any = None,
    expected_changes: Any = None,
    result: Any = None,
    source_type: Any = None,
    source_id: Any = None,
    source_chapter_id: Any = None,
    quote_anchor: Any = None,
    created_by: Any = None,
    confidence: Any = None,
    confirmation: Any = None,
) -> ScenePlanView:
    """创建场景计划；`(chapter_id, scene_index)` 在项目内唯一。"""
    await _require_project(session, project_id)
    resolved_confirmation = _guard_create_confirmation(confirmation)
    resolved_chapter_id = _normalize_optional_id(chapter_id, label="章节 ID")
    if resolved_chapter_id is None:
        raise ValidationError("场景计划必须指定 chapter_id")
    await _require_chapter(session, project_id, resolved_chapter_id, "所属章节")
    resolved_scene_index = _normalize_scene_index(scene_index)

    resolved_pov = _normalize_optional_id(pov_character_id, label="视角人物 ID")
    resolved_participants = _normalize_str_list(participants, label="参与者")
    resolved_goals = _normalize_character_goals(character_goals)
    resolved_plotlines = _normalize_str_list(
        active_plotline_ids, label="关联情节线"
    )
    await _validate_scene_references(
        session,
        project_id,
        pov_character_id=resolved_pov,
        participants=resolved_participants,
        character_goals=resolved_goals,
        active_plotline_ids=resolved_plotlines,
    )

    duplicate = await narrative_repo.find_scene_plan_by_index(
        session, project_id, resolved_chapter_id, resolved_scene_index
    )
    if duplicate is not None:
        raise ConflictError(
            f"该章节已存在序号为 {resolved_scene_index} 的场景计划"
        )

    resolved_source_type = (
        _normalize_enum(source_type, SOURCE_TYPES, "溯源来源")
        if source_type is not None
        else DEFAULT_SOURCE_TYPE
    )
    resolved_source_id = _normalize_optional_id(source_id, label="溯源来源 ID")
    resolved_source_chapter_id = _normalize_optional_id(
        source_chapter_id, label="溯源章节 ID"
    )
    await _validate_provenance_source(
        session,
        project_id,
        source_type=resolved_source_type,
        source_id=resolved_source_id,
        source_chapter_id=resolved_source_chapter_id,
    )

    plan = ScenePlan(
        project_id=project_id,
        chapter_id=resolved_chapter_id,
        scene_index=resolved_scene_index,
        goal=_normalize_text(goal, label="场景目标"),
        pov_character_id=resolved_pov,
        location=_normalize_text(location, label="场景地点", max_length=200),
        tone=_normalize_text(tone, label="场景基调", max_length=100),
        preconditions_json=narrative_repo.dump_str_list(
            _normalize_str_list(preconditions, label="前置条件")
        ),
        participants_json=narrative_repo.dump_str_list(resolved_participants),
        character_goals_json=narrative_repo.dump_character_goals(resolved_goals),
        known_information_json=narrative_repo.dump_str_list(
            _normalize_str_list(known_information, label="已知信息")
        ),
        hidden_information_json=narrative_repo.dump_str_list(
            _normalize_str_list(hidden_information, label="隐藏信息")
        ),
        active_plotline_ids_json=narrative_repo.dump_str_list(resolved_plotlines),
        world_constraints_json=narrative_repo.dump_str_list(
            _normalize_str_list(world_constraints, label="世界约束")
        ),
        expected_changes_json=narrative_repo.dump_str_list(
            _normalize_str_list(expected_changes, label="预期变化")
        ),
        result_json=narrative_repo.dump_scene_result(
            _normalize_scene_result(result)
        ),
        source_type=resolved_source_type,
        source_id=resolved_source_id,
        source_chapter_id=resolved_source_chapter_id,
        quote_anchor=_normalize_text(quote_anchor, label="引用锚点", max_length=200),
        created_by=_normalize_text(created_by, label="创建者", max_length=100),
        confidence=_normalize_confidence(confidence),
        confirmation=resolved_confirmation,
    )
    return _to_scene_plan_view(await narrative_repo.create_scene_plan(session, plan))


async def get_scene_plan(
    session: AsyncSession, project_id: str, plan_id: str
) -> ScenePlanView:
    """获取单个场景计划。"""
    await _require_project(session, project_id)
    plan = await narrative_repo.get_scene_plan(session, project_id, plan_id)
    if plan is None:
        raise NotFoundError(f"场景计划不存在: {plan_id}")
    return _to_scene_plan_view(plan)


async def list_scene_plans(
    session: AsyncSession,
    project_id: str,
    *,
    chapter_id: str | None = None,
    confirmation: str | None = None,
    limit: int | None = None,
    offset: int | None = None,
) -> tuple[list[ScenePlanView], int]:
    """分页列出项目内的场景计划。"""
    await _require_project(session, project_id)
    resolved_confirmation = (
        _normalize_enum(confirmation, CONFIRMATION_STATES, "确认状态")
        if confirmation is not None
        else None
    )
    rows, total = await narrative_repo.list_scene_plans(
        session,
        project_id,
        chapter_id=_normalize_optional_id(chapter_id, label="章节 ID"),
        confirmation=resolved_confirmation,
        limit=narrative_repo.clamp_limit(limit),
        offset=narrative_repo.clamp_offset(offset),
    )
    return [_to_scene_plan_view(row) for row in rows], total


SCENE_PLAN_UPDATE_KEYS = PROVENANCE_KEYS | frozenset(
    {
        "scene_index",
        "goal",
        "pov_character_id",
        "location",
        "tone",
        "preconditions",
        "participants",
        "character_goals",
        "known_information",
        "hidden_information",
        "active_plotline_ids",
        "world_constraints",
        "expected_changes",
        "result",
        "confirmation",
    }
)


async def update_scene_plan(
    session: AsyncSession,
    project_id: str,
    plan_id: str,
    *,
    changes: dict[str, Any],
) -> ScenePlanView:
    """常规更新场景计划；拒绝升级为已确认状态。

    章节归属不可更改：要换章节请新建场景计划，避免误改已有章节的排期。
    """
    await _require_project(session, project_id)
    plan = await narrative_repo.get_scene_plan(session, project_id, plan_id)
    if plan is None:
        raise NotFoundError(f"场景计划不存在: {plan_id}")
    _reject_unknown_keys(changes, SCENE_PLAN_UPDATE_KEYS)
    _guard_update_confirmation(plan.confirmation, changes.get("confirmation"))

    resolved_scene_index = plan.scene_index
    if "scene_index" in changes:
        resolved_scene_index = _normalize_scene_index(changes["scene_index"])
        if resolved_scene_index != plan.scene_index:
            duplicate = await narrative_repo.find_scene_plan_by_index(
                session, project_id, plan.chapter_id, resolved_scene_index
            )
            if duplicate is not None and duplicate.id != plan.id:
                raise ConflictError(
                    f"该章节已存在序号为 {resolved_scene_index} 的场景计划"
                )

    resolved_pov = plan.pov_character_id
    if "pov_character_id" in changes:
        resolved_pov = _normalize_optional_id(
            changes["pov_character_id"], label="视角人物 ID"
        )
    resolved_participants = narrative_repo.load_str_list(plan.participants_json)
    if "participants" in changes:
        resolved_participants = _normalize_str_list(
            changes["participants"], label="参与者"
        )
    resolved_goals = narrative_repo.load_character_goals(plan.character_goals_json)
    if "character_goals" in changes:
        resolved_goals = _normalize_character_goals(changes["character_goals"])
    resolved_plotlines = narrative_repo.load_str_list(plan.active_plotline_ids_json)
    if "active_plotline_ids" in changes:
        resolved_plotlines = _normalize_str_list(
            changes["active_plotline_ids"], label="关联情节线"
        )
    if (
        "pov_character_id" in changes
        or "participants" in changes
        or "character_goals" in changes
        or "active_plotline_ids" in changes
    ):
        await _validate_scene_references(
            session,
            project_id,
            pov_character_id=resolved_pov,
            participants=resolved_participants,
            character_goals=resolved_goals,
            active_plotline_ids=resolved_plotlines,
        )

    await _validate_provenance_source(
        session,
        project_id,
        source_type=changes.get("source_type", plan.source_type),
        source_id=changes["source_id"] if "source_id" in changes else plan.source_id,
        source_chapter_id=(
            changes["source_chapter_id"]
            if "source_chapter_id" in changes
            else plan.source_chapter_id
        ),
    )

    plan.scene_index = resolved_scene_index
    plan.pov_character_id = resolved_pov
    plan.participants_json = narrative_repo.dump_str_list(resolved_participants)
    plan.character_goals_json = narrative_repo.dump_character_goals(resolved_goals)
    plan.active_plotline_ids_json = narrative_repo.dump_str_list(resolved_plotlines)

    if "goal" in changes:
        plan.goal = _normalize_text(changes["goal"], label="场景目标")
    if "location" in changes:
        plan.location = _normalize_text(
            changes["location"], label="场景地点", max_length=200
        )
    if "tone" in changes:
        plan.tone = _normalize_text(changes["tone"], label="场景基调", max_length=100)
    if "preconditions" in changes:
        plan.preconditions_json = narrative_repo.dump_str_list(
            _normalize_str_list(changes["preconditions"], label="前置条件")
        )
    if "known_information" in changes:
        plan.known_information_json = narrative_repo.dump_str_list(
            _normalize_str_list(changes["known_information"], label="已知信息")
        )
    if "hidden_information" in changes:
        plan.hidden_information_json = narrative_repo.dump_str_list(
            _normalize_str_list(changes["hidden_information"], label="隐藏信息")
        )
    if "world_constraints" in changes:
        plan.world_constraints_json = narrative_repo.dump_str_list(
            _normalize_str_list(changes["world_constraints"], label="世界约束")
        )
    if "expected_changes" in changes:
        plan.expected_changes_json = narrative_repo.dump_str_list(
            _normalize_str_list(changes["expected_changes"], label="预期变化")
        )
    if "result" in changes:
        plan.result_json = narrative_repo.dump_scene_result(
            _normalize_scene_result(changes["result"])
        )
    if "confirmation" in changes:
        plan.confirmation = _normalize_enum(
            changes["confirmation"], CONFIRMATION_STATES, "确认状态"
        )

    _apply_provenance(
        plan,
        source_type=changes.get("source_type"),
        source_id=changes.get("source_id", ...),
        source_chapter_id=changes.get("source_chapter_id", ...),
        quote_anchor=changes.get("quote_anchor"),
        created_by=changes.get("created_by"),
        confidence=changes.get("confidence", ...),
    )
    return _to_scene_plan_view(await narrative_repo.save_scene_plan(session, plan))


async def delete_scene_plan(session: AsyncSession, project_id: str, plan_id: str) -> None:
    """删除单个场景计划（显式操作）。"""
    await _require_project(session, project_id)
    plan = await narrative_repo.get_scene_plan(session, project_id, plan_id)
    if plan is None:
        raise NotFoundError(f"场景计划不存在: {plan_id}")
    await narrative_repo.delete_scene_plan(session, project_id, plan_id)


async def confirm_scene_plan(
    session: AsyncSession,
    project_id: str,
    plan_id: str,
    *,
    expected_updated_at: datetime,
    confirmed_by: str | None = None,
) -> ScenePlanView:
    """人工确认场景计划。"""
    await _require_project(session, project_id)
    plan = await _confirm_row(
        session,
        project_id=project_id,
        item_id=plan_id,
        expected_updated_at=expected_updated_at,
        confirmed_by=confirmed_by,
        getter=narrative_repo.get_scene_plan,
        label="场景计划",
    )
    return _to_scene_plan_view(plan)


# --- 章节 / 人物级清理 -------------------------------------------------------


async def delete_chapter_narrative_data(
    session: AsyncSession, project_id: str, chapter_ids: list[str]
) -> None:
    """章节删除时的叙事状态级联。

    必需章节引用（场景计划）随章节删除；可选章节引用（信念的得知章节、情节线的
    引入 / 推进章节、四张表的溯源来源章节）置空，行本身保留。调用方必须在章节
    父行删除之前执行。
    """
    await narrative_repo.delete_by_chapter_ids(session, project_id, chapter_ids)
    await narrative_repo.clear_chapter_links(session, project_id, chapter_ids)


async def delete_character_narrative_data(
    session: AsyncSession, project_id: str, character_ids: list[str]
) -> None:
    """人物删除时的叙事状态级联。

    必需人物引用（人物信念）随人物删除；可选人物引用（场景计划的视角人物与
    参与者 / 人物目标、情节线的关联人物）解除，行本身保留。调用方必须在人物
    父行删除之前执行。
    """
    await narrative_repo.delete_by_character_ids(session, project_id, character_ids)
    await narrative_repo.remove_character_links(session, project_id, character_ids)


# --- 项目级清理 -------------------------------------------------------------


async def delete_project_narrative_data(
    session: AsyncSession, project_id: str
) -> None:
    """删除项目内全部叙事状态（项目删除时调用）。"""
    await narrative_repo.delete_by_project(session, project_id)
