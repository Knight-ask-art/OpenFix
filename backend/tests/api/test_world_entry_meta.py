# -*- coding: utf-8 -*-
"""世界设定扩展信息 API 测试。"""

import json

import pytest
from httpx import AsyncClient


async def _create_project(client: AsyncClient, title: str = "世界设定测试") -> str:
    response = await client.post("/api/v1/projects", data={"title": title})
    assert response.status_code == 201
    return response.json()["id"]


async def _create_entry(client: AsyncClient, project_id: str, name: str = "北城") -> str:
    world_info = (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()
    response = await client.post(
        f"/api/v1/world-info/{world_info['id']}/entries",
        json={"name": name, "content": "北方主城，常年阴雨。"},
    )
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


@pytest.mark.asyncio
async def test_get_meta_returns_defaults(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    entry_id = await _create_entry(client, project_id)

    response = await client.get(f"/api/v1/world-info-entries/{entry_id}/meta")

    assert response.status_code == 200
    data = response.json()
    assert data["entry_id"] == entry_id
    assert data["project_id"] == project_id
    assert data["entry_type"] == "custom"
    assert data["tags"] == []
    assert data["ai_visible"] is True


@pytest.mark.asyncio
async def test_update_meta_with_type_tags_and_links(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    entry_id = await _create_entry(client, project_id)
    character = (
        await client.post(
            f"/api/v1/projects/{project_id}/characters",
            data={"name": "林洛", "description": "记者"},
        )
    ).json()
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    chapter = (
        await client.post(
            f"/api/v1/projects/{project_id}/chapters",
            json={"volume_id": volumes[0]["id"], "title": "第一章", "content": "正文"},
        )
    ).json()

    response = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={
            "entry_type": "location",
            "tags": ["北城", "北城", " 主城 "],
            "linked_character_ids": [character["id"]],
            "linked_chapter_ids": [chapter["id"]],
            "ai_visible": False,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["entry_type"] == "location"
    assert data["tags"] == ["北城", "主城"]
    assert data["linked_character_ids"] == [character["id"]]
    assert data["linked_chapter_ids"] == [chapter["id"]]
    assert data["ai_visible"] is False

    listed = await client.get(f"/api/v1/projects/{project_id}/world-entry-meta")
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["entry_id"] == entry_id


@pytest.mark.asyncio
async def test_update_meta_rejects_unknown_type(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    entry_id = await _create_entry(client, project_id)

    response = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"entry_type": "not_a_type"},
    )
    assert response.status_code == 400
    assert "设定类型" in response.json()["detail"]


@pytest.mark.asyncio
async def test_update_meta_rejects_character_from_other_project(client: AsyncClient) -> None:
    project_id = await _create_project(client, "项目甲")
    entry_id = await _create_entry(client, project_id)
    other_project = await _create_project(client, "项目乙")
    other_character = (
        await client.post(
            f"/api/v1/projects/{other_project}/characters",
            data={"name": "外部角色", "description": ""},
        )
    ).json()

    response = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"linked_character_ids": [other_character["id"]]},
    )
    assert response.status_code == 400
    assert "关联人物" in response.json()["detail"]


@pytest.mark.asyncio
async def test_delete_entry_cascades_meta(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    entry_id = await _create_entry(client, project_id)
    await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"entry_type": "organization"},
    )

    deleted = await client.delete(f"/api/v1/world-info-entries/{entry_id}")
    assert deleted.status_code == 204

    listed = await client.get(f"/api/v1/projects/{project_id}/world-entry-meta")
    assert listed.json()["total"] == 0


