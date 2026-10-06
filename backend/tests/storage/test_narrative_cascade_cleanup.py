# -*- coding: utf-8 -*-
"""叙事状态级联清理回归测试。

对应 `release-state-audit.md` §3.6 确认的缺陷：章节 / 人物 / 卷删除后，四张叙事
扩展表会留下孤儿行（已删除章节的场景计划、已删除人物的人物信念、指向已删除
章节 / 人物的可选引用）。

本文件覆盖的语义：

* 必需父引用随父行删除：`scene_plans.chapter_id`、`character_beliefs.character_id`；
* 可选章节 / 人物引用置空或从 JSON 关系列表移除；
* 清理严格限定在受影响的项目内；
* 普通删除、批量删除、卷级 cascade 与 Agent 回滚扩展清理走同一套语义；
* 清理后一致性上下文不再渲染「（未命名人物）」，Story Memory 不再产出孤儿文档。
"""

import json
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime import revision_extensions
from app.core.narrative_context import (
    UNKNOWN_CHARACTER_NAME,
    build_narrative_state_context,
)
from app.retrieval.story_memory import build_story_memory_documents
from app.storage.models.character_belief import CharacterBelief
from app.storage.models.plotline import Plotline
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.world_fact import WorldFact

BASE = "/api/v1/projects/{project_id}/narrative"


# --- 夹具辅助 ---------------------------------------------------------------


async def _create_project(client: AsyncClient, title: str = "级联清理测试") -> str:
    response = await client.post("/api/v1/projects", data={"title": title})
    assert response.status_code == 201
    return response.json()["id"]


async def _first_volume_id(client: AsyncClient, project_id: str) -> str:
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    assert volumes
    return volumes[0]["id"]


