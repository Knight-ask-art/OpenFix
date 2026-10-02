# -*- coding: utf-8 -*-
"""项目产品属性与章节附加信息 API 测试。"""

import pytest
from httpx import AsyncClient

from app.storage.repos import character_extension_repo, world_entry_meta_repo


async def _create_project(client: AsyncClient, title: str = "产品属性项目") -> str:
    response = await client.post("/api/v1/projects", data={"title": title})
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


async def _create_character(client: AsyncClient, project_id: str, name: str = "林洛") -> str:
    response = await client.post(
        f"/api/v1/projects/{project_id}/characters",
        data={"name": name, "description": "主角"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_entry(client: AsyncClient, project_id: str, name: str = "北城") -> str:
    world_info_id = await _world_info_id(client, project_id)
    response = await client.post(
        f"/api/v1/world-info/{world_info_id}/entries",
        json={"name": name, "content": "北方主城，常年阴雨。"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _world_info_id(client: AsyncClient, project_id: str) -> str:
    return (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()["id"]


@pytest.mark.asyncio
async def test_project_profile_defaults(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    response = await client.get(f"/api/v1/projects/{project_id}/profile")

    assert response.status_code == 200
    data = response.json()
    assert data["project_id"] == project_id
    assert data["genre"] == ""
    assert data["target_word_count"] == 0
    assert data["daily_word_goal"] == 0
    assert data["status"] == "drafting"


@pytest.mark.asyncio
async def test_project_profile_update_and_persist(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    updated = await client.put(
        f"/api/v1/projects/{project_id}/profile",
        json={
            "genre": "悬疑",
            "synopsis": "失忆记者调查导师之死",
            "target_word_count": 326000,
            "daily_word_goal": 3000,
            "status": "planning",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["genre"] == "悬疑"

    reloaded = await client.get(f"/api/v1/projects/{project_id}/profile")
    assert reloaded.json()["daily_word_goal"] == 3000
    assert reloaded.json()["status"] == "planning"


@pytest.mark.asyncio
async def test_project_profile_rejects_unknown_status(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    response = await client.put(
        f"/api/v1/projects/{project_id}/profile", json={"status": "unknown"}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_project_profile_unknown_project_returns_404(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/projects/missing/profile")).status_code == 404


@pytest.mark.asyncio
async def test_chapter_meta_defaults_and_update(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)

    initial = await client.get(f"/api/v1/chapters/{chapter_id}/meta")
    assert initial.status_code == 200
    assert initial.json()["status"] == "draft"
    assert initial.json()["target_word_count"] == 0
    assert initial.json()["last_ai_check_at"] is None

    updated = await client.put(
        f"/api/v1/chapters/{chapter_id}/meta",
        json={"status": "writing", "target_word_count": 3500},
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "writing"
    assert updated.json()["target_word_count"] == 3500

    listed = await client.get(f"/api/v1/projects/{project_id}/chapter-meta")
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["chapter_id"] == chapter_id


@pytest.mark.asyncio
async def test_chapter_meta_rejects_unknown_status(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)
    response = await client.put(
        f"/api/v1/chapters/{chapter_id}/meta", json={"status": "nope"}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_chapter_meta_cascades_on_chapter_delete(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)
    await client.put(
        f"/api/v1/chapters/{chapter_id}/meta",
        json={"status": "done", "target_word_count": 2000},
    )

    assert (await client.delete(f"/api/v1/chapters/{chapter_id}")).status_code == 204

    listed = await client.get(f"/api/v1/projects/{project_id}/chapter-meta")
    assert listed.json()["total"] == 0


@pytest.mark.asyncio
async def test_project_profile_cascades_on_project_delete(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    await client.put(
        f"/api/v1/projects/{project_id}/profile", json={"genre": "科幻"}
    )

    assert (await client.delete(f"/api/v1/projects/{project_id}")).status_code == 204

    assert (await client.get(f"/api/v1/projects/{project_id}/profile")).status_code == 404


@pytest.mark.asyncio
async def test_project_delete_removes_character_and_world_extensions(
    client: AsyncClient, session
) -> None:
    """删除项目时清理人物扩展字段、动态状态与世界设定扩展信息。"""
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)
    await client.put(f"/api/v1/characters/{character_id}/profile", json={"alias": "小洛"})
    await client.put(f"/api/v1/characters/{character_id}/states", json={"location": "北城"})
    entry_id = await _create_entry(client, project_id)
    await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"entry_type": "location", "linked_character_ids": [character_id]},
    )

    assert (await client.delete(f"/api/v1/projects/{project_id}")).status_code == 204

    assert await character_extension_repo.get_profile(session, character_id) is None
    assert await character_extension_repo.list_states(session, character_id) == []
    assert await world_entry_meta_repo.get_by_entry_id(session, entry_id) is None


@pytest.mark.asyncio
async def test_chapter_delete_removes_chapter_states_and_entry_links(
    client: AsyncClient,
) -> None:
    """删除单章时清理章节态人物状态并解除世界设定章节关联。"""
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)
    character_id = await _create_character(client, project_id)
    entry_id = await _create_entry(client, project_id)
    await client.put(
        f"/api/v1/characters/{character_id}/states",
        json={"chapter_id": chapter_id, "location": "学院"},
    )
    await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={
            "linked_character_ids": [character_id],
            "linked_chapter_ids": [chapter_id],
        },
    )

    assert (await client.delete(f"/api/v1/chapters/{chapter_id}")).status_code == 204

    states = await client.get(f"/api/v1/characters/{character_id}/states")
    assert states.json()["total"] == 0
    meta = await client.get(f"/api/v1/world-info-entries/{entry_id}/meta")
    assert meta.json()["linked_chapter_ids"] == []
    assert meta.json()["linked_character_ids"] == [character_id]


@pytest.mark.asyncio
async def test_volume_cascade_delete_removes_chapter_states_and_entry_links(
    client: AsyncClient,
) -> None:
    """删除卷（级联）时同样清理章节态人物状态与章节关联。"""
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)
    volume_id = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()[0]["id"]
    await client.post(f"/api/v1/projects/{project_id}/volumes", json={"title": "第二卷"})
    character_id = await _create_character(client, project_id)
    entry_id = await _create_entry(client, project_id)
    await client.put(
        f"/api/v1/characters/{character_id}/states",
        json={"chapter_id": chapter_id, "location": "学院"},
    )
    await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"linked_chapter_ids": [chapter_id]},
    )

    response = await client.delete(f"/api/v1/volumes/{volume_id}?cascade=true")
    assert response.status_code == 204

    states = await client.get(f"/api/v1/characters/{character_id}/states")
    assert states.json()["total"] == 0
    meta = await client.get(f"/api/v1/world-info-entries/{entry_id}/meta")
    assert meta.json()["linked_chapter_ids"] == []