@pytest.mark.asyncio
async def test_batch_delete_entries_cascades_meta(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    world_info = (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()
    first = await _create_entry(client, project_id, "条目一")
    second = await _create_entry(client, project_id, "条目二")
    await client.put(
        f"/api/v1/world-info-entries/{first}/meta", json={"entry_type": "rule"}
    )
    await client.put(
        f"/api/v1/world-info-entries/{second}/meta", json={"entry_type": "history"}
    )

    response = await client.post(
        f"/api/v1/world-info/{world_info['id']}/entries/batch/delete",
        json={"entry_ids": [first, second]},
    )
    assert response.status_code == 200
    assert response.json()["deleted_count"] == 2

    listed = await client.get(f"/api/v1/projects/{project_id}/world-entry-meta")
    assert listed.json()["total"] == 0


@pytest.mark.asyncio
async def test_batch_delete_ignores_entries_from_other_world(client: AsyncClient) -> None:
    """删除别的项目条目的 ID 时，不应误删对方条目的扩展信息。"""
    project_a = await _create_project(client, "项目甲")
    world_info_a = (await client.get(f"/api/v1/projects/{project_a}/world-info")).json()

    project_b = await _create_project(client, "项目乙")
    entry_b = await _create_entry(client, project_b, "乙世界条目")
    await client.put(
        f"/api/v1/world-info-entries/{entry_b}/meta",
        json={"entry_type": "location", "tags": ["西城"]},
    )

    response = await client.post(
        f"/api/v1/world-info/{world_info_a['id']}/entries/batch/delete",
        json={"entry_ids": [entry_b]},
    )
    assert response.status_code == 200
    assert response.json()["deleted_count"] == 0

    survived_entry = await client.get(f"/api/v1/world-info-entries/{entry_b}")
    assert survived_entry.status_code == 200

    survived_meta = await client.get(f"/api/v1/world-info-entries/{entry_b}/meta")
    assert survived_meta.status_code == 200
    assert survived_meta.json()["entry_id"] == entry_b
    assert survived_meta.json()["entry_type"] == "location"
    assert survived_meta.json()["tags"] == ["西城"]

    listed = await client.get(f"/api/v1/projects/{project_b}/world-entry-meta")
    assert listed.json()["total"] == 1


@pytest.mark.asyncio
async def test_update_character_links_keeps_chapter_links(client: AsyncClient) -> None:
    """只更新关联人物时，已保存的关联章节保持不变。"""
    project_id = await _create_project(client)
    entry_id = await _create_entry(client, project_id)
    character = await _create_character(client, project_id)
    chapter = await _create_chapter(client, project_id)

    saved = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"linked_character_ids": [character], "linked_chapter_ids": [chapter]},
    )
    assert saved.status_code == 200
    assert saved.json()["linked_chapter_ids"] == [chapter]

    response = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"linked_character_ids": []},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["linked_character_ids"] == []
    assert data["linked_chapter_ids"] == [chapter]


@pytest.mark.asyncio
async def test_update_chapter_links_keeps_character_links(client: AsyncClient) -> None:
    """只更新关联章节（含显式清空）时，已保存的关联人物保持不变。"""
    project_id = await _create_project(client)
    entry_id = await _create_entry(client, project_id)
    character = await _create_character(client, project_id)
    first_chapter = await _create_chapter(client, project_id, "第一章")
    second_chapter = await _create_chapter(client, project_id, "第二章")

    saved = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={
            "linked_character_ids": [character],
            "linked_chapter_ids": [first_chapter],
        },
    )
    assert saved.status_code == 200

    replaced = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"linked_chapter_ids": [second_chapter]},
    )
    assert replaced.status_code == 200
    assert replaced.json()["linked_chapter_ids"] == [second_chapter]
    assert replaced.json()["linked_character_ids"] == [character]

    cleared = await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"linked_chapter_ids": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["linked_chapter_ids"] == []
    assert cleared.json()["linked_character_ids"] == [character]

    reloaded = await client.get(f"/api/v1/world-info-entries/{entry_id}/meta")
    assert reloaded.json()["linked_chapter_ids"] == []
    assert reloaded.json()["linked_character_ids"] == [character]


@pytest.mark.asyncio
async def test_delete_world_info_clears_entry_meta(client: AsyncClient) -> None:
    """删除世界书时一并清理其条目的扩展信息。"""
    project_id = await _create_project(client)
    world_info = (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()
    entry_id = await _create_entry(client, project_id)
    await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"entry_type": "location", "tags": ["北城"]},
    )

    deleted = await client.delete(f"/api/v1/world-info/{world_info['id']}")
    assert deleted.status_code == 204

    listed = await client.get(f"/api/v1/projects/{project_id}/world-entry-meta")
    assert listed.status_code == 200
    assert listed.json()["total"] == 0


@pytest.mark.asyncio
async def test_overwrite_import_clears_entry_meta(client: AsyncClient) -> None:
    """覆盖导入清空旧条目时同步清理其扩展信息。"""
    project_id = await _create_project(client)
    world_info = (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()
    entry_id = await _create_entry(client, project_id)
    await client.put(
        f"/api/v1/world-info-entries/{entry_id}/meta",
        json={"entry_type": "location"},
    )
    content = json.dumps(
        {
            "entries": {
                "0": {
                    "uid": 0,
                    "comment": "背景",
                    "content": "新世界观",
                    "disable": False,
                    "order": 100,
                }
            }
        }
    ).encode("utf-8")

    response = await client.post(
        f"/api/v1/world-info/{world_info['id']}/entries/import-stream?mode=overwrite",
        files={"file": ("worldbook.json", content, "application/json")},
    )
    assert response.status_code == 200
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert any(event["type"] == "complete" for event in events)

    listed = await client.get(f"/api/v1/projects/{project_id}/world-entry-meta")
    assert listed.status_code == 200
    assert listed.json()["total"] == 0