async def _create_volume(client: AsyncClient, project_id: str, title: str) -> str:
    response = await client.post(
        f"/api/v1/projects/{project_id}/volumes", json={"title": title}
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_chapter(
    client: AsyncClient, project_id: str, volume_id: str, title: str = "第一章"
) -> str:
    response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": volume_id, "title": title, "content": "正文"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_character(
    client: AsyncClient, project_id: str, name: str = "林洛"
) -> str:
    response = await client.post(
        f"/api/v1/projects/{project_id}/characters",
        data={"name": name, "description": "记者"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _post(client: AsyncClient, project_id: str, path: str, payload: dict) -> dict:
    response = await client.post(BASE.format(project_id=project_id) + path, json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _confirm(client: AsyncClient, project_id: str, path: str, row: dict) -> dict:
    response = await client.post(
        BASE.format(project_id=project_id) + f"{path}/{row['id']}/confirm",
        json={"expected_updated_at": row["updated_at"]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["confirmation"] == "confirmed"
    return response.json()


async def _count(session: AsyncSession, model: type[Any], **filters: str) -> int:
    statement = select(model)
    for field, value in filters.items():
        statement = statement.where(getattr(model, field) == value)
    return len((await session.execute(statement)).scalars().all())


async def _get(session: AsyncSession, model: type[Any], row_id: str) -> Any | None:
    session.expire_all()
    return await session.get(model, row_id)


# --- 章节删除 ---------------------------------------------------------------


async def test_delete_chapter_removes_scene_plans_and_clears_chapter_links(
    client: AsyncClient, session: AsyncSession
) -> None:
    """删章节：场景计划随章节删除，其余可选章节引用置空且行保留。"""
    project_id = await _create_project(client)
    volume_id = await _first_volume_id(client, project_id)
    chapter_id = await _create_chapter(client, project_id, volume_id, "第一章")
    other_chapter_id = await _create_chapter(client, project_id, volume_id, "第二章")
    character_id = await _create_character(client, project_id)

    fact = await _post(
        client,
        project_id,
        "/world-facts",
        {
            "statement": "北城常年阴雨",
            "source_type": "chapter",
            "source_id": chapter_id,
            "source_chapter_id": chapter_id,
        },
    )
    belief = await _post(
        client,
        project_id,
        "/character-beliefs",
        {
            "character_id": character_id,
            "proposition": "甲相信 X",
            "learned_at_chapter_id": chapter_id,
            "source_chapter_id": chapter_id,
        },
    )
    plotline = await _post(
        client,
        project_id,
        "/plotlines",
        {
            "title": "主线",
            "introduced_chapter_id": chapter_id,
            "advanced_chapter_id": other_chapter_id,
        },
    )
    deleted_plan = await _post(
        client,
        project_id,
        "/scene-plans",
        {"chapter_id": chapter_id, "scene_index": 0},
    )
    survivor_plan = await _post(
        client,
        project_id,
        "/scene-plans",
        {
            "chapter_id": other_chapter_id,
            "scene_index": 0,
            "source_type": "chapter",
            "source_id": chapter_id,
            "source_chapter_id": chapter_id,
        },
    )

    response = await client.delete(f"/api/v1/chapters/{chapter_id}")
    assert response.status_code == 204

    assert await _count(session, ScenePlan, project_id=project_id) == 1
    assert await _get(session, ScenePlan, deleted_plan["id"]) is None

    surviving_plan = await _get(session, ScenePlan, survivor_plan["id"])
    assert surviving_plan is not None
    assert surviving_plan.source_chapter_id is None

    surviving_belief = await _get(session, CharacterBelief, belief["id"])
    assert surviving_belief is not None
    assert surviving_belief.learned_at_chapter_id is None
    assert surviving_belief.source_chapter_id is None

    surviving_plotline = await _get(session, Plotline, plotline["id"])
    assert surviving_plotline is not None
    assert surviving_plotline.introduced_chapter_id is None
    # 只清掉指向被删章节的那一列，指向存活章节的推进章节必须保留。
    assert surviving_plotline.advanced_chapter_id == other_chapter_id

    surviving_fact = await _get(session, WorldFact, fact["id"])
    assert surviving_fact is not None
    assert surviving_fact.source_chapter_id is None
    assert surviving_fact.source_id is None


async def test_delete_chapters_in_volume_clears_narrative_data(
    client: AsyncClient, session: AsyncSession
) -> None:
    """卷级 cascade 批量删章：卷内场景计划全部随章节删除，可选引用置空。"""
    project_id = await _create_project(client)
    keep_volume_id = await _first_volume_id(client, project_id)
    drop_volume_id = await _create_volume(client, project_id, "第二卷")
    keep_chapter_id = await _create_chapter(
        client, project_id, keep_volume_id, "保留章"
    )
    chapter_a = await _create_chapter(client, project_id, drop_volume_id, "待删章一")
    chapter_b = await _create_chapter(client, project_id, drop_volume_id, "待删章二")
    character_id = await _create_character(client, project_id)

    beliefs = [
        await _post(
            client,
            project_id,
            "/character-beliefs",
            {
                "character_id": character_id,
                "proposition": f"信念 {index}",
                "learned_at_chapter_id": chapter_id,
            },
        )
        for index, chapter_id in enumerate((chapter_a, chapter_b))
    ]
    plans = [
        await _post(
            client,
            project_id,
            "/scene-plans",
            {"chapter_id": chapter_id, "scene_index": 0},
        )
        for chapter_id in (chapter_a, chapter_b)
    ]
    kept_plan = await _post(
        client,
        project_id,
        "/scene-plans",
        {"chapter_id": keep_chapter_id, "scene_index": 0},
    )
    plotline = await _post(
        client,
        project_id,
        "/plotlines",
        {"title": "主线", "introduced_chapter_id": chapter_a},
    )
    response = await client.delete(f"/api/v1/volumes/{drop_volume_id}?cascade=true")
    assert response.status_code == 204, response.text

    assert await _count(session, ScenePlan, project_id=project_id) == 1
    for plan in plans:
        assert await _get(session, ScenePlan, plan["id"]) is None
    assert await _get(session, ScenePlan, kept_plan["id"]) is not None

    for belief in beliefs:
        surviving = await _get(session, CharacterBelief, belief["id"])
        assert surviving is not None
        assert surviving.learned_at_chapter_id is None

    surviving_plotline = await _get(session, Plotline, plotline["id"])
    assert surviving_plotline is not None
    assert surviving_plotline.introduced_chapter_id is None


# --- 人物删除 ---------------------------------------------------------------


async def test_delete_character_removes_beliefs_and_clears_character_links(
    client: AsyncClient, session: AsyncSession
) -> None:
    """删人物：人物信念随人物删除，可选人物引用置空或从 JSON 列表移除。"""
    project_id = await _create_project(client)
    volume_id = await _first_volume_id(client, project_id)
    chapter_id = await _create_chapter(client, project_id, volume_id)
    deleted_character_id = await _create_character(client, project_id, "林洛")
    kept_character_id = await _create_character(client, project_id, "沈青")

    deleted_belief = await _post(
        client,
        project_id,
        "/character-beliefs",
        {"character_id": deleted_character_id, "proposition": "甲相信 X"},
    )
    kept_belief = await _post(
        client,
        project_id,
        "/character-beliefs",
        {"character_id": kept_character_id, "proposition": "乙相信 Y"},
    )
    plan = await _post(
        client,
        project_id,
        "/scene-plans",
        {
            "chapter_id": chapter_id,
            "scene_index": 0,
            "pov_character_id": deleted_character_id,
            "participants": [deleted_character_id, kept_character_id],
            "character_goals": [
                {"character_id": deleted_character_id, "goal": "找到证据"},
                {"character_id": kept_character_id, "goal": "守住秘密"},
            ],
        },
    )
    plotline = await _post(
        client,
        project_id,
        "/plotlines",
        {
            "title": "主线",
            "related_character_ids": [deleted_character_id, kept_character_id],
        },
    )
    sourced_fact = await _post(
        client,
        project_id,
        "/world-facts",
        {
            "statement": "人物档案来源事实",
            "source_type": "character_profile",
            "source_id": deleted_character_id,
        },
    )

    response = await client.delete(f"/api/v1/characters/{deleted_character_id}")
    assert response.status_code == 204

    assert await _get(session, CharacterBelief, deleted_belief["id"]) is None
    assert await _get(session, CharacterBelief, kept_belief["id"]) is not None

    surviving_plan = await _get(session, ScenePlan, plan["id"])
    assert surviving_plan is not None
    assert surviving_plan.pov_character_id is None
    assert surviving_plan.participants_json == f'["{kept_character_id}"]'
    assert kept_character_id in surviving_plan.character_goals_json
    assert deleted_character_id not in surviving_plan.character_goals_json

    surviving_plotline = await _get(session, Plotline, plotline["id"])
    assert surviving_plotline is not None
    assert surviving_plotline.related_character_ids_json == (
        f'["{kept_character_id}"]'
    )
    surviving_fact = await _get(session, WorldFact, sourced_fact["id"])
    assert surviving_fact is not None
    assert surviving_fact.source_id is None


async def test_batch_delete_characters_clears_narrative_data(
    client: AsyncClient, session: AsyncSession
) -> None:
    """批量删人物：与单个删除走同一套清理语义。"""
    project_id = await _create_project(client)
    volume_id = await _first_volume_id(client, project_id)
    chapter_id = await _create_chapter(client, project_id, volume_id)
    first_character_id = await _create_character(client, project_id, "林洛")
    second_character_id = await _create_character(client, project_id, "沈青")

    beliefs = [
        await _post(
            client,
            project_id,
            "/character-beliefs",
            {"character_id": character_id, "proposition": f"信念 {index}"},
        )
        for index, character_id in enumerate(
            (first_character_id, second_character_id)
        )
    ]
    plan = await _post(
        client,
        project_id,
        "/scene-plans",
        {
            "chapter_id": chapter_id,
            "scene_index": 0,
            "pov_character_id": first_character_id,
            "participants": [first_character_id, second_character_id],
        },
    )
    plotline = await _post(
        client,
        project_id,
        "/plotlines",
        {"title": "主线", "related_character_ids": [second_character_id]},
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/characters/batch/delete",
        json={"character_ids": [first_character_id, second_character_id]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["deleted_count"] == 2

    assert await _count(session, CharacterBelief, project_id=project_id) == 0
    for belief in beliefs:
        assert await _get(session, CharacterBelief, belief["id"]) is None

    surviving_plan = await _get(session, ScenePlan, plan["id"])
    assert surviving_plan is not None
    assert surviving_plan.pov_character_id is None
    assert surviving_plan.participants_json == "[]"

    surviving_plotline = await _get(session, Plotline, plotline["id"])
    assert surviving_plotline is not None
    assert surviving_plotline.related_character_ids_json == "[]"


async def test_character_cleanup_does_not_repair_unrelated_invalid_json(
    client: AsyncClient, session: AsyncSession
) -> None:
    """清理一列引用时，不把另一列的非法 JSON 擅自归一化为空列表。"""
    project_id = await _create_project(client)
    volume_id = await _first_volume_id(client, project_id)
    chapter_id = await _create_chapter(client, project_id, volume_id)
    character_id = await _create_character(client, project_id)
    plan = ScenePlan(
        project_id=project_id,
        chapter_id=chapter_id,
        scene_index=0,
        participants_json="{damaged participants",
        character_goals_json=json.dumps(
            [{"character_id": character_id, "goal": "离开"}], ensure_ascii=False
        ),
    )
    session.add(plan)
    await session.flush()
    plan_id = plan.id

    response = await client.delete(f"/api/v1/characters/{character_id}")
    assert response.status_code == 204

    surviving_plan = await _get(session, ScenePlan, plan_id)
    assert surviving_plan is not None
    assert surviving_plan.participants_json == "{damaged participants"
    assert surviving_plan.character_goals_json == "[]"


# --- 项目隔离 ---------------------------------------------------------------


async def test_narrative_cleanup_is_project_scoped(
    client: AsyncClient, session: AsyncSession
) -> None:
    """级联清理只作用于受影响项目：其它项目里引用同名 ID 的行保持原样。"""
    project_id = await _create_project(client, "项目一")
    other_project_id = await _create_project(client, "项目二")
    volume_id = await _first_volume_id(client, project_id)
    chapter_id = await _create_chapter(client, project_id, volume_id)
    character_id = await _create_character(client, project_id)
    other_volume_id = await _first_volume_id(client, other_project_id)
    other_chapter_id = await _create_chapter(
        client, other_project_id, other_volume_id, "另一章"
    )

    # 直接写入跨项目的悬挂引用，验证清理语句的 project_id 条件确实生效。
    session.add(
        CharacterBelief(
            project_id=other_project_id,
            character_id=character_id,
            proposition="跨项目悬挂信念",
            learned_at_chapter_id=chapter_id,
        )
    )
    session.add(
        Plotline(
            project_id=other_project_id,
            title="跨项目情节线",
            introduced_chapter_id=chapter_id,
            related_character_ids_json=f'["{character_id}"]',
        )
    )
    session.add(
        ScenePlan(
            project_id=other_project_id,
            chapter_id=other_chapter_id,
            scene_index=0,
            pov_character_id=character_id,
            participants_json=f'["{character_id}"]',
        )
    )
    await session.flush()

    assert (
        await client.delete(f"/api/v1/chapters/{chapter_id}")
    ).status_code == 204
    assert (
        await client.delete(f"/api/v1/characters/{character_id}")
    ).status_code == 204

    # 强制从数据库重新读取，避免断言落在 session 里过期的内存副本上。
    session.expire_all()

    other_belief = (
        await session.execute(
            select(CharacterBelief).where(
                CharacterBelief.project_id == other_project_id
            )
        )
    ).scalars().one()
    assert other_belief.learned_at_chapter_id == chapter_id

    other_plotline = (
        await session.execute(
            select(Plotline).where(Plotline.project_id == other_project_id)
        )
    ).scalars().one()
    assert other_plotline.introduced_chapter_id == chapter_id
    assert other_plotline.related_character_ids_json == f'["{character_id}"]'

    other_plan = (
        await session.execute(
            select(ScenePlan).where(ScenePlan.project_id == other_project_id)
        )
    ).scalars().one()
    assert other_plan.pov_character_id == character_id
    assert other_plan.participants_json == f'["{character_id}"]'


# --- Agent 回滚路径 ---------------------------------------------------------


async def test_revision_extension_cleanup_matches_service_cascade(
    client: AsyncClient, session: AsyncSession
) -> None:
    """Agent 回滚删章节 / 人物时的扩展清理与 service 级联语义一致。"""
    project_id = await _create_project(client)
    volume_id = await _first_volume_id(client, project_id)
    chapter_id = await _create_chapter(client, project_id, volume_id)
    character_id = await _create_character(client, project_id)

    belief = await _post(
        client,
        project_id,
        "/character-beliefs",
        {
            "character_id": character_id,
            "proposition": "甲相信 X",
            "learned_at_chapter_id": chapter_id,
        },
    )
    plan = await _post(
        client,
        project_id,
        "/scene-plans",
        {
            "chapter_id": chapter_id,
            "scene_index": 0,
            "pov_character_id": character_id,
        },
    )
    plotline = await _post(
        client,
        project_id,
        "/plotlines",
        {
            "title": "主线",
            "introduced_chapter_id": chapter_id,
            "related_character_ids": [character_id],
        },
    )

    # 回滚删除章节：revisions.py 直接走 repo 删行，再调用扩展清理。
    await revision_extensions.delete_chapter_extensions(
        session, project_id=project_id, chapter_id=chapter_id
    )
    assert await _get(session, ScenePlan, plan["id"]) is None
    cleared_belief = await _get(session, CharacterBelief, belief["id"])
    assert cleared_belief is not None
    assert cleared_belief.learned_at_chapter_id is None

    # 回滚删除人物。
    await revision_extensions.delete_character_extensions(
        session, project_id=project_id, character_id=character_id
    )
    assert await _get(session, CharacterBelief, belief["id"]) is None
    surviving_plotline = await _get(session, Plotline, plotline["id"])
    assert surviving_plotline is not None
    assert surviving_plotline.related_character_ids_json == "[]"


# --- 下游消费者不再看到孤儿 -------------------------------------------------


async def test_no_orphans_reach_narrative_context_or_story_memory(
    client: AsyncClient, session: AsyncSession
) -> None:
    """清理到位后，一致性上下文不再渲染「（未命名人物）」，索引不再产出孤儿文档。"""
    project_id = await _create_project(client)
    volume_id = await _first_volume_id(client, project_id)
    chapter_id = await _create_chapter(client, project_id, volume_id)
    character_id = await _create_character(client, project_id)

    belief = await _confirm(
        client,
        project_id,
        "/character-beliefs",
        await _post(
            client,
            project_id,
            "/character-beliefs",
            {
                "character_id": character_id,
                "proposition": "甲相信 X",
                "learned_at_chapter_id": chapter_id,
            },
        ),
    )
    plan = await _confirm(
        client,
        project_id,
        "/scene-plans",
        await _post(
            client,
            project_id,
            "/scene-plans",
            {
                "chapter_id": chapter_id,
                "scene_index": 0,
                "pov_character_id": character_id,
                "goal": "找到证据",
            },
        ),
    )

    before_context = await build_narrative_state_context(
        session, project_id=project_id, scene_plan_chapter_id=chapter_id
    )
    assert "甲相信 X" in before_context
    assert UNKNOWN_CHARACTER_NAME not in before_context

    assert (
        await client.delete(f"/api/v1/chapters/{chapter_id}")
    ).status_code == 204
    assert (
        await client.delete(f"/api/v1/characters/{character_id}")
    ).status_code == 204

    after_context = await build_narrative_state_context(
        session, project_id=project_id, scene_plan_chapter_id=chapter_id
    )
    assert UNKNOWN_CHARACTER_NAME not in after_context
    assert "甲相信 X" not in after_context

    documents = await build_story_memory_documents(session, project_id)
    document_ids = {document.document_id for document in documents}
    assert f"character_belief:{belief['id']}" not in document_ids
    assert f"scene_state:{plan['id']}" not in document_ids
