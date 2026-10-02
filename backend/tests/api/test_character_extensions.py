# -*- coding: utf-8 -*-
"""人物扩展字段与动态状态 API 测试。"""

import pytest
from httpx import AsyncClient


async def _create_project(client: AsyncClient, title: str = "人物扩展测试") -> str:
    response = await client.post("/api/v1/projects", data={"title": title})
    assert response.status_code == 201
    return response.json()["id"]


async def _create_character(client: AsyncClient, project_id: str, name: str = "林洛") -> str:
    response = await client.post(
        f"/api/v1/projects/{project_id}/characters",
        data={"name": name, "description": "主角"},
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


@pytest.mark.asyncio
async def test_get_profile_returns_empty_defaults(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)

    response = await client.get(f"/api/v1/characters/{character_id}/profile")

    assert response.status_code == 200
    data = response.json()
    assert data["character_id"] == character_id
    assert data["alias"] == ""
    assert data["arc"] == ""


@pytest.mark.asyncio
async def test_update_and_persist_profile_fields(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)

    payload = {
        "alias": "小洛",
        "age": "24",
        "gender": "男",
        "identity": "记者",
        "faction": "调查局",
        "personality": "固执",
        "appearance": "左肩有旧伤",
        "background": "失去部分记忆",
        "goal": "找到导师留下的资料",
        "motivation": "查明真相",
        "fear": "再次失忆",
        "secret": "曾参与实验",
        "abilities": "过目不忘",
        "weakness": "不擅近战",
        "arc": "从逃避到承担",
    }
    response = await client.put(
        f"/api/v1/characters/{character_id}/profile", json=payload
    )
    assert response.status_code == 200
    assert response.json()["identity"] == "记者"

    reloaded = await client.get(f"/api/v1/characters/{character_id}/profile")
    assert reloaded.json()["secret"] == "曾参与实验"

    # 再次更新为整体覆盖，未提供的字段回到默认空值
    overwritten = await client.put(
        f"/api/v1/characters/{character_id}/profile", json={"goal": "新目标"}
    )
    assert overwritten.status_code == 200
    assert overwritten.json()["goal"] == "新目标"
    assert overwritten.json()["identity"] == ""


@pytest.mark.asyncio
async def test_profile_of_unknown_character_returns_404(client: AsyncClient) -> None:
    response = await client.get("/api/v1/characters/missing/profile")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_project_level_state_upsert_reuses_single_row(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)

    first = await client.put(
        f"/api/v1/characters/{character_id}/states",
        json={
            "location": "北城",
            "physical_state": "左肩受伤",
            "mental_state": "怀疑苏璃",
            "goal": "找到资料",
            "relationship_note": "与苏璃关系恶化",
        },
    )
    assert first.status_code == 200
    assert first.json()["chapter_id"] is None
    state_id = first.json()["id"]

    second = await client.put(
        f"/api/v1/characters/{character_id}/states",
        json={"location": "南港", "physical_state": "", "mental_state": "", "goal": ""},
    )
    assert second.status_code == 200
    assert second.json()["id"] == state_id
    assert second.json()["location"] == "南港"

    listed = await client.get(f"/api/v1/characters/{character_id}/states")
    assert listed.status_code == 200
    assert listed.json()["total"] == 1


@pytest.mark.asyncio
async def test_chapter_scoped_state_is_stored_separately(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    chapter = (
        await client.post(
            f"/api/v1/projects/{project_id}/chapters",
            json={"volume_id": volumes[0]["id"], "title": "第一章", "content": "正文"},
        )
    ).json()

    response = await client.put(
        f"/api/v1/characters/{character_id}/states",
        json={"chapter_id": chapter["id"], "location": "学院", "mental_state": "紧张"},
    )
    assert response.status_code == 200
    assert response.json()["chapter_id"] == chapter["id"]

    listed = await client.get(f"/api/v1/characters/{character_id}/states")
    assert listed.json()["total"] == 1


@pytest.mark.asyncio
async def test_state_rejects_chapter_from_other_project(client: AsyncClient) -> None:
    project_id = await _create_project(client, "项目甲")
    character_id = await _create_character(client, project_id)
    other_project = await _create_project(client, "项目乙")
    other_volumes = (await client.get(f"/api/v1/projects/{other_project}/volumes")).json()
    other_chapter = (
        await client.post(
            f"/api/v1/projects/{other_project}/chapters",
            json={"volume_id": other_volumes[0]["id"], "title": "外部章节", "content": "正文"},
        )
    ).json()

    response = await client.put(
        f"/api/v1/characters/{character_id}/states",
        json={"chapter_id": other_chapter["id"], "location": "别处"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_state_and_cascade_on_character_delete(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)

    created = (
        await client.put(
            f"/api/v1/characters/{character_id}/states", json={"location": "北城"}
        )
    ).json()

    deleted = await client.delete(
        f"/api/v1/characters/{character_id}/states/{created['id']}"
    )
    assert deleted.status_code == 204
    assert (await client.get(f"/api/v1/characters/{character_id}/states")).json()["total"] == 0

    await client.put(f"/api/v1/characters/{character_id}/states", json={"location": "南港"})
    await client.put(f"/api/v1/characters/{character_id}/profile", json={"alias": "小洛"})

    assert (await client.delete(f"/api/v1/characters/{character_id}")).status_code == 204
    assert (await client.get(f"/api/v1/characters/{character_id}/states")).status_code == 404


@pytest.mark.asyncio
async def test_delete_character_removes_world_entry_meta_links(client: AsyncClient) -> None:
    """删除单个角色时从世界设定扩展信息中移除该关联，保留其他关联。"""
    project_id = await _create_project(client)
    removed = await _create_character(client, project_id, "待删除角色")
    kept = await _create_character(client, project_id, "保留角色")
    entry_id = await _create_world_entry(client, project_id)
    saved = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"linked_character_ids": [removed, kept]},
    )
    assert saved.status_code == 200
    assert saved.json()["linked_character_ids"] == [removed, kept]

    deleted = await client.delete(f"/api/v1/characters/{removed}")
    assert deleted.status_code == 204

    meta = (await client.get(f"/api/v1/world-info-entries/{entry_id}/meta")).json()
    assert meta["linked_character_ids"] == [kept]


@pytest.mark.asyncio
async def test_batch_delete_characters_removes_world_entry_meta_links(
    client: AsyncClient,
) -> None:
    """批量删除角色时移除全部已删除关联，保留未删除的关联。"""
    project_id = await _create_project(client)
    first = await _create_character(client, project_id, "角色一")
    second = await _create_character(client, project_id, "角色二")
    kept = await _create_character(client, project_id, "保留角色")
    entry_id = await _create_world_entry(client, project_id)
    await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"linked_character_ids": [first, second, kept]},
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/characters/batch/delete",
        json={"character_ids": [first, second]},
    )
    assert response.status_code == 200
    assert response.json()["deleted_count"] == 2

    meta = (await client.get(f"/api/v1/world-info-entries/{entry_id}/meta")).json()
    assert meta["linked_character_ids"] == [kept]
