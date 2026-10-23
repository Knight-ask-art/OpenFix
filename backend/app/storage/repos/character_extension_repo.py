# -*- coding: utf-8 -*-
"""Character Extension Repository - 人物扩展字段与动态状态数据访问层。"""

from datetime import UTC, datetime

from sqlalchemy import and_, delete as sql_delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.core.character_state_context import StateAtAnchor
from app.storage.models.character import Character
from app.storage.models.character_profile import CharacterProfile
from app.storage.models.character_state import CharacterState
from app.storage.models.chapter import Chapter
from app.storage.models.volume import Volume

PROFILE_TEXT_FIELDS: tuple[str, ...] = (
    "alias",
    "age",
    "gender",
    "identity",
    "faction",
    "personality",
    "appearance",
    "background",
    "goal",
    "motivation",
    "fear",
    "secret",
    "abilities",
    "weakness",
    "arc",
)

STATE_TEXT_FIELDS: tuple[str, ...] = (
    "location",
    "physical_state",
    "mental_state",
    "goal",
    "relationship_note",
    "notes",
)


async def get_profile(session: AsyncSession, character_id: str) -> CharacterProfile | None:
    """按角色 ID 获取扩展字段。"""
    result = await session.execute(
        select(CharacterProfile).where(col(CharacterProfile.character_id) == character_id)
    )
    return result.scalar_one_or_none()


async def get_profiles_by_character_ids(
    session: AsyncSession, character_ids: list[str]
) -> dict[str, CharacterProfile]:
    """批量读取 Story Memory 用到的人物扩展字段。"""
    if not character_ids:
        return {}
    result = await session.execute(
        select(CharacterProfile).where(
            col(CharacterProfile.character_id).in_(character_ids)
        )
    )
    return {profile.character_id: profile for profile in result.scalars().all()}


async def upsert_profile(
    session: AsyncSession,
    character_id: str,
    values: dict[str, str],
) -> CharacterProfile:
    """按角色 ID 创建或更新扩展字段。"""
    profile = await get_profile(session, character_id)
    if profile is None:
        profile = CharacterProfile(character_id=character_id)
    for field in PROFILE_TEXT_FIELDS:
        if field in values:
            setattr(profile, field, values[field])
    profile.updated_at = datetime.now(UTC)
    session.add(profile)
    await session.flush()
    await session.refresh(profile)
    return profile


async def delete_profile(session: AsyncSession, character_id: str) -> None:
    """删除角色的扩展字段。"""
    await session.execute(
        sql_delete(CharacterProfile).where(col(CharacterProfile.character_id) == character_id)
    )
    await session.flush()


async def delete_profiles_by_project(session: AsyncSession, project_id: str) -> None:
    """删除项目内全部角色的扩展字段。"""
    character_ids = select(col(Character.id)).where(col(Character.project_id) == project_id)
    await session.execute(
        sql_delete(CharacterProfile).where(
            col(CharacterProfile.character_id).in_(character_ids)
        )
    )
    await session.flush()


async def list_states(session: AsyncSession, character_id: str) -> list[CharacterState]:
    """列出角色的全部动态状态（按更新时间倒序）。"""
    result = await session.execute(
        select(CharacterState)
        .where(col(CharacterState.character_id) == character_id)
        .order_by(col(CharacterState.updated_at).desc())
    )
    return list(result.scalars().all())


async def get_state(
    session: AsyncSession,
    character_id: str,
    chapter_id: str | None,
) -> CharacterState | None:
    """获取角色在指定章节（None 表示项目级）的状态记录。"""
    statement = select(CharacterState).where(col(CharacterState.character_id) == character_id)
    if chapter_id is None:
        statement = statement.where(col(CharacterState.chapter_id).is_(None))
    else:
        statement = statement.where(col(CharacterState.chapter_id) == chapter_id)
    result = await session.execute(statement.order_by(col(CharacterState.updated_at).desc()))
    return result.scalars().first()


async def get_latest_state_at_anchor(
    session: AsyncSession,
    *,
    project_id: str,
    character_id: str,
    volume_order: int,
    chapter_order: int,
) -> StateAtAnchor | None:
    """读取角色在锚点及之前最近保存的章级状态，并返回其真实来源章节/卷。

    阅读顺序是 ``(Volume.order, Chapter.order)``：章节 order 只在卷内唯一，
    必须与卷 order 一起比较。这里使用真正的字典序比较而不是乘以固定基数
    的魔术数，因为章节 order 没有上限，``order * 1_000_000 + chapter`` 会把
    未来卷误判为锚点之前。同一锚点恰好有本章记录时它最新；否则取之前最近
    的一条。角色、状态、章节、卷都必须属于同一项目；锚点之后、未来卷或
    项目级（``chapter_id IS NULL``）记录一律不参与，绝不回退到常设状态。
    """
    statement = (
        select(CharacterState, Chapter, Volume)
        .join(Character, col(CharacterState.character_id) == col(Character.id))
        .join(Chapter, col(CharacterState.chapter_id) == col(Chapter.id))
        .join(Volume, col(Chapter.volume_id) == col(Volume.id))
        .where(
            col(Character.project_id) == project_id,
            col(CharacterState.project_id) == project_id,
            col(CharacterState.character_id) == character_id,
            col(CharacterState.chapter_id).is_not(None),
            col(Chapter.project_id) == project_id,
            col(Volume.project_id) == project_id,
            or_(
                col(Volume.order) < volume_order,
                and_(
                    col(Volume.order) == volume_order,
                    col(Chapter.order) <= chapter_order,
                ),
            ),
        )
        .order_by(
            col(Volume.order).desc(),
            col(Chapter.order).desc(),
            col(CharacterState.updated_at).desc(),
        )
        .limit(1)
    )
    row = (await session.execute(statement)).first()
    if row is None:
        return None
    state, chapter, volume = row
    return StateAtAnchor(
        state=state,
        chapter_id=chapter.id,
        chapter_title=chapter.title,
        chapter_order=chapter.order,
        volume_id=volume.id,
        volume_title=volume.title,
        volume_order=volume.order,
    )


