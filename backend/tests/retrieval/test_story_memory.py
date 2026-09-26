# -*- coding: utf-8 -*-
"""Story Memory 检索模块测试。"""

import pytest
from httpx import AsyncClient

from app.retrieval.story_memory import (
    build_story_memory_documents,
    compute_story_memory_status,
    story_document_id,
    story_memory_index_key,
)


def test_index_key_and_document_id() -> None:
    assert story_memory_index_key("p1") == "story_memory:p1"
    assert story_document_id("character", "c1") == "character:c1"


async def _create_project_with_entities(client: AsyncClient) -> str:
    project = (
        await client.post("/api/v1/projects", data={"title": "故事记忆小说"})
    ).json()
    project_id = project["id"]

    await client.post(
        f"/api/v1/projects/{project_id}/characters",
        data={"name": "林晚", "description": "沉默寡言的剑客"},
    )
    world_info = (
        await client.get(f"/api/v1/projects/{project_id}/world-info")
    ).json()
    await client.post(
        f"/api/v1/world-info/{world_info['id']}/entries",
        json={"name": "剑冢", "content": "埋剑之地，传闻藏有上古名剑。"},
    )
    await client.post(
        f"/api/v1/projects/{project_id}/outlines",
        json={"level": "book", "title": "主线", "content": "三幕结构。"},
    )
    return project_id


@pytest.mark.asyncio
async def test_build_story_memory_documents_collects_all_sources(
    client: AsyncClient, session
) -> None:
    project_id = await _create_project_with_entities(client)

    documents = await build_story_memory_documents(session, project_id)

    by_prefix = {}
    for doc in documents:
        source = doc.document_id.split(":", 1)[0]
        by_prefix.setdefault(source, []).append(doc)

    assert "character" in by_prefix
    assert "world_entry" in by_prefix
    assert "outline" in by_prefix
    assert "剑冢" in by_prefix["world_entry"][0].text
    assert "三幕结构" in by_prefix["outline"][0].text
    assert all(doc.attributes["project_id"] == project_id for doc in documents)


@pytest.mark.asyncio
async def test_story_memory_status_counts_without_index(client: AsyncClient) -> None:
    project_id = await _create_project_with_entities(client)

    response = await client.get(f"/api/v1/projects/{project_id}/story-memory/status")
    assert response.status_code == 200
    data = response.json()
    assert data["index_status"] == "not_created"
    assert data["embedding_configured"] is False
    assert data["counts"]["characters"] == 1
    assert data["counts"]["world_entries"] == 1
    assert data["counts"]["outlines"] == 1


@pytest.mark.asyncio
async def test_story_memory_rebuild_requires_embedding_model(client: AsyncClient) -> None:
    project_id = (
        await client.post("/api/v1/projects", data={"title": "无模型项目"})
    ).json()["id"]

    response = await client.post(f"/api/v1/projects/{project_id}/story-memory/rebuild")
    assert response.status_code == 400
    assert "模型" in response.json()["detail"]


@pytest.mark.asyncio
async def test_story_memory_status_unknown_project_returns_404(client: AsyncClient) -> None:
    response = await client.get("/api/v1/projects/nonexistent-id/story-memory/status")
    assert response.status_code == 404
