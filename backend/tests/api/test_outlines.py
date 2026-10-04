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


@pytest.mark.asyncio
async def test_update_outline_rejects_level_change_that_breaks_parent(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    book = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "book", "title": "全书"},
        )
    ).json()
    arc = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "arc", "title": "故事弧", "parent_id": book["id"]},
        )
    ).json()

    invalid_child_level = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{arc['id']}",
        json={"level": "book"},
    )

    assert invalid_child_level.status_code == 400


@pytest.mark.asyncio
async def test_update_outline_rejects_parent_level_that_would_break_children(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    book = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "book", "title": "全书"},
        )
    ).json()
    await client.post(
        f"/api/v1/projects/{project_id}/outlines",
        json={"level": "arc", "title": "故事弧", "parent_id": book["id"]},
    )

    invalid_parent_level = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{book['id']}",
        json={"level": "arc"},
    )

    assert invalid_parent_level.status_code == 400


@pytest.mark.asyncio
async def test_reorder_outline_siblings_persists_order_and_rejects_partial_lists(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    first = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "book", "title": "第一条"},
        )
    ).json()
    second = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "book", "title": "第二条"},
        )
    ).json()

    reordered = await client.post(
        f"/api/v1/projects/{project_id}/outlines/reorder",
        json={"parent_id": None, "node_ids": [second["id"], first["id"]]},
    )
    assert reordered.status_code == 200
    assert reordered.json()["updated_count"] == 2

    listed = await client.get(f"/api/v1/projects/{project_id}/outlines")
    roots = [node for node in listed.json()["items"] if node["parent_id"] is None]
    assert [node["id"] for node in roots] == [second["id"], first["id"]]

    partial = await client.post(
        f"/api/v1/projects/{project_id}/outlines/reorder",
        json={"parent_id": None, "node_ids": [first["id"]]},
    )
    assert partial.status_code == 400


@pytest.mark.asyncio
async def test_outline_chapter_link_is_project_scoped_and_can_be_cleared(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    other_project_id = await _create_project(client)
    volume = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()[0]
    chapter_response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": volume["id"], "title": "第一章"},
    )
    assert chapter_response.status_code == 201
    chapter = chapter_response.json()
    node = (
        await client.post(
            f"/api/v1/projects/{project_id}/outlines",
            json={"level": "chapter", "title": "章节大纲"},
        )
    ).json()

    linked = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{node['id']}",
        json={"volume_id": volume["id"], "chapter_id": chapter["id"]},
    )
    assert linked.status_code == 200
    assert linked.json()["volume_id"] == volume["id"]
    assert linked.json()["chapter_id"] == chapter["id"]

    cleared = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{node['id']}",
        json={"volume_id": None, "chapter_id": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["volume_id"] is None
    assert cleared.json()["chapter_id"] is None

    foreign_volume = (await client.get(f"/api/v1/projects/{other_project_id}/volumes")).json()[0]
    wrong_project = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{node['id']}",
        json={"volume_id": foreign_volume["id"]},
    )
    assert wrong_project.status_code == 400


@pytest.mark.asyncio
async def test_outline_chapter_only_update_infers_volume_and_preserves_omitted_links(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    first_volume = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()[0]
    second_volume_response = await client.post(
        f"/api/v1/projects/{project_id}/volumes", json={"title": "第二卷"}
    )
    assert second_volume_response.status_code == 201
    second_volume = second_volume_response.json()
    chapter_response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": second_volume["id"], "title": "第二卷第一章"},
    )
    assert chapter_response.status_code == 201
    chapter = chapter_response.json()
    node_response = await client.post(
        f"/api/v1/projects/{project_id}/outlines",
        json={"level": "chapter", "title": "章节大纲", "volume_id": first_volume["id"]},
    )
    assert node_response.status_code == 201
    node = node_response.json()

    linked = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{node['id']}",
        json={"chapter_id": chapter["id"]},
    )
    assert linked.status_code == 200
    assert linked.json()["volume_id"] == second_volume["id"]
    assert linked.json()["chapter_id"] == chapter["id"]

    edited = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{node['id']}",
        json={"title": "保留关联的标题修改"},
    )
    assert edited.status_code == 200
    assert edited.json()["volume_id"] == second_volume["id"]
    assert edited.json()["chapter_id"] == chapter["id"]

    cleared = await client.patch(
        f"/api/v1/projects/{project_id}/outlines/{node['id']}",
        json={"chapter_id": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["chapter_id"] is None
    assert cleared.json()["volume_id"] == second_volume["id"]
