# -*- coding: utf-8 -*-
"""Narrative Router - 叙事状态 API（世界事实 / 人物信念 / 情节线 / 场景计划）。

所有路由都以项目为作用域：`/projects/{project_id}/narrative/...`。列表接口强制分页
并支持按状态过滤，不存在跨项目或整书扫描的读取路径。

确认（candidate -> confirmed）只能通过各资源的 `/confirm` 接口完成，且必须携带读取时
的 `updated_at`；常规创建与更新只能产生候选 / 推断 / 已拒绝状态。
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.narrative import (
    BeliefState,
    CharacterBeliefCreateRequest,
    CharacterBeliefListResponse,
    CharacterBeliefResponse,
    CharacterBeliefUpdateRequest,
    ConfirmationState,
    NarrativeConfirmRequest,
    PlotlineCreateRequest,
    PlotlineListResponse,
    PlotlineResponse,
    PlotlineState,
    PlotlineUpdateRequest,
    ScenePlanCreateRequest,
    SceneCharacterGoal,
    ScenePlanListResponse,
    ScenePlanResponse,
    ScenePlanUpdateRequest,
    SceneResultPayload,
    WorldFactCreateRequest,
    WorldFactListResponse,
    WorldFactResponse,
    WorldFactStatus,
    WorldFactUpdateRequest,
)
from app.core.errors import ValidationError
from app.storage.database import get_session
from app.storage.services import narrative_service
from app.storage.services.narrative_service import (
    CharacterBeliefView,
    PlotlineView,
    ScenePlanView,
    WorldFactView,
)

router = APIRouter(tags=["narrative"])


@contextmanager
def _domain_errors() -> Iterator[None]:
    """把领域校验错误翻译为 400；404 / 409 由全局处理器负责。"""
    try:
        yield
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc


def to_world_fact_response(view: WorldFactView) -> WorldFactResponse:
    """转换世界事实响应。"""
    return WorldFactResponse(
        id=view.id,
        project_id=view.project_id,
        statement=view.statement,
        subject_ref=view.subject_ref,
        status=cast(WorldFactStatus, view.status),
        superseded_by_id=view.superseded_by_id,
        created_at=view.created_at,
        updated_at=view.updated_at,
        **vars(view.provenance),
    )


def to_character_belief_response(view: CharacterBeliefView) -> CharacterBeliefResponse:
    """转换人物信念响应。"""
    return CharacterBeliefResponse(
        id=view.id,
        project_id=view.project_id,
        character_id=view.character_id,
        proposition=view.proposition,
        belief_state=cast(BeliefState, view.belief_state),
        learned_at_chapter_id=view.learned_at_chapter_id,
        superseded_by_id=view.superseded_by_id,
        invalidated_at=view.invalidated_at,
        created_at=view.created_at,
        updated_at=view.updated_at,
        **vars(view.provenance),
    )


def to_plotline_response(view: PlotlineView) -> PlotlineResponse:
    """转换情节线响应。"""
    return PlotlineResponse(
        id=view.id,
        project_id=view.project_id,
        title=view.title,
        description=view.description,
        current_question=view.current_question,
        payoff=view.payoff,
        state=cast(PlotlineState, view.state),
        introduced_chapter_id=view.introduced_chapter_id,
        advanced_chapter_id=view.advanced_chapter_id,
        related_character_ids=view.related_character_ids,
        related_outline_ids=view.related_outline_ids,
        created_at=view.created_at,
        updated_at=view.updated_at,
        **vars(view.provenance),
    )


def to_scene_plan_response(view: ScenePlanView) -> ScenePlanResponse:
    """转换场景计划响应。"""
    return ScenePlanResponse(
        id=view.id,
        project_id=view.project_id,
        chapter_id=view.chapter_id,
        scene_index=view.scene_index,
        goal=view.goal,
        pov_character_id=view.pov_character_id,
        location=view.location,
        tone=view.tone,
        preconditions=view.preconditions,
        participants=view.participants,
        character_goals=[SceneCharacterGoal.model_validate(goal) for goal in view.character_goals],
        known_information=view.known_information,
        hidden_information=view.hidden_information,
        active_plotline_ids=view.active_plotline_ids,
        world_constraints=view.world_constraints,
        expected_changes=view.expected_changes,
        result=SceneResultPayload.model_validate(view.result),
        created_at=view.created_at,
        updated_at=view.updated_at,
        **vars(view.provenance),
    )


# --- 世界事实 ---------------------------------------------------------------


@router.get(
    "/projects/{project_id}/narrative/world-facts",
    response_model=WorldFactListResponse,
    summary="列出世界事实",
)
async def list_world_facts(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    fact_status: Annotated[WorldFactStatus | None, Query(alias="status")] = None,
    confirmation: Annotated[ConfirmationState | None, Query()] = None,
    limit: Annotated[int | None, Query(ge=1)] = None,
    offset: Annotated[int | None, Query(ge=0)] = None,
) -> WorldFactListResponse:
    """分页列出项目内的世界事实。"""
    with _domain_errors():
        views, total = await narrative_service.list_world_facts(
            session,
            project_id,
            status=fact_status,
            confirmation=confirmation,
            limit=limit,
            offset=offset,
        )
    resolved_limit, resolved_offset = narrative_service.resolve_page(limit, offset)
    return WorldFactListResponse(
        items=[to_world_fact_response(view) for view in views],
        total=total,
        limit=resolved_limit,
        offset=resolved_offset,
    )


@router.post(
    "/projects/{project_id}/narrative/world-facts",
    response_model=WorldFactResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建世界事实",
)
async def create_world_fact(
    project_id: str,
    data: WorldFactCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorldFactResponse:
    """创建世界事实；默认只能产生候选或推断。"""
    with _domain_errors():
        view = await narrative_service.create_world_fact(
            session,
            project_id,
            statement=data.statement,
            subject_ref=data.subject_ref,
            status=data.status,
            source_type=data.source_type,
            source_id=data.source_id,
            source_chapter_id=data.source_chapter_id,
            quote_anchor=data.quote_anchor,
            created_by=data.created_by,
            confidence=data.confidence,
            confirmation=data.confirmation,
        )
    return to_world_fact_response(view)


@router.get(
    "/projects/{project_id}/narrative/world-facts/{fact_id}",
    response_model=WorldFactResponse,
    summary="获取世界事实",
)
async def get_world_fact(
    project_id: str,
    fact_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorldFactResponse:
    """获取单条世界事实。"""
    view = await narrative_service.get_world_fact(session, project_id, fact_id)
    return to_world_fact_response(view)


@router.patch(
    "/projects/{project_id}/narrative/world-facts/{fact_id}",
    response_model=WorldFactResponse,
    summary="更新世界事实",
)
async def update_world_fact(
    project_id: str,
    fact_id: str,
    data: WorldFactUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorldFactResponse:
    """更新世界事实；拒绝通过常规更新升级为已确认状态。"""
    with _domain_errors():
        view = await narrative_service.update_world_fact(
            session, project_id, fact_id, changes=data.model_dump(exclude_unset=True)
        )
    return to_world_fact_response(view)


@router.delete(
    "/projects/{project_id}/narrative/world-facts/{fact_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除世界事实",
)
async def delete_world_fact(
    project_id: str,
    fact_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """删除单条世界事实（显式操作；优先使用取代或 retired 状态）。"""
    with _domain_errors():
        await narrative_service.delete_world_fact(session, project_id, fact_id)


@router.post(
    "/projects/{project_id}/narrative/world-facts/{fact_id}/confirm",
    response_model=WorldFactResponse,
    summary="确认世界事实",
)
async def confirm_world_fact(
    project_id: str,
    fact_id: str,
    data: NarrativeConfirmRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> WorldFactResponse:
    """人工确认世界事实；expected_updated_at 过期时返回 409。"""
    with _domain_errors():
        view = await narrative_service.confirm_world_fact(
            session,
            project_id,
            fact_id,
            expected_updated_at=data.expected_updated_at,
            confirmed_by=data.confirmed_by,
        )
    return to_world_fact_response(view)


# --- 人物信念 ---------------------------------------------------------------


@router.get(
    "/projects/{project_id}/narrative/character-beliefs",
    response_model=CharacterBeliefListResponse,
    summary="列出人物信念",
)
async def list_character_beliefs(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    character_id: Annotated[str | None, Query()] = None,
    belief_state: Annotated[str | None, Query()] = None,
    confirmation: Annotated[ConfirmationState | None, Query()] = None,
    limit: Annotated[int | None, Query(ge=1)] = None,
    offset: Annotated[int | None, Query(ge=0)] = None,
) -> CharacterBeliefListResponse:
    """分页列出项目内的人物信念。"""
    with _domain_errors():
        views, total = await narrative_service.list_character_beliefs(
            session,
            project_id,
            character_id=character_id,
            belief_state=belief_state,
            confirmation=confirmation,
            limit=limit,
            offset=offset,
        )
    resolved_limit, resolved_offset = narrative_service.resolve_page(limit, offset)
    return CharacterBeliefListResponse(
        items=[to_character_belief_response(view) for view in views],
        total=total,
        limit=resolved_limit,
        offset=resolved_offset,
    )


@router.post(
    "/projects/{project_id}/narrative/character-beliefs",
    response_model=CharacterBeliefResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建人物信念",
)
async def create_character_belief(
    project_id: str,
    data: CharacterBeliefCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CharacterBeliefResponse:
    """创建人物信念；事实与信念分开存储，不会互相转换。"""
    with _domain_errors():
        view = await narrative_service.create_character_belief(
            session,
            project_id,
            character_id=data.character_id,
            proposition=data.proposition,
            belief_state=data.belief_state,
            learned_at_chapter_id=data.learned_at_chapter_id,
            source_type=data.source_type,
            source_id=data.source_id,
            source_chapter_id=data.source_chapter_id,
            quote_anchor=data.quote_anchor,
            created_by=data.created_by,
            confidence=data.confidence,
            confirmation=data.confirmation,
        )
    return to_character_belief_response(view)


@router.get(
    "/projects/{project_id}/narrative/character-beliefs/{belief_id}",
    response_model=CharacterBeliefResponse,
    summary="获取人物信念",
)
async def get_character_belief(
    project_id: str,
    belief_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CharacterBeliefResponse:
    """获取单条人物信念。"""
    view = await narrative_service.get_character_belief(session, project_id, belief_id)
    return to_character_belief_response(view)


@router.patch(
    "/projects/{project_id}/narrative/character-beliefs/{belief_id}",
    response_model=CharacterBeliefResponse,
    summary="更新人物信念",
)
async def update_character_belief(
    project_id: str,
    belief_id: str,
    data: CharacterBeliefUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CharacterBeliefResponse:
    """更新人物信念；拒绝通过常规更新升级为已确认状态。"""
    with _domain_errors():
        view = await narrative_service.update_character_belief(
            session, project_id, belief_id, changes=data.model_dump(exclude_unset=True)
        )
    return to_character_belief_response(view)


@router.delete(
    "/projects/{project_id}/narrative/character-beliefs/{belief_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除人物信念",
)
async def delete_character_belief(
    project_id: str,
    belief_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """删除单条人物信念（显式操作；优先使用取代或失效）。"""
    with _domain_errors():
        await narrative_service.delete_character_belief(session, project_id, belief_id)


@router.post(
    "/projects/{project_id}/narrative/character-beliefs/{belief_id}/confirm",
    response_model=CharacterBeliefResponse,
    summary="确认人物信念",
)
async def confirm_character_belief(
    project_id: str,
    belief_id: str,
    data: NarrativeConfirmRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CharacterBeliefResponse:
    """人工确认人物信念；已确认的信念依然可以是错的。"""
    with _domain_errors():
        view = await narrative_service.confirm_character_belief(
            session,
            project_id,
            belief_id,
            expected_updated_at=data.expected_updated_at,
            confirmed_by=data.confirmed_by,
        )
    return to_character_belief_response(view)


# --- 情节线 -----------------------------------------------------------------


@router.get(
    "/projects/{project_id}/narrative/plotlines",
    response_model=PlotlineListResponse,
    summary="列出情节线",
)
async def list_plotlines(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    state: Annotated[PlotlineState | None, Query()] = None,
    confirmation: Annotated[ConfirmationState | None, Query()] = None,
    limit: Annotated[int | None, Query(ge=1)] = None,
    offset: Annotated[int | None, Query(ge=0)] = None,
) -> PlotlineListResponse:
    """分页列出项目内的情节线。"""
    with _domain_errors():
        views, total = await narrative_service.list_plotlines(
            session,
            project_id,
            state=state,
            confirmation=confirmation,
            limit=limit,
            offset=offset,
        )
    resolved_limit, resolved_offset = narrative_service.resolve_page(limit, offset)
    return PlotlineListResponse(
        items=[to_plotline_response(view) for view in views],
        total=total,
        limit=resolved_limit,
        offset=resolved_offset,
    )


@router.post(
    "/projects/{project_id}/narrative/plotlines",
    response_model=PlotlineResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建情节线",
)
async def create_plotline(
    project_id: str,
    data: PlotlineCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PlotlineResponse:
    """创建情节线。"""
    with _domain_errors():
        view = await narrative_service.create_plotline(
            session,
            project_id,
            title=data.title,
            description=data.description,
            current_question=data.current_question,
            payoff=data.payoff,
            state=data.state,
            introduced_chapter_id=data.introduced_chapter_id,
            advanced_chapter_id=data.advanced_chapter_id,
            related_character_ids=data.related_character_ids,
            related_outline_ids=data.related_outline_ids,
            source_type=data.source_type,
            source_id=data.source_id,
            source_chapter_id=data.source_chapter_id,
            quote_anchor=data.quote_anchor,
            created_by=data.created_by,
            confidence=data.confidence,
            confirmation=data.confirmation,
        )
    return to_plotline_response(view)


@router.get(
    "/projects/{project_id}/narrative/plotlines/{plotline_id}",
    response_model=PlotlineResponse,
    summary="获取情节线",
)
async def get_plotline(
    project_id: str,
    plotline_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PlotlineResponse:
    """获取单条情节线。"""
    view = await narrative_service.get_plotline(session, project_id, plotline_id)
    return to_plotline_response(view)


@router.patch(
    "/projects/{project_id}/narrative/plotlines/{plotline_id}",
    response_model=PlotlineResponse,
    summary="更新情节线",
)
async def update_plotline(
    project_id: str,
    plotline_id: str,
    data: PlotlineUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PlotlineResponse:
    """更新情节线；拒绝通过常规更新升级为已确认状态。"""
    with _domain_errors():
        view = await narrative_service.update_plotline(
            session, project_id, plotline_id, changes=data.model_dump(exclude_unset=True)
        )
    return to_plotline_response(view)


@router.delete(
    "/projects/{project_id}/narrative/plotlines/{plotline_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除情节线",
)
async def delete_plotline(
    project_id: str,
    plotline_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """删除单条情节线（显式操作）。"""
    with _domain_errors():
        await narrative_service.delete_plotline(session, project_id, plotline_id)


@router.post(
    "/projects/{project_id}/narrative/plotlines/{plotline_id}/confirm",
    response_model=PlotlineResponse,
    summary="确认情节线",
)
async def confirm_plotline(
    project_id: str,
    plotline_id: str,
    data: NarrativeConfirmRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PlotlineResponse:
    """人工确认情节线。"""
    with _domain_errors():
        view = await narrative_service.confirm_plotline(
            session,
            project_id,
            plotline_id,
            expected_updated_at=data.expected_updated_at,
            confirmed_by=data.confirmed_by,
        )
    return to_plotline_response(view)


# --- 场景计划 ---------------------------------------------------------------


@router.get(
    "/projects/{project_id}/narrative/scene-plans",
    response_model=ScenePlanListResponse,
    summary="列出场景计划",
)
async def list_scene_plans(
    project_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
    chapter_id: Annotated[str | None, Query()] = None,
    confirmation: Annotated[ConfirmationState | None, Query()] = None,
    limit: Annotated[int | None, Query(ge=1)] = None,
    offset: Annotated[int | None, Query(ge=0)] = None,
) -> ScenePlanListResponse:
    """分页列出项目内的场景计划。"""
    with _domain_errors():
        views, total = await narrative_service.list_scene_plans(
            session,
            project_id,
            chapter_id=chapter_id,
            confirmation=confirmation,
            limit=limit,
            offset=offset,
        )
    resolved_limit, resolved_offset = narrative_service.resolve_page(limit, offset)
    return ScenePlanListResponse(
        items=[to_scene_plan_response(view) for view in views],
        total=total,
        limit=resolved_limit,
        offset=resolved_offset,
    )


@router.post(
    "/projects/{project_id}/narrative/scene-plans",
    response_model=ScenePlanResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建场景计划",
)
async def create_scene_plan(
    project_id: str,
    data: ScenePlanCreateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ScenePlanResponse:
    """创建场景计划；同一章节内场景序号唯一。"""
    with _domain_errors():
        view = await narrative_service.create_scene_plan(
            session,
            project_id,
            chapter_id=data.chapter_id,
            scene_index=data.scene_index,
            goal=data.goal,
            pov_character_id=data.pov_character_id,
            location=data.location,
            tone=data.tone,
            preconditions=data.preconditions,
            participants=data.participants,
            character_goals=(
                [goal.model_dump() for goal in data.character_goals]
                if data.character_goals is not None
                else None
            ),
            known_information=data.known_information,
            hidden_information=data.hidden_information,
            active_plotline_ids=data.active_plotline_ids,
            world_constraints=data.world_constraints,
            expected_changes=data.expected_changes,
            result=data.result.model_dump() if data.result is not None else None,
            source_type=data.source_type,
            source_id=data.source_id,
            source_chapter_id=data.source_chapter_id,
            quote_anchor=data.quote_anchor,
            created_by=data.created_by,
            confidence=data.confidence,
            confirmation=data.confirmation,
        )
    return to_scene_plan_response(view)


@router.get(
    "/projects/{project_id}/narrative/scene-plans/{plan_id}",
    response_model=ScenePlanResponse,
    summary="获取场景计划",
)
async def get_scene_plan(
    project_id: str,
    plan_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ScenePlanResponse:
    """获取单个场景计划。"""
    view = await narrative_service.get_scene_plan(session, project_id, plan_id)
    return to_scene_plan_response(view)


@router.patch(
    "/projects/{project_id}/narrative/scene-plans/{plan_id}",
    response_model=ScenePlanResponse,
    summary="更新场景计划",
)
async def update_scene_plan(
    project_id: str,
    plan_id: str,
    data: ScenePlanUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ScenePlanResponse:
    """更新场景计划；拒绝通过常规更新升级为已确认状态。"""
    changes = data.model_dump(exclude_unset=True)
    with _domain_errors():
        view = await narrative_service.update_scene_plan(
            session, project_id, plan_id, changes=changes
        )
    return to_scene_plan_response(view)


@router.delete(
    "/projects/{project_id}/narrative/scene-plans/{plan_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除场景计划",
)
async def delete_scene_plan(
    project_id: str,
    plan_id: str,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """删除单个场景计划（显式操作）。"""
    with _domain_errors():
        await narrative_service.delete_scene_plan(session, project_id, plan_id)


@router.post(
    "/projects/{project_id}/narrative/scene-plans/{plan_id}/confirm",
    response_model=ScenePlanResponse,
    summary="确认场景计划",
)
async def confirm_scene_plan(
    project_id: str,
    plan_id: str,
    data: NarrativeConfirmRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ScenePlanResponse:
    """人工确认场景计划。"""
    with _domain_errors():
        view = await narrative_service.confirm_scene_plan(
            session,
            project_id,
            plan_id,
            expected_updated_at=data.expected_updated_at,
            confirmed_by=data.confirmed_by,
        )
    return to_scene_plan_response(view)
