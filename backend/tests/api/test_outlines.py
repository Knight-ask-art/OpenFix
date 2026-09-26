# -*- coding: utf-8 -*-
"""Outline API 测试。"""

import pytest
from httpx import AsyncClient


async def _create_project(client: AsyncClient) -> str:
    response = await client.post("/api/v1/projects", data={"title": "大纲测试小说"})
    assert response.status_code == 201
    return response.json()["id"]


@pytest.mark.asyncio
async def test_create_and_list_outline_tree(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    book = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "book", "title": "全书主线"},
        )
    ).json()
    arc = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "arc", "title": "第一卷 故事弧", "parent_id": book["id"]},
        )
    ).json()
    chapter_outline = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "chapter", "title": "第一章", "parent_id": arc["id"], "content": "开局"},
        )
    ).json()

    assert book["parent_id"] is None
    assert arc["parent_id"] == book["id"]
    assert chapter_outline["parent_id"] == arc["id"]
    assert chapter_outline["sort_order"] == 1

    listed = await client.get(f"/api/v1/projects/{project_id}/outlines")
    assert listed.status_code == 200
    data = listed.json()
    assert data["total"] == 3
    titles = {item["title"] for item in data["items"]}
    assert titles == {"全书主线", "第一卷 故事弧", "第一章"}


@pytest.mark.asyncio
async def test_create_outline_rejects_invalid_parent_level(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    chapter_outline = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "chapter", "title": "章节节点"},
        )
    ).json()

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines",
        json={"level": "book", "title": "书级子节点", "parent_id": chapter_outline["id"]},
    )
    assert response.status_code == 400
    assert "层级" in response.json()["detail"]


@pytest.mark.asyncio
async def test_create_outline_rejects_parent_from_other_project(client: AsyncClient) -> None:
    first_project = await _create_project(client)
    second_project = await _create_project(client)
    node = (
        await client.post(
            f"/api/v1/projects/{first_project}/outlines",
            json={"level": "book", "title": "A 项目节点"},
        )
    ).json()

    response = await client.post(
        f"/api/v1/projects/{second_project}/outlines",
        json={"level": "arc", "title": "B 项目子节点", "parent_id": node["id"]},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_outline_content_and_title(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    node = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "book", "title": "旧标题", "content": "旧内容"},
        )
    ).json()

    updated = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{node['id']}",
        json={"title": "新标题", "content": "新内容"},
    )
    assert updated.status_code == 200
    data = updated.json()
    assert data["title"] == "新标题"
    assert data["content"] == "新内容"


@pytest.mark.asyncio
async def test_update_outline_rejects_move_into_own_subtree(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    book = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "book", "title": "根"},
        )
    ).json()
    arc = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "arc", "title": "弧", "parent_id": book["id"]},
        )
    ).json()

    response = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{book['id']}",
        json={"parent_id": arc["id"]},
    )
    assert response.status_code == 400
    assert "子节点" in response.json()["detail"]


@pytest.mark.asyncio
async def test_delete_outline_removes_subtree(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    book = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "book", "title": "根"},
        )
    ).json()
    arc = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "arc", "title": "弧", "parent_id": book["id"]},
        )
    ).json()
    await client.post(
        f"/api/v1/projects/{project_id}/outlines",
        json={"level": "chapter", "title": "章", "parent_id": arc["id"]},
    )

    deleted = await client.delete(f"/api/v1/projects/{project_id}/outlines/{book['id']}")
    assert deleted.status_code == 200
    assert deleted.json()["deleted_count"] == 3

    listed = await client.get(f"/api/v1/projects/{project_id}/outlines")
    assert listed.json()["total"] == 0


@pytest.mark.asyncio
async def test_outline_routes_return_404_for_missing_node(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    patched = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/missing-id",
        json={"title": "x"},
    )
    assert patched.status_code == 404

    deleted = await client.delete(f"/api/v1/projects/{project_id}/outlines/missing-id")
    assert deleted.status_code == 404
