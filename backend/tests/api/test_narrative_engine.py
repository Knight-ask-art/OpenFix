# -*- coding: utf-8 -*-
"""Narrative Engine 基础层 API 测试。

覆盖：四类资源的 CRUD、确认升级防护与乐观锁、取代而不删除、事实与信念不混用、
溯源写入与归属校验、跨项目隔离、场景计划唯一性、项目删除清理。
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.storage.models.character_belief import CharacterBelief
from app.storage.models.plotline import Plotline
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.world_fact import WorldFact

BASE = "/api/v1/projects/{project_id}/narrative"


async def _create_project(client: AsyncClient, title: str = "叙事引擎测试") -> str:
    response = await client.post("/api/v1/projects", data={"title": title})
    assert response.status_code == 201
    return response.json()["id"]


async def _create_character(client: AsyncClient, project_id: str, name: str = "林洛") -> str:
    response = await client.post(
        f"/api/v1/projects/{project_id}/characters",
        data={"name": name, "description": "记者"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_chapter(client: AsyncClient, project_id: str, title: str = "第一章") -> str:
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": volumes[0]["id"], "title": title, "content": "正文"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_outline(client: AsyncClient, project_id: str, title: str = "卷一大纲") -> str:
    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines",
        json={"level": "book", "title": title},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_world_entry(client: AsyncClient, project_id: str, name: str = "北城") -> str:
    world_info = (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()
    response = await client.post(
        f"/api/v1/world-info/{world_info['id']}/entries",
        json={"name": name, "content": "北方主城，常年阴雨。"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_fact(client: AsyncClient, project_id: str, statement: str = "北城常年阴雨") -> dict:
    response = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={"statement": statement},
    )
    assert response.status_code == 201
    return response.json()


# --- 世界事实 CRUD ----------------------------------------------------------


@pytest.mark.asyncio
async def test_world_fact_crud_round_trip(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    created = await _create_fact(client, project_id)

    assert created["project_id"] == project_id
    assert created["statement"] == "北城常年阴雨"
    assert created["status"] == "uncertain"
    assert created["confirmation"] == "candidate"
    assert created["superseded_by_id"] is None

    fetched = await client.get(
        BASE.format(project_id=project_id) + f"/world-facts/{created['id']}"
    )
    assert fetched.status_code == 200
    assert fetched.json()["id"] == created["id"]

    patched = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{created['id']}",
        json={"statement": "北城秋冬多雨", "status": "contradicted", "subject_ref": "北城"},
    )
    assert patched.status_code == 200
    assert patched.json()["statement"] == "北城秋冬多雨"
    assert patched.json()["status"] == "contradicted"
    assert patched.json()["subject_ref"] == "北城"

    listed = await client.get(BASE.format(project_id=project_id) + "/world-facts")
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["id"] == created["id"]

    deleted = await client.delete(
        BASE.format(project_id=project_id) + f"/world-facts/{created['id']}"
    )
    assert deleted.status_code == 204
    assert (
        await client.get(BASE.format(project_id=project_id) + "/world-facts")
    ).json()["total"] == 0


@pytest.mark.asyncio
async def test_world_fact_defaults_and_rejects_invalid_status(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    response = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={"statement": "有事实", "status": "not_a_status"},
    )
    assert response.status_code == 422

    empty = await client.post(
        BASE.format(project_id=project_id) + "/world-facts", json={"statement": "   "}
    )
    assert empty.status_code == 400


# --- 确认升级防护 -----------------------------------------------------------


@pytest.mark.asyncio
async def test_create_cannot_write_confirmed_state(client: AsyncClient) -> None:
    """默认与 AI 路径只能产生候选或推断，永远不能直接写 confirmed。"""
    project_id = await _create_project(client)

    escalated = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={"statement": "直接确认", "confirmation": "confirmed"},
    )
    assert escalated.status_code == 400
    assert "确认接口" in escalated.json()["detail"]

    inferred = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={"statement": "推断事实", "confirmation": "inferred"},
    )
    assert inferred.status_code == 201
    assert inferred.json()["confirmation"] == "inferred"
    assert inferred.json()["confirmed_at"] is None


@pytest.mark.asyncio
async def test_normal_update_rejects_confirmation_escalation(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    fact = await _create_fact(client, project_id)

    response = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}",
        json={"confirmation": "confirmed"},
    )
    assert response.status_code == 400
    assert "确认接口" in response.json()["detail"]
    assert (
        await client.get(
            BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}"
        )
    ).json()["confirmation"] == "candidate"


@pytest.mark.asyncio
async def test_confirm_requires_fresh_updated_at_token(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    fact = await _create_fact(client, project_id)
    stale_token = fact["updated_at"]

    updated = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}",
        json={"statement": "改写后的事实"},
    )
    assert updated.status_code == 200
    fresh_token = updated.json()["updated_at"]
    assert fresh_token != stale_token

    confirm_url = BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}/confirm"

    stale = await client.post(confirm_url, json={"expected_updated_at": stale_token})
    assert stale.status_code == 409
    assert "刷新" in stale.json()["detail"]

    confirmed = await client.post(
        confirm_url, json={"expected_updated_at": fresh_token, "confirmed_by": "writer"}
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["confirmation"] == "confirmed"
    assert confirmed.json()["confirmed_by"] == "writer"
    assert confirmed.json()["confirmed_at"] is not None

    # 令牌匹配时重复确认是幂等的。
    again = await client.post(
        confirm_url, json={"expected_updated_at": confirmed.json()["updated_at"]}
    )
    assert again.status_code == 200
    assert again.json()["confirmation"] == "confirmed"


@pytest.mark.asyncio
async def test_confirmed_record_cannot_be_deescalated_by_normal_update(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    fact = await _create_fact(client, project_id)
    confirm_url = BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}/confirm"
    confirmed = await client.post(
        confirm_url, json={"expected_updated_at": fact["updated_at"]}
    )
    assert confirmed.status_code == 200

    response = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}",
        json={"confirmation": "candidate"},
    )
    assert response.status_code == 400
    assert "已确认记录" in response.json()["detail"]

    # 其他字段仍然可以正常更新。
    patched = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}",
        json={"statement": "确认后的补充说明"},
    )
    assert patched.status_code == 200
    assert patched.json()["confirmation"] == "confirmed"


@pytest.mark.asyncio
async def test_rejection_is_allowed_without_deleting(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    fact = await _create_fact(client, project_id)

    rejected = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}",
        json={"confirmation": "rejected"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["confirmation"] == "rejected"

    # 被拒绝的记录仍然存在，没有被静默删除。
    listed = await client.get(BASE.format(project_id=project_id) + "/world-facts")
    assert listed.json()["total"] == 1


# --- 取代 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_supersede_retires_old_fact_and_keeps_the_row(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    original = await _create_fact(client, project_id, "国王仍然在世")
    replacement = await _create_fact(client, project_id, "国王已于三年前病逝")

    response = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{original['id']}",
        json={"superseded_by_id": replacement["id"]},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["superseded_by_id"] == replacement["id"]
    assert data["status"] == "retired"

    listed = await client.get(
        BASE.format(project_id=project_id)
        + "/world-facts?status=retired&limit=50&offset=0"
    )
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["id"] == original["id"]


@pytest.mark.asyncio
async def test_supersede_rejects_self_and_other_project_target(client: AsyncClient) -> None:
    project_id = await _create_project(client, "项目甲")
    fact = await _create_fact(client, project_id)

    other_project = await _create_project(client, "项目乙")
    other_fact = await _create_fact(client, other_project, "别国的事实")

    self_reference = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}",
        json={"superseded_by_id": fact["id"]},
    )
    assert self_reference.status_code == 400

    cross_project = await client.patch(
        BASE.format(project_id=project_id) + f"/world-facts/{fact['id']}",
        json={"superseded_by_id": other_fact["id"]},
    )
    assert cross_project.status_code == 400
    assert "取代事实" in cross_project.json()["detail"]


# --- 溯源 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_provenance_is_persisted_and_validated(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)

    created = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={
            "statement": "北城由三大家族共治",
            "source_type": "chapter",
            "source_id": chapter_id,
            "source_chapter_id": chapter_id,
            "quote_anchor": "第 3 段",
            "created_by": "agent:story-keeper",
            "confidence": 0.42,
            "confirmation": "candidate",
        },
    )
    assert created.status_code == 201
    data = created.json()
    assert data["source_type"] == "chapter"
    assert data["source_id"] == chapter_id
    assert data["source_chapter_id"] == chapter_id
    assert data["quote_anchor"] == "第 3 段"
    assert data["created_by"] == "agent:story-keeper"
    assert data["confidence"] == pytest.approx(0.42)

    invalid_source = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={"statement": "来源非法", "source_type": "middle-earth"},
    )
    assert invalid_source.status_code == 422


@pytest.mark.asyncio
async def test_source_reference_must_belong_to_the_project(client: AsyncClient) -> None:
    project_id = await _create_project(client, "项目甲")
    other_project = await _create_project(client, "项目乙")
    other_chapter = await _create_chapter(client, other_project, "别国章节")

    response = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={
            "statement": "引用了别的项目",
            "source_type": "chapter",
            "source_id": other_chapter,
        },
    )
    assert response.status_code == 400
    assert "当前项目" in response.json()["detail"]


@pytest.mark.asyncio
async def test_provenance_supports_outline_and_world_info_sources(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    outline_id = await _create_outline(client, project_id)
    entry_id = await _create_world_entry(client, project_id)

    from_outline = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={"statement": "来自大纲", "source_type": "outline", "source_id": outline_id},
    )
    assert from_outline.status_code == 201
    assert from_outline.json()["source_type"] == "outline"

    from_world = await client.post(
        BASE.format(project_id=project_id) + "/world-facts",
        json={"statement": "来自世界设定", "source_type": "world_info", "source_id": entry_id},
    )
    assert from_world.status_code == 201
    assert from_world.json()["source_id"] == entry_id


# --- 分页与隔离 -------------------------------------------------------------


@pytest.mark.asyncio
async def test_world_fact_list_filters_and_paginates(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    for index in range(3):
        await _create_fact(client, project_id, f"事实 {index}")

    first_page = await client.get(
        BASE.format(project_id=project_id) + "/world-facts?limit=2&offset=0"
    )
    assert first_page.status_code == 200
    assert first_page.json()["total"] == 3
    assert len(first_page.json()["items"]) == 2
    assert first_page.json()["limit"] == 2

    second_page = await client.get(
        BASE.format(project_id=project_id) + "/world-facts?limit=2&offset=2"
    )
    assert len(second_page.json()["items"]) == 1

    # 超出上限的 limit 被夹到 200，不会退化成整表扫描。
    clamped = await client.get(
        BASE.format(project_id=project_id) + "/world-facts?limit=100000"
    )
    assert clamped.json()["limit"] == 200

    filtered = await client.get(
        BASE.format(project_id=project_id) + "/world-facts?confirmation=confirmed"
    )
    assert filtered.json()["total"] == 0


@pytest.mark.asyncio
async def test_cross_project_reads_and_writes_are_isolated(client: AsyncClient) -> None:
    project_id = await _create_project(client, "项目甲")
    fact = await _create_fact(client, project_id)
    other_project = await _create_project(client, "项目乙")

    missing = await client.get(
        BASE.format(project_id=other_project) + f"/world-facts/{fact['id']}"
    )
    assert missing.status_code == 404

    patched = await client.patch(
        BASE.format(project_id=other_project) + f"/world-facts/{fact['id']}",
        json={"statement": "越权改写"},
    )
    assert patched.status_code == 404

    assert (
        await client.get(BASE.format(project_id=other_project) + "/world-facts")
    ).json()["total"] == 0

    unknown_project = await client.get(
        BASE.format(project_id="does-not-exist") + "/world-facts"
    )
    assert unknown_project.status_code == 404


# --- 人物信念 ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_confirmed_mistaken_belief_stays_a_belief(client: AsyncClient) -> None:
    """已确认的信念依然可以是错的：事实与信念绝不互相推导。"""
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)
    chapter_id = await _create_chapter(client, project_id)

    created = await client.post(
        BASE.format(project_id=project_id) + "/character-beliefs",
        json={
            "character_id": character_id,
            "proposition": "父亲仍然活着",
            "belief_state": "mistaken",
            "learned_at_chapter_id": chapter_id,
            "confidence": 0.9,
        },
    )
    assert created.status_code == 201
    belief = created.json()
    assert belief["belief_state"] == "mistaken"
    assert belief["learned_at_chapter_id"] == chapter_id
    assert belief["confirmation"] == "candidate"

    confirmed = await client.post(
        BASE.format(project_id=project_id) + f"/character-beliefs/{belief['id']}/confirm",
        json={"expected_updated_at": belief["updated_at"]},
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["confirmation"] == "confirmed"
    # 确认的是「人物确实相信这件事」，不改变命题为错误的事实。
    assert confirmed.json()["belief_state"] == "mistaken"

    # 信念不等于事实：世界里没有因此多出一条世界事实。
    assert (
        await client.get(BASE.format(project_id=project_id) + "/world-facts")
    ).json()["total"] == 0


@pytest.mark.asyncio
async def test_character_belief_rejects_character_from_other_project(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client, "项目甲")
    other_project = await _create_project(client, "项目乙")
    other_character = await _create_character(client, other_project, "外部角色")

    response = await client.post(
        BASE.format(project_id=project_id) + "/character-beliefs",
        json={"character_id": other_character, "proposition": "越权信念"},
    )
    assert response.status_code == 400
    assert "关联人物" in response.json()["detail"]


@pytest.mark.asyncio
async def test_character_belief_supersede_invalidates_without_deleting(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)

    old = (
        await client.post(
            BASE.format(project_id=project_id) + "/character-beliefs",
            json={"character_id": character_id, "proposition": "船在港口"},
        )
    ).json()
    new = (
        await client.post(
            BASE.format(project_id=project_id) + "/character-beliefs",
            json={"character_id": character_id, "proposition": "船已离港"},
        )
    ).json()

    response = await client.patch(
        BASE.format(project_id=project_id) + f"/character-beliefs/{old['id']}",
        json={"superseded_by_id": new["id"]},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["superseded_by_id"] == new["id"]
    assert data["invalidated_at"] is not None

    listed = await client.get(
        BASE.format(project_id=project_id) + f"/character-beliefs?character_id={character_id}"
    )
    assert listed.json()["total"] == 2

    # 显式失效：清空 invalidated_at 是允许的安全回退。
    restored = await client.patch(
        BASE.format(project_id=project_id) + f"/character-beliefs/{old['id']}",
        json={"invalidated_at": None},
    )
    assert restored.status_code == 200
    assert restored.json()["invalidated_at"] is None


@pytest.mark.asyncio
async def test_character_belief_requires_character_and_proposition(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    missing_proposition = await client.post(
        BASE.format(project_id=project_id) + "/character-beliefs",
        json={"character_id": "someone"},
    )
    assert missing_proposition.status_code == 422

    unknown_character = await client.post(
        BASE.format(project_id=project_id) + "/character-beliefs",
        json={"character_id": "missing", "proposition": "命题"},
    )
    assert unknown_character.status_code == 400


# --- 情节线 -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_plotline_resolve_and_related_ids(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)
    outline_id = await _create_outline(client, project_id)
    chapter_id = await _create_chapter(client, project_id)

    created = await client.post(
        BASE.format(project_id=project_id) + "/plotlines",
        json={
            "title": "失踪的兄长",
            "description": "主角追查兄长下落",
            "current_question": "兄长是否还活着",
            "payoff": "兄长成为最终反派",
            "introduced_chapter_id": chapter_id,
            "related_character_ids": [character_id],
            "related_outline_ids": [outline_id],
            "state": "progressing",
        },
    )
    assert created.status_code == 201
    plotline = created.json()
    assert plotline["state"] == "progressing"
    assert plotline["introduced_chapter_id"] == chapter_id
    assert plotline["related_character_ids"] == [character_id]
    assert plotline["related_outline_ids"] == [outline_id]

    resolved = await client.patch(
        BASE.format(project_id=project_id) + f"/plotlines/{plotline['id']}",
        json={"state": "resolved"},
    )
    assert resolved.status_code == 200
    assert resolved.json()["state"] == "resolved"

    listed = await client.get(BASE.format(project_id=project_id) + "/plotlines?state=resolved")
    assert listed.json()["total"] == 1


@pytest.mark.asyncio
async def test_plotline_rejects_related_entities_from_other_project(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client, "项目甲")
    other_project = await _create_project(client, "项目乙")
    other_character = await _create_character(client, other_project, "外部角色")
    other_outline = await _create_outline(client, other_project)

    bad_character = await client.post(
        BASE.format(project_id=project_id) + "/plotlines",
        json={"title": "越权情节线", "related_character_ids": [other_character]},
    )
    assert bad_character.status_code == 400
    assert "关联人物" in bad_character.json()["detail"]

    bad_outline = await client.post(
        BASE.format(project_id=project_id) + "/plotlines",
        json={"title": "越权情节线", "related_outline_ids": [other_outline]},
    )
    assert bad_outline.status_code == 400
    assert "关联大纲" in bad_outline.json()["detail"]


# --- 场景计划 ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_scene_plan_round_trip_and_unique_index(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)
    pov = await _create_character(client, project_id, "视角人物")
    other = await _create_character(client, project_id, "配角")
    plotline = (
        await client.post(
            BASE.format(project_id=project_id) + "/plotlines",
            json={"title": "主线"},
        )
    ).json()

    created = await client.post(
        BASE.format(project_id=project_id) + "/scene-plans",
        json={
            "chapter_id": chapter_id,
            "scene_index": 0,
            "goal": "主角拿到信件",
            "pov_character_id": pov,
            "location": "北城邮局",
            "tone": "压抑",
            "preconditions": ["邮局尚未关门"],
            "participants": [pov, other],
            "character_goals": [{"character_id": pov, "goal": "取信"}],
            "known_information": ["信件寄自南港"],
            "hidden_information": ["信是伪造的"],
            "active_plotline_ids": [plotline["id"]],
            "world_constraints": ["北城不许夜间出门"],
            "expected_changes": ["主角得知兄长失踪"],
            "result": {"fact_changes": ["信件内容被读出"], "plotline_changes": ["主线推进"]},
        },
    )
    assert created.status_code == 201
    plan = created.json()
    assert plan["pov_character_id"] == pov
    assert plan["participants"] == [pov, other]
    assert plan["character_goals"] == [{"character_id": pov, "goal": "取信"}]
    assert plan["active_plotline_ids"] == [plotline["id"]]
    assert plan["result"]["fact_changes"] == ["信件内容被读出"]
    assert plan["result"]["state_changes"] == []

    duplicate = await client.post(
        BASE.format(project_id=project_id) + "/scene-plans",
        json={"chapter_id": chapter_id, "scene_index": 0, "goal": "重复场景"},
    )
    assert duplicate.status_code == 409

    moved = await client.patch(
        BASE.format(project_id=project_id) + f"/scene-plans/{plan['id']}",
        json={"scene_index": 1, "goal": "改到第二个场景"},
    )
    assert moved.status_code == 200
    assert moved.json()["scene_index"] == 1
    assert moved.json()["goal"] == "改到第二个场景"

    # 章节内序号唯一：移动到已被占用的序号必须失败。
    await client.post(
        BASE.format(project_id=project_id) + "/scene-plans",
        json={"chapter_id": chapter_id, "scene_index": 0, "goal": "原第零个场景"},
    )
    collide = await client.patch(
        BASE.format(project_id=project_id) + f"/scene-plans/{plan['id']}",
        json={"scene_index": 0},
    )
    assert collide.status_code == 409

    listed = await client.get(
        BASE.format(project_id=project_id) + f"/scene-plans?chapter_id={chapter_id}"
    )
    assert listed.json()["total"] == 2


@pytest.mark.asyncio
async def test_scene_plan_rejects_cross_project_references(client: AsyncClient) -> None:
    project_id = await _create_project(client, "项目甲")
    chapter_id = await _create_chapter(client, project_id)
    other_project = await _create_project(client, "项目乙")
    other_character = await _create_character(client, other_project, "外部角色")
    other_plotline = (
        await client.post(
            BASE.format(project_id=other_project) + "/plotlines",
            json={"title": "别国主线"},
        )
    ).json()

    bad_pov = await client.post(
        BASE.format(project_id=project_id) + "/scene-plans",
        json={"chapter_id": chapter_id, "pov_character_id": other_character},
    )
    assert bad_pov.status_code == 400

    bad_plotline = await client.post(
        BASE.format(project_id=project_id) + "/scene-plans",
        json={"chapter_id": chapter_id, "active_plotline_ids": [other_plotline["id"]]},
    )
    assert bad_plotline.status_code == 400
    assert "情节线" in bad_plotline.json()["detail"]

    bad_chapter = await client.post(
        BASE.format(project_id=project_id) + "/scene-plans",
        json={"chapter_id": "missing-chapter"},
    )
    assert bad_chapter.status_code == 400


# --- 删除与级联 -------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_scene_plan(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)
    plan = (
        await client.post(
            BASE.format(project_id=project_id) + "/scene-plans",
            json={"chapter_id": chapter_id, "scene_index": 0},
        )
    ).json()

    assert (
        await client.delete(
            BASE.format(project_id=project_id) + f"/scene-plans/{plan['id']}"
        )
    ).status_code == 204
    assert (
        await client.get(BASE.format(project_id=project_id) + "/scene-plans")
    ).json()["total"] == 0


@pytest.mark.asyncio
async def test_delete_project_removes_all_narrative_records(
    client: AsyncClient, session: AsyncSession
) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)
    chapter_id = await _create_chapter(client, project_id)

    await _create_fact(client, project_id)
    await client.post(
        BASE.format(project_id=project_id) + "/character-beliefs",
        json={"character_id": character_id, "proposition": "命题"},
    )
    await client.post(
        BASE.format(project_id=project_id) + "/plotlines", json={"title": "主线"}
    )
    await client.post(
        BASE.format(project_id=project_id) + "/scene-plans",
        json={"chapter_id": chapter_id, "scene_index": 0},
    )

    deleted = await client.delete(f"/api/v1/projects/{project_id}")
    assert deleted.status_code == 204

    for model in (WorldFact, CharacterBelief, Plotline, ScenePlan):
        remaining = await session.scalar(
            select(func.count()).select_from(model).where(model.project_id == project_id)
        )
        assert remaining == 0, f"{model.__tablename__} 仍残留项目数据"
