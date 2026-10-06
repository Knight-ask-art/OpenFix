# -*- coding: utf-8 -*-
"""只读工具 read_narrative_state 的测试。

覆盖三类关注点：

1. 注册与权限：工具类别、默认权限、Agent 工具列表都沿用既有机制；
2. 范围解析：项目来自会话，章节只在显式给出卷 / 章节定位时解析，
   解析不到就失败，绝不退回「大概这一章」；
3. 只读与边界：只返回已确认记录、项目隔离、空状态不编造内容、不写入任何行。

模型行为不在这里验证：该工具不调用模型，返回的就是本地渲染好的有界文本。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.agents.definitions import get_default_agent_definition
from app.agent_runtime.agents.tool_categories import get_tool_names_for_categories
from app.agent_runtime.tools.permission_metadata import (
    get_default_agent_tool_permissions,
    get_default_tool_permission_mode,
)
from app.agent_runtime.tools.registry import ToolRegistry
from app.core.narrative_context import MAX_CONTEXT_CHARS
from app.storage.models.character import Character
from app.storage.models.character_belief import CharacterBelief
from app.storage.models.chapter import Chapter
from app.storage.models.plotline import Plotline
from app.storage.models.project import Project
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.volume import Volume
from app.storage.models.world_fact import WorldFact

PROJECT_ID = "project-narrative"
OTHER_PROJECT_ID = "project-other"
VOLUME_ID = "volume-1"
CHAPTER_ID = "chapter-1"
OTHER_CHAPTER_ID = "chapter-2"
KEY_STATEMENT = "城南书铺的抽屉里藏着一把黄铜钥匙"


def _make_state(project_id: str = PROJECT_ID) -> dict:
    return {
        "session_id": "sess-1",
        "project_id": project_id,
        "model_config": {},
        "active_agent": "writer",
        "is_completed": False,
        "error": None,
        "retry_count": 0,
        "message_checkpoints": [],
        "user_request": "",
    }


def _tool(project_id: str = PROJECT_ID):
    return ToolRegistry.get_tools(
        names=["read_narrative_state"], state=_make_state(project_id)
    )[0]


async def _invoke(
    tool, session: AsyncSession, payload: dict[str, Any] | None = None
) -> dict[str, Any]:
    raw = await tool.ainvoke(
        payload or {},
        config={"configurable": {"db_session": session}},
    )
    return json.loads(raw)


async def _seed_project(session: AsyncSession) -> None:
    session.add(Project(id=PROJECT_ID, title="叙事状态项目"))
    session.add(Project(id=OTHER_PROJECT_ID, title="另一个项目"))
    session.add(
        Volume(id=VOLUME_ID, project_id=PROJECT_ID, title="第一卷", order=1)
    )
    session.add(
        Chapter(
            id=CHAPTER_ID,
            project_id=PROJECT_ID,
            volume_id=VOLUME_ID,
            title="夜雨",
            content="林晚推门而入。",
            order=1,
            word_count=7,
        )
    )
    session.add(
        Chapter(
            id=OTHER_CHAPTER_ID,
            project_id=PROJECT_ID,
            volume_id=VOLUME_ID,
            title="旧信",
            content="信封已经发黄。",
            order=2,
            word_count=7,
        )
    )
    session.add(
        Character(id="char-1", project_id=PROJECT_ID, name="林晚", description="剑客")
    )
    await session.flush()


# ============================================
# 注册与权限
# ============================================


def test_read_narrative_state_is_registered_as_readonly_with_default_permission() -> None:
    tool = _tool()
    schema = tool.args_schema.model_json_schema()

    assert tool.name == "read_narrative_state"
    assert tool.access_level == "readonly"
    assert set(schema["properties"].keys()) == {"volume_ref", "chapter_ref"}
    assert schema.get("required", []) == []
    assert get_default_tool_permission_mode("read_narrative_state") == "allow"
    assert {"tool_name": "read_narrative_state", "mode": "allow"} in (
        get_default_agent_tool_permissions()
    )


def test_read_narrative_state_follows_the_existing_tool_category_mechanism() -> None:
    names = get_tool_names_for_categories(["story_memory_read"])

    assert "read_narrative_state" in names
    for agent_key in ("writer", "reviewer"):
        definition = get_default_agent_definition(agent_key)
        assert "read_narrative_state" in get_tool_names_for_categories(
            definition.enabled_tool_categories
        )
    # 只读工具不能把写入类别带进 Reviewer 的工具集。
    reviewer = get_default_agent_definition("reviewer")
    assert not any(
        category.endswith("_write") for category in reviewer.enabled_tool_categories
    )


def test_read_narrative_state_is_visible_in_agent_tool_list() -> None:
    from app.api.routers.agent_runtime import TOOL_DISPLAY_ORDER

    assert "read_narrative_state" in TOOL_DISPLAY_ORDER
    assert (
        TOOL_DISPLAY_ORDER["read_narrative_state"]
        > TOOL_DISPLAY_ORDER["search_story_memory"]
    )
    assert (
        TOOL_DISPLAY_ORDER["read_narrative_state"]
        < TOOL_DISPLAY_ORDER["update_index"]
    )


# ============================================
# 只返回已确认记录
# ============================================


@pytest.mark.asyncio
async def test_returns_only_confirmed_rows_and_skips_the_rest(
    session: AsyncSession,
) -> None:
    await _seed_project(session)
    confirmed_fact = WorldFact(
        id="fact-1",
        project_id=PROJECT_ID,
        statement=KEY_STATEMENT,
        status="confirmed",
        confirmation="confirmed",
    )
    session.add(confirmed_fact)
    session.add(
        WorldFact(
            id="fact-2",
            project_id=PROJECT_ID,
            statement="候选事实：书名是《夜雨》",
            confirmation="candidate",
        )
    )
    session.add(
        WorldFact(
            id="fact-3",
            project_id=PROJECT_ID,
            statement="被拒绝的事实",
            status="confirmed",
            confirmation="rejected",
        )
    )
    session.add(
        WorldFact(
            id="fact-4",
            project_id=PROJECT_ID,
            statement="已作废的事实",
            status="retired",
            confirmation="confirmed",
        )
    )
    session.add(
        WorldFact(
            id="fact-5",
            project_id=PROJECT_ID,
            statement="已被取代的事实",
            status="confirmed",
            confirmation="confirmed",
            superseded_by_id="fact-1",
        )
    )
    session.add(
        CharacterBelief(
            id="belief-1",
            project_id=PROJECT_ID,
            character_id="char-1",
            proposition="以为师父还活着",
            belief_state="mistaken",
            confirmation="confirmed",
        )
    )
    session.add(
        CharacterBelief(
            id="belief-2",
            project_id=PROJECT_ID,
            character_id="char-1",
            proposition="候选信念",
            belief_state="known",
        )
    )
    session.add(
        CharacterBelief(
            id="belief-3",
            project_id=PROJECT_ID,
            character_id="char-1",
            proposition="已失效的信念",
            belief_state="known",
            confirmation="confirmed",
            invalidated_at=datetime.now(UTC),
        )
    )
    session.add(
        Plotline(
            id="plotline-1",
            project_id=PROJECT_ID,
            title="钥匙的来历",
            state="open",
            confirmation="confirmed",
            current_question="钥匙是谁留下的？",
        )
    )
    session.add(
        Plotline(
            id="plotline-2",
            project_id=PROJECT_ID,
            title="被放弃的支线",
            state="abandoned",
            confirmation="confirmed",
        )
    )
    await session.flush()

    result = await _invoke(_tool(), session)

    assert result["has_confirmed_state"] is True
    assert result["chapter_scope"] is None
    text = result["state_text"]
    assert KEY_STATEMENT in text
    assert "以为师父还活着" in text
    assert "钥匙的来历" in text
    assert "候选事实" not in text
    assert "被拒绝的事实" not in text
    assert "已作废的事实" not in text
    assert "已被取代的事实" not in text
    assert "候选信念" not in text
    assert "已失效的信念" not in text
    assert "被放弃的支线" not in text
    assert len(text) <= MAX_CONTEXT_CHARS


@pytest.mark.asyncio
async def test_state_is_scoped_to_the_session_project(
    session: AsyncSession,
) -> None:
    await _seed_project(session)
    session.add(
        WorldFact(
            id="fact-mine",
            project_id=PROJECT_ID,
            statement="本项目的世界事实",
            status="confirmed",
            confirmation="confirmed",
        )
    )
    session.add(
        WorldFact(
            id="fact-theirs",
            project_id=OTHER_PROJECT_ID,
            statement="另一个项目的世界事实",
            status="confirmed",
            confirmation="confirmed",
        )
    )
    await session.flush()

    result = await _invoke(_tool(), session)

    assert "本项目的世界事实" in result["state_text"]
    assert "另一个项目的世界事实" not in result["state_text"]


# ============================================
# 章节范围显式解析
# ============================================


@pytest.mark.asyncio
async def test_chapter_scope_is_required_for_scene_plans(
    session: AsyncSession,
) -> None:
    await _seed_project(session)
    session.add(
        ScenePlan(
            id="plan-1",
            project_id=PROJECT_ID,
            chapter_id=CHAPTER_ID,
            scene_index=0,
            goal="林晚找到钥匙",
            hidden_information_json='["抽屉暗格里的钥匙来历"]',
            confirmation="confirmed",
        )
    )
    await session.flush()

    without_scope = await _invoke(_tool(), session)
    assert without_scope["chapter_scope"] is None
    assert "抽屉暗格里的钥匙来历" not in without_scope["state_text"]

    with_scope = await _invoke(
        _tool(),
        session,
        {
            "volume_ref": {"type": "order", "value": 1},
            "chapter_ref": {"type": "order", "value": 1},
        },
    )
    assert with_scope["chapter_scope"] == "第1章 夜雨"
    assert "林晚找到钥匙" in with_scope["state_text"]
    assert "抽屉暗格里的钥匙来历" in with_scope["state_text"]


@pytest.mark.asyncio
async def test_chapter_title_scope_resolves_the_exact_chapter(
    session: AsyncSession,
) -> None:
    await _seed_project(session)
    session.add(
        ScenePlan(
            id="plan-2",
            project_id=PROJECT_ID,
            chapter_id=OTHER_CHAPTER_ID,
            scene_index=0,
            goal="林晚拆开旧信",
            confirmation="confirmed",
        )
    )
    await session.flush()

    result = await _invoke(
        _tool(),
        session,
        {
            "volume_ref": {"type": "title", "value": "第一卷"},
            "chapter_ref": {"type": "title", "value": "旧信"},
        },
    )

    assert result["chapter_scope"] == "第2章 旧信"
    assert "林晚拆开旧信" in result["state_text"]


@pytest.mark.asyncio
async def test_partial_chapter_scope_is_rejected(session: AsyncSession) -> None:
    await _seed_project(session)

    result = await _invoke(
        _tool(), session, {"chapter_ref": {"type": "order", "value": 1}}
    )

    assert result["success"] is False
    assert "必须同时提供" in result["message"]


@pytest.mark.asyncio
async def test_unknown_chapter_fails_instead_of_guessing(
    session: AsyncSession,
) -> None:
    await _seed_project(session)
    session.add(
        WorldFact(
            id="fact-1",
            project_id=PROJECT_ID,
            statement=KEY_STATEMENT,
            status="confirmed",
            confirmation="confirmed",
        )
    )
    await session.flush()

    result = await _invoke(
        _tool(),
        session,
        {
            "volume_ref": {"type": "order", "value": 1},
            "chapter_ref": {"type": "order", "value": 99},
        },
    )

    # 解析不到章节时整次调用失败：不能退回项目级结果充当「这一章」的状态。
    assert result["success"] is False
    assert "未找到章节" in result["message"]
    assert "state_text" not in result


@pytest.mark.asyncio
async def test_empty_state_is_reported_without_inventing_content(
    session: AsyncSession,
) -> None:
    await _seed_project(session)

    result = await _invoke(_tool(), session)

    assert result["has_confirmed_state"] is False
    assert result["state_text"] == ""


# ============================================
# 只读
# ============================================


@pytest.mark.asyncio
async def test_tool_writes_no_rows(session: AsyncSession) -> None:
    await _seed_project(session)
    session.add(
        WorldFact(
            id="fact-1",
            project_id=PROJECT_ID,
            statement=KEY_STATEMENT,
            status="confirmed",
            confirmation="confirmed",
        )
    )
    session.add(
        ScenePlan(
            id="plan-1",
            project_id=PROJECT_ID,
            chapter_id=CHAPTER_ID,
            scene_index=0,
            goal="林晚找到钥匙",
            confirmation="confirmed",
        )
    )
    await session.flush()

    async def _counts() -> dict[str, int]:
        tables = {
            "world_facts": WorldFact,
            "character_beliefs": CharacterBelief,
            "plotlines": Plotline,
            "scene_plans": ScenePlan,
            "chapters": Chapter,
            "characters": Character,
        }
        result: dict[str, int] = {}
        for name, model in tables.items():
            rows = (await session.execute(select(model))).scalars().all()
            result[name] = len(rows)
        return result

    before = await _counts()
    project_only = await _invoke(_tool(), session)
    scoped = await _invoke(
        _tool(),
        session,
        {
            "volume_ref": {"type": "order", "value": 1},
            "chapter_ref": {"type": "order", "value": 1},
        },
    )
    project_only_again = await _invoke(_tool(), session)

    assert await _counts() == before
    assert "林晚找到钥匙" in scoped["state_text"]
    # 重复读取结果稳定，不因为读了一次就产生新记录或改变渲染。
    assert project_only["state_text"] == project_only_again["state_text"]
