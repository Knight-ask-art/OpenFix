# -*- coding: utf-8 -*-
"""
Project API 测试。
"""

from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.persistence import repo as agent_run_repo
from app.agent_runtime.persistence.child_runs import create_child_run
from app.agent_runtime.persistence.model import (
    AgentChildRun,
    AgentChildRunRequest,
    AgentContextCompaction,
    AgentRunMessage,
    PlanRecord,
    PlanTodoRecord,
)
from app.storage.models.agent_rule import AgentRule
from app.storage.models.chapter_summary import ChapterSummary
from app.storage.models.character import Character
from app.storage.models.llm_audit_log import LLMAuditLog
from app.storage.models.note import Note, NoteCategory
from app.storage.models.outline import Outline
from app.storage.models.retrieval_chapter_index_state import RetrievalChapterIndexState
from app.storage.models.retrieval_index import RetrievalIndex
from app.storage.models.task import Task
from app.storage.models.task_message import TaskMessage
from app.storage.models.world_info import WorldInfo
from app.storage.models.world_info_entry import WorldInfoEntry
from app.storage.models.writing_activity_event import WritingActivityEvent
from app.storage.services import task_service


@pytest.mark.asyncio
async def test_create_project(client: AsyncClient) -> None:
    """测试创建项目。"""
    response = await client.post(
        "/api/v1/projects",
        data={"title": "测试小说", "description": "这是一个测试小说"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "测试小说"
    assert data["description"] == "这是一个测试小说"
    assert data["word_count"] == 0
    assert data["chapter_count"] == 0
    assert "id" in data
    assert "created_at" in data
    assert "updated_at" in data


@pytest.mark.asyncio
async def test_create_project_without_description(client: AsyncClient) -> None:
    """测试创建不带简介的项目。"""
    response = await client.post(
        "/api/v1/projects",
        data={"title": "无简介小说"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "无简介小说"
    assert data["description"] is None


@pytest.mark.asyncio
async def test_create_project_empty_title(client: AsyncClient) -> None:
    """测试创建项目时标题为空。"""
    response = await client.post(
        "/api/v1/projects",
        data={"title": ""},
    )
    assert response.status_code == 422  # Validation error


@pytest.mark.asyncio
async def test_list_projects_empty(client: AsyncClient) -> None:
    """测试获取空的项目列表。"""
    response = await client.get("/api/v1/projects")
    assert response.status_code == 200
    data = response.json()
    assert data["items"] == []
    assert data["total"] == 0
    assert data["page"] == 1
    assert data["page_size"] == 20


@pytest.mark.asyncio
async def test_list_projects(client: AsyncClient) -> None:
    """测试获取项目列表。"""
    # 创建几个项目
    for i in range(3):
        await client.post(
            "/api/v1/projects",
            data={"title": f"小说 {i + 1}"},
        )

    response = await client.get("/api/v1/projects")
    assert response.status_code == 200
    data = response.json()
    assert len(data["items"]) == 3
    assert data["total"] == 3


@pytest.mark.asyncio
async def test_list_projects_pagination(client: AsyncClient) -> None:
    """测试项目列表分页。"""
    # 创建 5 个项目
    for i in range(5):
        await client.post(
            "/api/v1/projects",
            data={"title": f"小说 {i + 1}"},
        )

    # 获取第一页
    response = await client.get("/api/v1/projects?page=1&page_size=2")
    assert response.status_code == 200
    data = response.json()
    assert len(data["items"]) == 2
    assert data["total"] == 5
    assert data["page"] == 1
    assert data["page_size"] == 2

    # 获取第二页
    response = await client.get("/api/v1/projects?page=2&page_size=2")
    data = response.json()
    assert len(data["items"]) == 2
    assert data["page"] == 2


@pytest.mark.asyncio
async def test_list_projects_search_and_sort(client: AsyncClient) -> None:
    """测试项目列表的服务端搜索和排序。"""
    await client.post(
        "/api/v1/projects",
        data={"title": "Zeta 项目", "description": "包含目标词"},
    )
    await client.post(
        "/api/v1/projects",
        data={"title": "Alpha 项目", "description": "普通简介"},
    )
    await client.post(
        "/api/v1/projects",
        data={"title": "Beta 项目", "description": "另一个目标词"},
    )

    search_response = await client.get(
        "/api/v1/projects?search=目标词&page=1&page_size=1",
    )
    assert search_response.status_code == 200
    search_data = search_response.json()
    assert search_data["total"] == 2
    assert len(search_data["items"]) == 1

    sort_response = await client.get(
        "/api/v1/projects?sort_by=title&sort_order=asc&page_size=100",
    )
    assert sort_response.status_code == 200
    assert [item["title"] for item in sort_response.json()["items"]] == [
        "Alpha 项目",
        "Beta 项目",
        "Zeta 项目",
    ]


@pytest.mark.asyncio
async def test_list_projects_supports_pinyin_search_and_sort(client: AsyncClient) -> None:
    """拼音搜索和标题排序应保持与旧客户端一致。"""
    await client.post("/api/v1/projects", data={"title": "中篇项目"})
    await client.post("/api/v1/projects", data={"title": "红星项目", "description": "银河故事"})
    await client.post("/api/v1/projects", data={"title": "阿尔法项目"})

    search_response = await client.get("/api/v1/projects?search=hxxm")
    assert search_response.status_code == 200
    assert [item["title"] for item in search_response.json()["items"]] == ["红星项目"]

    sort_response = await client.get(
        "/api/v1/projects?sort_by=title&sort_order=asc&page_size=100",
    )
    assert sort_response.status_code == 200
    assert [item["title"] for item in sort_response.json()["items"]] == [
        "阿尔法项目",
        "红星项目",
        "中篇项目",
    ]


@pytest.mark.asyncio
async def test_get_project(client: AsyncClient) -> None:
    """测试获取项目详情。"""
    # 创建项目
    create_response = await client.post(
        "/api/v1/projects",
        data={"title": "测试小说", "description": "测试简介"},
    )
    project_id = create_response.json()["id"]

    # 获取项目
    response = await client.get(f"/api/v1/projects/{project_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == project_id
    assert data["title"] == "测试小说"
    assert data["description"] == "测试简介"


@pytest.mark.asyncio
async def test_get_project_not_found(client: AsyncClient) -> None:
    """测试获取不存在的项目。"""
    response = await client.get("/api/v1/projects/nonexistent")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_project(client: AsyncClient) -> None:
    """测试更新项目。"""
    # 创建项目
    create_response = await client.post(
        "/api/v1/projects",
        data={"title": "原标题", "description": "原简介"},
    )
    project_id = create_response.json()["id"]

    # 更新项目
    response = await client.patch(
        f"/api/v1/projects/{project_id}",
        data={"title": "新标题", "description": "新简介"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "新标题"
    assert data["description"] == "新简介"


@pytest.mark.asyncio
async def test_update_project_partial(client: AsyncClient) -> None:
    """测试部分更新项目。"""
    # 创建项目
    create_response = await client.post(
        "/api/v1/projects",
        data={"title": "原标题", "description": "原简介"},
    )
    project_id = create_response.json()["id"]

    # 只更新标题
    response = await client.patch(
        f"/api/v1/projects/{project_id}",
        data={"title": "新标题"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "新标题"
    assert data["description"] == "原简介"  # 简介保持不变


@pytest.mark.asyncio
async def test_update_project_not_found(client: AsyncClient) -> None:
    """测试更新不存在的项目。"""
    response = await client.patch(
        "/api/v1/projects/nonexistent",
        data={"title": "新标题"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_project(client: AsyncClient) -> None:
    """测试删除项目。"""
    # 创建项目
    create_response = await client.post(
        "/api/v1/projects",
        data={"title": "待删除小说"},
    )
    project_id = create_response.json()["id"]

    # 删除项目
    response = await client.delete(f"/api/v1/projects/{project_id}")
    assert response.status_code == 204

    # 确认已删除
    get_response = await client.get(f"/api/v1/projects/{project_id}")
    assert get_response.status_code == 404


@pytest.mark.asyncio
async def test_delete_project_deletes_tasks_and_runtime_data(client, session) -> None:
    create_response = await client.post("/api/v1/projects", data={"title": "待删除项目"})
    project_id = create_response.json()["id"]
    task = await task_service.create_task(
        session,
        project_id=project_id,
        title="待删除任务",
        mode="agent",
        agent_session_id="project-delete-session",
    )
    await create_child_run(
        session,
        parent_session_id="project-delete-session",
        parent_task_id=task.id,
        parent_thread_id="project-delete-session",
        child_thread_id="project-delete-session:child:writer",
        agent_key="writer",
        dispatch_id="writer",
        tool_call_id="tool-writer",
        request={"task": "write", "input": {}, "metadata": {}},
    )
    await agent_run_repo.insert_message(
        session,
        session_id="project-delete-session",
        task_id=task.id,
        project_id=project_id,
        role="assistant",
        content="runtime message",
        status="completed",
    )
    session.add(
        TaskMessage(
            id="project-delete-message",
            task_id=task.id,
            role="assistant",
            content="legacy runtime message",
            tool_calls="[]",
            message_metadata="{}",
        )
    )
    session.add_all(
        [
            AgentContextCompaction(
                session_id="project-delete-session",
                task_id=task.id,
                project_id=project_id,
                start_seq=0,
                end_seq=1,
                summary="runtime summary",
                trigger="manual",
            ),
            PlanRecord(id="project-delete-plan", session_id="project-delete-session"),
            PlanTodoRecord(
                id="project-delete-todo",
                plan_id="project-delete-plan",
                content="runtime todo",
                sort_index=0,
            ),
        ]
    )
    await session.commit()

    with patch(
        "app.api.routers.projects.delete_checkpoints_for_thread",
        new=AsyncMock(return_value=0),
    ) as delete_checkpoints:
        response = await client.delete(f"/api/v1/projects/{project_id}")

    assert response.status_code == 204
    assert delete_checkpoints.await_count == 2
    for model in (
        Task,
        TaskMessage,
        AgentRunMessage,
        AgentChildRun,
        AgentChildRunRequest,
        AgentContextCompaction,
        PlanRecord,
        PlanTodoRecord,
    ):
        result = await session.execute(select(model))
        assert result.scalars().all() == []


@pytest.mark.asyncio
async def test_delete_project_rejects_running_tasks(client, session) -> None:
    create_response = await client.post("/api/v1/projects", data={"title": "运行中项目"})
    project_id = create_response.json()["id"]
    task = await task_service.create_task(
        session,
        project_id=project_id,
        title="运行中任务",
        mode="agent",
        agent_session_id="running-project-session",
    )
    task.is_running = True
    await session.commit()

    response = await client.delete(f"/api/v1/projects/{project_id}")

    assert response.status_code == 409
    assert response.json()["detail"] == "项目存在运行中任务，不能删除"


@pytest.mark.asyncio
async def test_delete_project_not_found(client: AsyncClient) -> None:
    """测试删除不存在的项目。"""
    response = await client.delete("/api/v1/projects/nonexistent")
    assert response.status_code == 404


def _avatar_bytes() -> bytes:
    """生成测试用角色头像。"""
    buffer = BytesIO()
    Image.new("RGB", (32, 32), color="red").save(buffer, format="PNG")
    return buffer.getvalue()


async def _seed_project_owned_data(
    client: AsyncClient,
    session: AsyncSession,
    title: str,
) -> dict[str, str]:
    """创建项目及其私有数据，返回相关 ID。

    覆盖角色、笔记、分类、世界书条目，以及大纲、章节摘要、检索索引状态、
    写作活动事件、项目级规则与 LLM 审计记录。
    """
    project_response = await client.post("/api/v1/projects", data={"title": title})
    assert project_response.status_code == 201
    project_id = project_response.json()["id"]

    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    volume_id = volumes[0]["id"]
    chapter_response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": volume_id, "title": f"{title}章节", "content": "正文"},
    )
    assert chapter_response.status_code == 201
    chapter_id = chapter_response.json()["id"]

    character_response = await client.post(
        f"/api/v1/projects/{project_id}/characters",
        data={"name": f"{title}角色"},
        files={"image": ("avatar.png", _avatar_bytes(), "image/png")},
    )
    assert character_response.status_code == 201
    character = character_response.json()

    category_response = await client.post(
        f"/api/v1/projects/{project_id}/note-categories",
        json={"title": f"{title}分类"},
    )
    assert category_response.status_code == 201
    category_id = category_response.json()["id"]

    note_response = await client.post(
        f"/api/v1/projects/{project_id}/notes",
        json={"title": f"{title}笔记", "content": "", "category_id": category_id},
    )
    assert note_response.status_code == 201

    world_info_response = await client.get(f"/api/v1/projects/{project_id}/world-info")
    assert world_info_response.status_code == 200
    world_info_id = world_info_response.json()["id"]

    entry_response = await client.post(
        f"/api/v1/world-info/{world_info_id}/entries",
        json={"name": f"{title}条目", "content": ""},
    )
    assert entry_response.status_code == 201

    session.add_all(
        [
            Outline(
                project_id=project_id,
                level="book",
                title=f"{title}大纲",
                content="",
            ),
            ChapterSummary(
                project_id=project_id,
                summary_type="chapter",
                status="ready",
                chapter_id=chapter_id,
                volume_id=volume_id,
                chapter_order=1,
                summary=f"{title}章节摘要",
            ),
            ChapterSummary(
                project_id=project_id,
                summary_type="long_term",
                status="ready",
                start_order=1,
                end_order=1,
                summary=f"{title}长期摘要",
            ),
            RetrievalChapterIndexState(
                project_id=project_id,
                chapter_id=chapter_id,
                index_key=f"chapters:{project_id}",
                status="ready",
            ),
            WritingActivityEvent(
                project_id=project_id,
                chapter_id=chapter_id,
                chapter_title=f"{title}章节",
                source="user",
                operation="update",
                word_delta=12,
            ),
            AgentRule(
                title=f"{title}规则",
                content="以第一人称写作",
                scope="project",
                project_id=project_id,
            ),
            LLMAuditLog(
                project_id=project_id,
                operation="chat",
                model_id="test-model",
                status="success",
            ),
        ]
    )
    await session.commit()

    return {
        "project_id": project_id,
        "chapter_id": chapter_id,
        "image_name": character["image_url"].rsplit("/", 1)[-1],
        "category_id": category_id,
        "world_info_id": world_info_id,
    }


@pytest.mark.asyncio
async def test_delete_project_removes_only_its_own_data(
    client: AsyncClient,
    session: AsyncSession,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """删除项目清理其全部私有数据，另一个项目与全局数据保持完整。"""
    import app.core.storage as storage

    images_dir = tmp_path / "character-images"
    monkeypatch.setattr(storage.settings, "character_images_dir", images_dir)

    session.add(AgentRule(title="全局规则", content="保持简洁", scope="global"))
    await session.commit()

    kept = await _seed_project_owned_data(client, session, "保留项目")
    removed = await _seed_project_owned_data(client, session, "删除项目")
    kept_project_id = kept["project_id"]

    response = await client.delete(f"/api/v1/projects/{removed['project_id']}")

    assert response.status_code == 204
    assert (
        await client.get(f"/api/v1/projects/{removed['project_id']}")
    ).status_code == 404
    assert (await client.get(f"/api/v1/projects/{kept_project_id}")).status_code == 200

    characters = (await session.execute(select(Character))).scalars().all()
    assert [character.project_id for character in characters] == [kept_project_id]

    notes = (await session.execute(select(Note))).scalars().all()
    assert [note.project_id for note in notes] == [kept_project_id]

    categories = (await session.execute(select(NoteCategory))).scalars().all()
    assert [category.project_id for category in categories] == [kept_project_id]

    world_infos = (await session.execute(select(WorldInfo))).scalars().all()
    assert [world_info.project_id for world_info in world_infos] == [kept_project_id]

    entries = (await session.execute(select(WorldInfoEntry))).scalars().all()
    assert [entry.world_info_id for entry in entries] == [kept["world_info_id"]]

    outlines = (await session.execute(select(Outline))).scalars().all()
    assert [outline.project_id for outline in outlines] == [kept_project_id]

    summaries = (await session.execute(select(ChapterSummary))).scalars().all()
    assert summaries
    assert {summary.project_id for summary in summaries} == {kept_project_id}
    assert {summary.summary_type for summary in summaries} == {"chapter", "long_term"}

    index_states = (
        await session.execute(select(RetrievalChapterIndexState))
    ).scalars().all()
    assert index_states
    assert {state.project_id for state in index_states} == {kept_project_id}

    activity_events = (
        await session.execute(select(WritingActivityEvent))
    ).scalars().all()
    assert activity_events
    assert {event.project_id for event in activity_events} == {kept_project_id}

    audit_logs = (await session.execute(select(LLMAuditLog))).scalars().all()
    assert audit_logs
    assert {audit_log.project_id for audit_log in audit_logs} == {kept_project_id}

    rules = (await session.execute(select(AgentRule))).scalars().all()
    assert {(rule.scope, rule.project_id) for rule in rules} == {
        ("global", None),
        ("project", kept_project_id),
    }

    assert not (images_dir / removed["image_name"]).exists()
    assert (images_dir / kept["image_name"]).exists()


@pytest.mark.asyncio
async def test_delete_project_removes_chapter_retrieval_documents(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """删除项目时清理其在检索索引中的章节向量，且不影响其它项目向量。"""
    from app.retrieval import chapter_index

    removed = await _seed_project_owned_data(client, session, "删除项目")
    kept = await _seed_project_owned_data(client, session, "保留项目")

    recorded: list[tuple[str, list[str]]] = []

    class RecordingRetrievalService:
        async def delete_documents(
            self, session, index_key: str, document_ids: list[str]
        ) -> None:
            _ = session
            recorded.append((index_key, list(document_ids)))

    monkeypatch.setattr(
        chapter_index, "OpenFicRetrievalService", RecordingRetrievalService
    )

    response = await client.delete(f"/api/v1/projects/{removed['project_id']}")

    assert response.status_code == 204
    # 只清理被删除项目的章节向量，保留项目的向量不受影响。
    assert recorded == [
        (
            f"chapters:{removed['project_id']}",
            [f"chapter:{removed['chapter_id']}"],
        )
    ]
    assert all(
        index_key != f"chapters:{kept['project_id']}" for index_key, _ in recorded
    )


@pytest.mark.asyncio
async def test_delete_project_removes_story_memory_documents(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """删除项目时在源行消失前清理其 Story Memory 向量，且不影响其它项目索引。"""
    from app.retrieval import story_memory

    removed = await _seed_project_owned_data(client, session, "删除项目")
    kept = await _seed_project_owned_data(client, session, "保留项目")

    for project_id in (removed["project_id"], kept["project_id"]):
        session.add(
            RetrievalIndex(
                index_key=story_memory.story_memory_index_key(project_id),
                table_name=f"story_memory_{project_id}",
                status="ready",
                embedding_model_ref_id="test-embedding-model",
                embedding_model_id_snapshot="embed-1",
                embedding_dimensions_snapshot=3,
            )
        )
    await session.commit()

    # 源行仍在时才能派生出被索引的文档 ID，这正是清理必须先于删除的原因。
    expected_document_ids = [
        document.document_id
        for document in await story_memory.build_story_memory_documents(
            session, removed["project_id"]
        )
    ]
    assert expected_document_ids

    recorded: list[tuple[str, list[str]]] = []

    class RecordingRetrievalService:
        async def delete_documents(
            self, session, index_key: str, document_ids: list[str]
        ) -> None:
            _ = session
            recorded.append((index_key, list(document_ids)))

    monkeypatch.setattr(
        story_memory, "OpenFicRetrievalService", RecordingRetrievalService
    )

    response = await client.delete(f"/api/v1/projects/{removed['project_id']}")

    assert response.status_code == 204
    assert recorded == [
        (f"story_memory:{removed['project_id']}", expected_document_ids)
    ]
    assert all(
        index_key != f"story_memory:{kept['project_id']}" for index_key, _ in recorded
    )
