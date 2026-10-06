# -*- coding: utf-8 -*-
"""Story Memory 检索模块测试。"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

from app.background.events.publisher import BackgroundEventPublisher
from app.background.jobs.constants import JOB_TYPE_STORY_MEMORY_REBUILD
from app.background.jobs.definitions import story_memory_index as story_memory_job
from app.background.jobs.models import BackgroundJob
from app.background.jobs.states import JOB_STATUS_RUNNING
from app.background.runtime.context import JobContext
from app.retrieval.story_memory import (
    build_story_memory_documents,
    collect_story_memory_source_tokens,
    compute_story_memory_status,
    delete_project_story_memory_documents,
    fingerprint_story_memory_documents,
    fingerprint_story_memory_sources,
    story_document_id,
    story_memory_index_is_fresh,
    story_memory_index_key,
)
from app.retrieval.types import BatchIndexResult
from app.storage.models.retrieval_index import RetrievalIndex
from app.storage.models.note import Note
from app.storage.models.world_info_entry import WorldInfoEntry
from app.storage.repos import (
    note_repo,
    retrieval_index_repo,
    setting_repo,
    world_info_entry_repo,
    world_info_repo,
)
from app.storage.services import world_entry_meta_service, world_info_entry_service

MODEL_REF_ID = "model-ref-story-memory"


async def _current_source_fingerprint(session, project_id: str) -> str:
    """当前源数据快照指纹（ID + updated_at + 可见性 / 确认状态，不读正文）。"""
    return fingerprint_story_memory_sources(
        await collect_story_memory_source_tokens(session, project_id)
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


@pytest.mark.asyncio
async def test_character_profile_and_state_feed_story_memory(
    client: AsyncClient, session
) -> None:
    project_id = (
        await client.post("/api/v1/projects", data={"title": "人物状态记忆"})
    ).json()["id"]
    character = (
        await client.post(
            f"/api/v1/projects/{project_id}/characters",
            data={"name": "林洛", "description": "记者"},
        )
    ).json()
    await client.put(
        f"/api/v1/characters/{character['id']}/profile",
        json={"identity": "调查记者", "secret": "曾参与实验"},
    )
    await client.put(
        f"/api/v1/characters/{character['id']}/states",
        json={"location": "北城", "mental_state": "怀疑苏璃"},
    )

    documents = await build_story_memory_documents(session, project_id)
    character_docs = [doc for doc in documents if doc.document_id.startswith("character:")]

    assert len(character_docs) == 1
    text = character_docs[0].text
    assert "调查记者" in text
    assert "曾参与实验" in text
    assert "北城" in text
    assert "怀疑苏璃" in text


@pytest.mark.asyncio
async def test_ai_invisible_world_entry_excluded_from_story_memory(
    client: AsyncClient, session
) -> None:
    project_id = (
        await client.post("/api/v1/projects", data={"title": "隐藏设定记忆"})
    ).json()["id"]
    world_info = (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()
    visible = (
        await client.post(
            f"/api/v1/world-info/{world_info['id']}/entries",
            json={"name": "公开设定", "content": "所有人都知道。"},
        )
    ).json()
    hidden = (
        await client.post(
            f"/api/v1/world-info/{world_info['id']}/entries",
            json={"name": "隐藏设定", "content": "只有作者知道。"},
        )
    ).json()
    await client.put(
        f"/api/v1/world-info-entries/{hidden['id']}/meta", json={"ai_visible": False}
    )

    documents = await build_story_memory_documents(session, project_id)
    world_docs = [doc for doc in documents if doc.document_id.startswith("world_entry:")]
    assert {doc.document_id for doc in world_docs} == {f"world_entry:{visible['id']}"}

    status = await compute_story_memory_status(session, project_id=project_id)
    assert status.counts.world_entries == 1


@pytest.mark.asyncio
async def test_hidden_note_excluded_from_story_memory_and_invalidates_fingerprint(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """被索引的笔记一旦隐藏：文档与计数都必须排除它，旧快照指纹立即 stale。"""
    project_id = await _create_project_with_entities(client)
    leaked = "泄漏哨兵-STORY-MEMORY-HIDDEN-NOTE"
    note = await note_repo.create(
        session,
        Note(
            project_id=project_id,
            title="私密笔记",
            content=leaked,
            is_hidden=False,
        ),
    )

    # 隐藏之前：笔记已进入文档与计数。
    documents = await build_story_memory_documents(session, project_id)
    note_documents = [
        doc
        for doc in documents
        if doc.document_id == story_document_id("note", note.id)
    ]
    assert len(note_documents) == 1
    assert leaked in note_documents[0].text
    assert (
        await compute_story_memory_status(session, project_id=project_id)
    ).counts.notes == 1

    # 用当前快照认证索引，模拟“隐藏之前已经成功重建”。
    index_row = SimpleNamespace(
        status="ready",
        source_fingerprint=await _current_source_fingerprint(session, project_id),
        last_error=None,
        last_ready_at=None,
    )
    monkeypatch.setattr(
        "app.retrieval.story_memory.retrieval_index_repo.get_by_index_key",
        AsyncMock(return_value=index_row),
    )
    monkeypatch.setattr(
        "app.retrieval.story_memory.background_service.list_jobs",
        AsyncMock(return_value=[]),
    )
    assert (
        await compute_story_memory_status(session, project_id=project_id)
    ).index_status == "ready"

    # 隐藏笔记。
    note.is_hidden = True
    await note_repo.update_note(session, note)

    documents_after = await build_story_memory_documents(session, project_id)
    assert all(
        not doc.document_id.startswith("note:") for doc in documents_after
    )
    assert leaked not in json.dumps(
        [doc.model_dump(mode="json") for doc in documents_after],
        ensure_ascii=False,
    )

    status_after = await compute_story_memory_status(session, project_id=project_id)
    assert status_after.counts.notes == 0
    # 旧索引仍含隐藏笔记，指纹必须变化，使该索引被判为 stale。
    assert await _current_source_fingerprint(session, project_id) != index_row.source_fingerprint
    assert status_after.index_status == "stale"


@pytest.mark.asyncio
async def test_story_memory_status_marks_changed_sources_stale(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """源数据创建 / 编辑 / 删除 / 可见性切换后，ready 状态必须让位于 stale。"""
    project_id = await _create_project_with_entities(client)
    index_row = SimpleNamespace(
        status="ready",
        source_fingerprint=None,
        last_error=None,
        last_ready_at=None,
    )
    monkeypatch.setattr(
        "app.retrieval.story_memory.retrieval_index_repo.get_by_index_key",
        AsyncMock(return_value=index_row),
    )
    monkeypatch.setattr(
        "app.retrieval.story_memory.background_service.list_jobs",
        AsyncMock(return_value=[]),
    )

    async def _status() -> str:
        return (
            await compute_story_memory_status(session, project_id=project_id)
        ).index_status

    async def _certify_current_snapshot() -> None:
        index_row.source_fingerprint = await _current_source_fingerprint(
            session, project_id
        )

    # 早于源快照指纹的旧索引行无法证明自己是最新的，必须先报 stale。
    assert await _status() == "stale"

    await _certify_current_snapshot()
    assert await _status() == "ready"

    world_info = await world_info_repo.get_by_project_id(session, project_id)
    assert world_info is not None
    entry = await world_info_entry_repo.create(
        session,
        WorldInfoEntry(
            world_info_id=world_info.id,
            uid=99,
            name="新设定",
            order=99,
            content="在上次索引之后新增。",
        ),
    )
    await session.flush()
    assert await _status() == "stale"

    await _certify_current_snapshot()
    await world_info_entry_service.update_entry(
        session, entry.id, content="内容在上次索引之后被改写。"
    )
    assert await _status() == "stale"

    # 可见性切换：被索引的条目改为对 AI 隐藏，快照必须立即失效。
    await _certify_current_snapshot()
    await world_entry_meta_service.update_meta(session, entry.id, ai_visible=False)
    assert await _status() == "stale"

    # 隐藏后的条目已不在快照里，重新对齐指纹即恢复 ready；
    # 再切回可见会再次改变快照。
    await _certify_current_snapshot()
    assert await _status() == "ready"
    await world_entry_meta_service.update_meta(session, entry.id, ai_visible=True)
    assert await _status() == "stale"

    # 删除源：条目重新进入快照后再删除，同样必须失效。
    await _certify_current_snapshot()
    await world_info_entry_service.delete_entry(session, entry.id)
    assert await _status() == "stale"


def test_story_memory_document_fingerprint_changes_for_insert_update_and_delete() -> None:
    from app.retrieval.types import IndexDocument

    original = [
        IndexDocument(
            document_id="character:c1",
            text="人物：林晚",
            attributes={"project_id": "p1", "source": "character"},
            metadata={"source": "character", "entity_id": "c1"},
        )
    ]
    original_fingerprint = fingerprint_story_memory_documents(original)

    edited = [original[0].model_copy(update={"text": "人物：林晚，失忆剑客"})]
    inserted = [
        *original,
        IndexDocument(
            document_id="note:n1",
            text="笔记：新线索",
            attributes={"project_id": "p1", "source": "note"},
            metadata={"source": "note", "entity_id": "n1"},
        ),
    ]
    deleted: list[IndexDocument] = []

    assert fingerprint_story_memory_documents(edited) != original_fingerprint
    assert fingerprint_story_memory_documents(inserted) != original_fingerprint
    assert fingerprint_story_memory_documents(deleted) != original_fingerprint


@pytest.mark.asyncio
async def test_story_memory_status_marks_character_extension_changes_stale(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """人物扩展资料与人物状态的改动同样必须让 ready 索引失效。"""
    project_id = await _create_project_with_entities(client)
    character = (await client.get(f"/api/v1/projects/{project_id}/characters")).json()
    character_id = character["items"][0]["id"]

    index_row = SimpleNamespace(
        status="ready",
        source_fingerprint=None,
        last_error=None,
        last_ready_at=None,
    )
    monkeypatch.setattr(
        "app.retrieval.story_memory.retrieval_index_repo.get_by_index_key",
        AsyncMock(return_value=index_row),
    )
    monkeypatch.setattr(
        "app.retrieval.story_memory.background_service.list_jobs",
        AsyncMock(return_value=[]),
    )

    async def _status() -> str:
        return (
            await compute_story_memory_status(session, project_id=project_id)
        ).index_status

    async def _certify_current_snapshot() -> None:
        index_row.source_fingerprint = await _current_source_fingerprint(
            session, project_id
        )

    await _certify_current_snapshot()
    assert await _status() == "ready"

    await client.put(
        f"/api/v1/characters/{character_id}/profile",
        json={"secret": "其实是前朝遗孤"},
    )
    assert await _status() == "stale"

    await _certify_current_snapshot()
    assert await _status() == "ready"

    await client.put(
        f"/api/v1/characters/{character_id}/states",
        json={"mental_state": "对同伴起了疑心"},
    )
    assert await _status() == "stale"


# ============================================
# 重建任务：源快照指纹
# ============================================


async def _noop_check_cancelled() -> None:
    return None


class _FakeRebuildRetrievalService:
    """重建替身：返回指定批量结果，并可在“建索引期间”改写源数据。"""

    def __init__(self, *, failed_count: int = 0, on_rebuild=None) -> None:
        self.failed_count = failed_count
        self.on_rebuild = on_rebuild
        self.index_keys: list[str] = []
        self.document_ids: list[str] = []

    async def rebuild(self, session, index_key, documents, embedding_client):
        _ = embedding_client
        self.index_keys.append(index_key)
        self.document_ids = [document.document_id for document in documents]
        if self.on_rebuild is not None:
            await self.on_rebuild(session)
        # 真实引擎会在这里把索引状态置为 ready。
        row = await retrieval_index_repo.get_by_index_key(session, index_key)
        if row is not None:
            row.status = "ready"
            await retrieval_index_repo.update(session, row)
        total = len(documents)
        return BatchIndexResult(
            total_documents=total,
            succeeded_count=total - self.failed_count,
            failed_count=self.failed_count,
        )


def _patch_rebuild_dependencies(
    monkeypatch: pytest.MonkeyPatch, service: _FakeRebuildRetrievalService
) -> None:
    monkeypatch.setattr(
        story_memory_job, "OpenFicRetrievalService", lambda: service
    )

    async def _fake_build_embedding_client(session_, model_ref_id: str):
        _ = (session_, model_ref_id)
        return SimpleNamespace()

    monkeypatch.setattr(
        story_memory_job, "_build_embedding_client", _fake_build_embedding_client
    )


async def _seed_rebuild_job(
    session, project_id: str, *, initial_fingerprint: str | None = None
) -> JobContext:
    session.add(
        RetrievalIndex(
            index_key=story_memory_index_key(project_id),
            table_name=f"story_memory_{project_id}",
            status="building",
            embedding_model_ref_id=MODEL_REF_ID,
            embedding_model_id_snapshot="embed-1",
            embedding_dimensions_snapshot=3,
            schema_version=2,
            # 上一次成功重建留下的指纹：本次重建必须覆盖或清除它。
            source_fingerprint=initial_fingerprint,
        )
    )
    await setting_repo.upsert(session, "default_embedding_model", MODEL_REF_ID)
    job = BackgroundJob(
        type=JOB_TYPE_STORY_MEMORY_REBUILD,
        status=JOB_STATUS_RUNNING,
        payload_json=json.dumps({"project_id": project_id}),
        context_json=json.dumps({"embedding_model_ref_id": MODEL_REF_ID}),
        subject_type="project",
        subject_id=project_id,
    )
    session.add(job)
    await session.flush()

    context = JobContext(
        session=session,
        job=job,
        publisher=BackgroundEventPublisher(),
    )
    context.check_cancelled = _noop_check_cancelled  # type: ignore[method-assign]
    return context


@pytest.mark.asyncio
async def test_story_memory_rebuild_records_source_fingerprint_on_success(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project_with_entities(client)
    context = await _seed_rebuild_job(session, project_id, initial_fingerprint="0" * 64)
    service = _FakeRebuildRetrievalService()
    _patch_rebuild_dependencies(monkeypatch, service)

    result = await story_memory_job.handle_story_memory_rebuild(context)

    assert result["failed"] == 0
    assert service.index_keys == [story_memory_index_key(project_id)]

    row = await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    assert row is not None
    # 认证快照是「来源令牌」指纹：ID + updated_at + 可见性 / 确认状态。
    expected = await _current_source_fingerprint(session, project_id)
    assert row.source_fingerprint == expected
    assert row.source_fingerprint != "0" * 64
    assert await story_memory_index_is_fresh(session, project_id=project_id) is True


@pytest.mark.asyncio
async def test_story_memory_rebuild_partial_failure_is_not_certified_fresh(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project_with_entities(client)
    context = await _seed_rebuild_job(session, project_id, initial_fingerprint="a" * 64)
    service = _FakeRebuildRetrievalService(failed_count=1)
    _patch_rebuild_dependencies(monkeypatch, service)

    result = await story_memory_job.handle_story_memory_rebuild(context)

    assert result["failed"] == 1
    row = await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    assert row is not None
    # 部分失败既不能沿用旧指纹，也不能写入新指纹，否则残缺索引会被当成最新快照。
    assert row.source_fingerprint is None
    assert await story_memory_index_is_fresh(session, project_id=project_id) is False
    status = await compute_story_memory_status(session, project_id=project_id)
    assert status.index_status == "stale"

@pytest.mark.asyncio
async def test_story_memory_rebuild_reports_stale_when_source_changes_during_build(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project_with_entities(client)
    world_info = await world_info_repo.get_by_project_id(session, project_id)
    assert world_info is not None
    snapshot_at_build_start = await _current_source_fingerprint(session, project_id)

    async def _add_entry_during_build(session_) -> None:
        session_.add(
            WorldInfoEntry(
                world_info_id=world_info.id,
                uid=99,
                name="构建期间新增的设定",
                order=99,
                content="索引快照生成之后才写入。",
            )
        )
        await session_.flush()

    context = await _seed_rebuild_job(session, project_id, initial_fingerprint="b" * 64)
    service = _FakeRebuildRetrievalService(on_rebuild=_add_entry_during_build)
    _patch_rebuild_dependencies(monkeypatch, service)

    result = await story_memory_job.handle_story_memory_rebuild(context)

    # 构建本身成功，但它认证的是构建开始时的快照。
    assert result["failed"] == 0
    row = await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    assert row is not None
    assert row.source_fingerprint == snapshot_at_build_start
    assert (
        await story_memory_index_is_fresh(session, project_id=project_id)
    ) is False

    status = await compute_story_memory_status(session, project_id=project_id)
    assert status.index_status == "stale"


# ============================================
# 项目删除：Story Memory 向量文档清理
# ============================================


class _RecordingRetrievalService:
    """批量删除替身：只记录调用，不接触真实向量库。"""

    def __init__(self, *, error: str | None = None) -> None:
        self.error = error
        self.calls: list[tuple[str, list[str]]] = []

    async def delete_documents(
        self, session, index_key: str, document_ids: list[str]
    ) -> None:
        _ = session
        self.calls.append((index_key, list(document_ids)))
        if self.error is not None:
            raise RuntimeError(self.error)


def _add_story_memory_index(session, project_id: str) -> None:
    """写入 Story Memory 索引行，使清理路径认为该项目已建立索引。"""
    session.add(
        RetrievalIndex(
            index_key=story_memory_index_key(project_id),
            table_name=f"story_memory_{project_id}",
            status="ready",
            embedding_model_ref_id=MODEL_REF_ID,
            embedding_model_id_snapshot="embed-1",
            embedding_dimensions_snapshot=3,
        )
    )


@pytest.mark.asyncio
async def test_delete_project_story_memory_documents_uses_project_index_only(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """清理只作用于该项目的 index_key，且覆盖源文档构建出的全部文档 ID。"""
    project_id = await _create_project_with_entities(client)
    other_project_id = await _create_project_with_entities(client)
    _add_story_memory_index(session, project_id)
    _add_story_memory_index(session, other_project_id)
    await session.flush()

    expected_document_ids = [
        document.document_id
        for document in await build_story_memory_documents(session, project_id)
    ]
    assert expected_document_ids

    service = _RecordingRetrievalService()
    monkeypatch.setattr(
        "app.retrieval.story_memory.OpenFicRetrievalService", lambda: service
    )

    await delete_project_story_memory_documents(session, project_id=project_id)

    assert service.calls == [
        (story_memory_index_key(project_id), expected_document_ids)
    ]
    assert all(
        index_key != story_memory_index_key(other_project_id)
        for index_key, _ in service.calls
    )


@pytest.mark.asyncio
async def test_delete_project_story_memory_documents_skips_missing_index(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """项目未建立 Story Memory 索引时静默跳过，不实例化检索服务。"""
    project_id = await _create_project_with_entities(client)

    service = _RecordingRetrievalService()
    created: list[_RecordingRetrievalService] = []

    def _factory() -> _RecordingRetrievalService:
        created.append(service)
        return service

    monkeypatch.setattr("app.retrieval.story_memory.OpenFicRetrievalService", _factory)

    await delete_project_story_memory_documents(session, project_id=project_id)

    assert created == []
    assert service.calls == []


@pytest.mark.asyncio
async def test_delete_project_story_memory_documents_skips_without_documents(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """索引存在但项目没有任何源文档时不调用批量删除。"""
    project_id = (
        await client.post("/api/v1/projects", data={"title": "空故事记忆项目"})
    ).json()["id"]
    _add_story_memory_index(session, project_id)
    await session.flush()

    service = _RecordingRetrievalService()
    monkeypatch.setattr(
        "app.retrieval.story_memory.OpenFicRetrievalService", lambda: service
    )

    await delete_project_story_memory_documents(session, project_id=project_id)

    assert service.calls == []


@pytest.mark.asyncio
async def test_delete_project_story_memory_documents_is_best_effort(
    client: AsyncClient, session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """向量库删除失败时只记录告警，不向调用方抛出异常。"""
    project_id = await _create_project_with_entities(client)
    _add_story_memory_index(session, project_id)
    await session.flush()

    service = _RecordingRetrievalService(error="vector store unavailable")
    monkeypatch.setattr(
        "app.retrieval.story_memory.OpenFicRetrievalService", lambda: service
    )

    await delete_project_story_memory_documents(session, project_id=project_id)

    assert len(service.calls) == 1