async def upsert_state(
    session: AsyncSession,
    character_id: str,
    project_id: str,
    chapter_id: str | None,
    values: dict[str, str],
) -> CharacterState:
    """按角色 + 章节创建或更新状态记录。"""
    state = await get_state(session, character_id, chapter_id)
    if state is None:
        state = CharacterState(
            character_id=character_id,
            project_id=project_id,
            chapter_id=chapter_id,
        )
    for field in STATE_TEXT_FIELDS:
        if field in values:
            setattr(state, field, values[field])
    state.updated_at = datetime.now(UTC)
    session.add(state)
    await session.flush()
    await session.refresh(state)
    return state


async def get_state_by_id(session: AsyncSession, state_id: str) -> CharacterState | None:
    """按状态 ID 获取记录。"""
    result = await session.execute(
        select(CharacterState).where(col(CharacterState.id) == state_id)
    )
    return result.scalar_one_or_none()


async def delete_state(session: AsyncSession, state: CharacterState) -> None:
    """删除单条状态记录。"""
    await session.delete(state)
    await session.flush()


async def delete_states_for_character(session: AsyncSession, character_id: str) -> None:
    """删除角色的全部状态记录。"""
    await session.execute(
        sql_delete(CharacterState).where(col(CharacterState.character_id) == character_id)
    )
    await session.flush()


async def delete_states_by_project(session: AsyncSession, project_id: str) -> None:
    """删除项目内全部角色状态记录。"""
    await session.execute(
        sql_delete(CharacterState).where(col(CharacterState.project_id) == project_id)
    )
    await session.flush()


async def delete_states_for_chapters(
    session: AsyncSession, chapter_ids: list[str]
) -> None:
    """删除被删除章节上的角色状态记录。"""
    if not chapter_ids:
        return
    await session.execute(
        sql_delete(CharacterState).where(col(CharacterState.chapter_id).in_(chapter_ids))
    )
    await session.flush()


async def get_latest_project_state(
    session: AsyncSession, character_id: str
) -> CharacterState | None:
    """获取角色最新的项目级状态（chapter_id 为空）。"""
    return await get_state(session, character_id, None)


async def get_latest_project_states_by_character_ids(
    session: AsyncSession, character_ids: list[str]
) -> dict[str, CharacterState]:
    """批量读取每个角色最新的项目级状态。"""
    if not character_ids:
        return {}
    result = await session.execute(
        select(CharacterState)
        .where(
            col(CharacterState.character_id).in_(character_ids),
            col(CharacterState.chapter_id).is_(None),
        )
        .order_by(col(CharacterState.updated_at).desc())
    )
    latest: dict[str, CharacterState] = {}
    for state in result.scalars().all():
        latest.setdefault(state.character_id, state)
    return latest


async def list_states_by_chapter(
    session: AsyncSession, chapter_id: str
) -> list[CharacterState]:
    """列出绑定到指定章节的全部角色状态（回滚快照用）。"""
    result = await session.execute(
        select(CharacterState)
        .where(col(CharacterState.chapter_id) == chapter_id)
        .order_by(col(CharacterState.created_at).asc())
    )
    return list(result.scalars().all())


async def replace_states(
    session: AsyncSession,
    rows: list[dict[str, object]],
    *,
    character_id: str | None = None,
    chapter_id: str | None = None,
) -> None:
    """用给定行替换某个角色 / 某个章节上的全部状态记录（回滚恢复用）。

    调用方要么给 ``character_id``（替换该角色的全部状态），要么给
    ``chapter_id``（替换绑定该章节的全部状态），两者不同时使用。
    """
    if (character_id is None) == (chapter_id is None):
        raise ValueError("replace_states 需要且仅需要一个范围参数")
    if character_id is not None:
        await delete_states_for_character(session, character_id)
    else:
        assert chapter_id is not None
        await delete_states_for_chapters(session, [chapter_id])
    for row in rows:
        session.add(CharacterState.model_validate(row))
    await session.flush()
