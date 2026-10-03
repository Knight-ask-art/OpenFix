"""Story Memory 统一检索工具的测试。"""

import importlib
import json
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.agents.definitions import get_default_agent_definition
from app.agent_runtime.agents.tool_categories import get_tool_names_for_categories
from app.agent_runtime.tools.permission_metadata import (
    get_default_agent_tool_permissions,
    get_default_tool_permission_mode,
)
from app.agent_runtime.tools.registry import ToolRegistry
from app.core.encryption import EncryptionService
from app.models.repos import model_provider_repo, model_repo
from app.retrieval.chapter_index import compute_chapter_source_hash
from app.retrieval.story_memory import (
    build_story_memory_documents,
    fingerprint_story_memory_documents,
)
from app.retrieval.types import ChunkSearchResult
from app.settings import settings
from app.storage.models.chapter import Chapter
from app.storage.models.character import Character
from app.storage.models.note import Note
from app.storage.models.outline import Outline
from app.storage.models.project import Project
from app.storage.models.retrieval_chapter_index_state import RetrievalChapterIndexState
from app.storage.models.retrieval_index import RetrievalIndex
from app.storage.models.volume import Volume
from app.storage.models.world_info import WorldInfo
from app.storage.models.world_entry_meta import WorldEntryMeta
from app.storage.models.world_info_entry import WorldInfoEntry
from app.storage.repos import retrieval_index_repo, setting_repo

MODULE_PATH = "app.agent_runtime.tools.impls.memory.search_story_memory"
PROJECT_ID = "project-memory"
OTHER_PROJECT_ID = "project-other"
CHAPTER_INDEX_KEY = f"chapters:{PROJECT_ID}"
STORY_MEMORY_INDEX_KEY = f"story_memory:{PROJECT_ID}"


@dataclass
class FakeEmbeddingClient:
    config: Any


class FakeQueryBuilder:
    def __init__(self, results: list[ChunkSearchResult]) -> None:
        self.results = results
        self.calls: list[tuple[str, Any]] = []

    def hybrid(self):
        self.calls.append(("hybrid", None))
        return self

    def vector_top_k(self, count: int):
        self.calls.append(("vector_top_k", count))
        return self

    def bm25_top_k(self, count: int):
        self.calls.append(("bm25_top_k", count))
        return self

    def ef(self, ef: int):
        self.calls.append(("ef", ef))
        return self

    def filter_eq(self, field: str, value: Any):
        self.calls.append(("filter_eq", (field, value)))
        return self

    def rerank(self, rerank_client, *, top_n=None):
        self.calls.append(("rerank", (rerank_client, top_n)))
        return self

    def limit(self, count: int):
        self.calls.append(("limit", count))
        return self

    async def run(self) -> list[ChunkSearchResult]:
        self.calls.append(("run", None))
        return self.results


class FakeRetrievalService:
    """按 index_key 返回不同结果的检索服务替身。"""

    def __init__(self, results_by_index: dict[str, list[ChunkSearchResult]]) -> None:
        self.results_by_index = results_by_index
        self.queries: list[str] = []
        self.builders: list[FakeQueryBuilder] = []

    async def query(self, session, index_key: str, text: str, embedding_client):
        _ = (session, embedding_client, text)
        self.queries.append(index_key)
        builder = FakeQueryBuilder(self.results_by_index.get(index_key, []))
        self.builders.append(builder)
        return builder


class FailingRetrievalService:
    def __init__(self, message: str) -> None:
        self.message = message

    async def query(self, session, index_key: str, text: str, embedding_client):
        _ = (session, index_key, text, embedding_client)
        raise RuntimeError(self.message)


def _make_state(project_id: str = PROJECT_ID) -> dict[str, Any]:
    return {
        "session_id": "session-memory",
        "project_id": project_id,
        "model_config": {},
        "active_agent": None,
        "is_completed": False,
        "error": None,
        "retry_count": 0,
        "message_checkpoints": [],
        "user_request": "",
    }


def _chunk(
    *,
    metadata: dict[str, Any],
    document_id: str,
    chunk_id: str,
    text: str,
    score: float,
    rerank_score: float | None = None,
) -> ChunkSearchResult:
    return ChunkSearchResult(
        document_id=document_id,
        chunk_id=chunk_id,
        chunk_index=0,
        text=text,
        metadata=metadata,
        score=score,
        rerank_score=rerank_score,
        matched_by="hybrid",
    )


def _chapter_chunk(
    *,
    chapter_id: str,
    text: str,
    score: float,
    project_id: str = PROJECT_ID,
    rerank_score: float | None = None,
) -> ChunkSearchResult:
    return _chunk(
        metadata={
            "project_id": project_id,
            "chapter_id": chapter_id,
            "chapter_title": "metadata-title",
            "chapter_order": 99,
            "volume_id": "metadata-volume",
        },
        document_id=f"chapter:{chapter_id}",
        chunk_id=f"{chapter_id}-c0",
        text=text,
        score=score,
        rerank_score=rerank_score,
    )


def _entity_chunk(
    *,
    source: str,
    entity_id: str,
    text: str,
    score: float,
    rerank_score: float | None = None,
) -> ChunkSearchResult:
    return _chunk(
        metadata={
            "project_id": PROJECT_ID,
            "source": source,
            "entity_id": entity_id,
        },
        document_id=f"{source}:{entity_id}",
        chunk_id=f"{source}:{entity_id}:0",
        text=text,
        score=score,
        rerank_score=rerank_score,
    )


async def _create_embedding_model(session: AsyncSession):
    encryption = EncryptionService(settings.encryption_key)
    provider = await model_provider_repo.create(
        session,
        name="Embedding Provider",
        url="https://example.test/v1",
        api_key_encrypted=encryption.encrypt("secret"),
        provider_type="openai-compatible",
    )
    return await model_repo.create(
        session,
        name="Embedding Model",
        provider_id=provider.id,
        model_id="text-embedding-test",
        task_type="embedding",
        dimensions=3,
    )


def _index_row(index_key: str, *, model) -> RetrievalIndex:
    return RetrievalIndex(
        index_key=index_key,
        table_name=index_key.replace(":", "_").replace("-", "_"),
        status="ready",
        embedding_model_ref_id=model.id,
        embedding_model_id_snapshot=model.model_id,
        embedding_dimensions_snapshot=3,
        schema_version=2,
    )


async def _seed_project(
    session: AsyncSession,
    *,
    model,
    chapter_index: bool = True,
    story_memory_index: bool = True,
) -> None:
    session.add(Project(id=PROJECT_ID, title="故事记忆项目"))
    session.add(Project(id=OTHER_PROJECT_ID, title="别的项目"))
    session.add(Volume(id="volume-1", project_id=PROJECT_ID, title="第一卷", order=1))
    session.add(
        Chapter(
            id="chapter-1",
            project_id=PROJECT_ID,
            volume_id="volume-1",
            title="雨夜来客",
            content="林洛在雨夜抵达北城。",
            order=3,
            word_count=10,
        )
    )
    session.add(
        Chapter(
            id="chapter-other",
            project_id=OTHER_PROJECT_ID,
            volume_id="volume-other",
            title="别的书章节",
            content="不属于本项目的正文。",
            order=1,
            word_count=8,
        )
    )
    session.add(
        Character(id="char-1", project_id=PROJECT_ID, name="林洛", description="失忆记者")
    )
    session.add(WorldInfo(id="world-1", project_id=PROJECT_ID, name="世界书"))
    session.add(
        WorldInfo(id="world-other", project_id=OTHER_PROJECT_ID, name="另一本书的世界书")
    )
    session.add(
        WorldInfoEntry(
            id="entry-1",
            world_info_id="world-1",
            uid=1,
            name="北城",
            order=1,
            content="北方城市。",
        )
    )
    session.add(
        WorldInfoEntry(
            id="entry-other",
            world_info_id="world-other",
            uid=1,
            name="不应泄漏的世界条目",
            order=1,
            content="属于另一本书。",
        )
    )
    session.add(
        Outline(
            id="outline-1",
            project_id=PROJECT_ID,
            level="book",
            title="全书主线",
            content="记者追查真相。",
        )
    )
    session.add(
        Note(id="note-1", project_id=PROJECT_ID, title="设定笔记", content="记忆可被编辑。")
    )
    await session.flush()
    story_memory_fingerprint = None
    if story_memory_index:
        documents = await build_story_memory_documents(session, PROJECT_ID)
        story_memory_fingerprint = fingerprint_story_memory_documents(documents)
    if chapter_index:
        session.add(_index_row(CHAPTER_INDEX_KEY, model=model))
        session.add(
            RetrievalChapterIndexState(
                project_id=PROJECT_ID,
                chapter_id="chapter-1",
                index_key=CHAPTER_INDEX_KEY,
                status="ready",
                source_hash=compute_chapter_source_hash("林洛在雨夜抵达北城。"),
                embedding_model_ref_id=model.id,
            )
        )
    if story_memory_index:
        row = _index_row(STORY_MEMORY_INDEX_KEY, model=model)
        row.source_fingerprint = story_memory_fingerprint
        session.add(row)
    await session.flush()


async def _prepare_session(
    session: AsyncSession,
    monkeypatch,
    results_by_index,
    *,
    chapter_index: bool = True,
    story_memory_index: bool = True,
):
    model = await _create_embedding_model(session)
    await _seed_project(
        session,
        model=model,
        chapter_index=chapter_index,
        story_memory_index=story_memory_index,
    )
    await setting_repo.upsert(session, "default_embedding_model", model.id)
    await session.commit()

    module = importlib.import_module(MODULE_PATH)
    retrieval = FakeRetrievalService(results_by_index)
    monkeypatch.setattr(module, "OpenFicRetrievalService", lambda: retrieval)

    async def _fake_build_embedding_client(session_, model_ref_id: str):
        _ = (session_, model_ref_id)
        return FakeEmbeddingClient(config=None)

    monkeypatch.setattr(module, "_build_embedding_client", _fake_build_embedding_client)
    tool = ToolRegistry.get_tools(names=["search_story_memory"], state=_make_state())[0]
    return module, retrieval, tool


async def _invoke(tool, session: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
    raw = await tool.ainvoke(
        payload,
        config={"configurable": {"db_session": session}},
    )
    return json.loads(raw)


# ============================================
# 注册与权限
# ============================================


def test_search_story_memory_is_registered_with_schema_and_default_permission() -> None:
    tool = ToolRegistry.get_tools(names=["search_story_memory"], state=_make_state())[0]

    schema = tool.args_schema.model_json_schema()

    assert tool.name == "search_story_memory"
    assert tool.access_level == "readonly"
    assert set(schema["properties"].keys()) == {"query", "sources", "limit"}
    assert schema["required"] == ["query"]
    assert get_default_tool_permission_mode("search_story_memory") == "allow"
    assert {"tool_name": "search_story_memory", "mode": "allow"} in (
        get_default_agent_tool_permissions()
    )


def test_search_story_memory_expands_from_story_memory_read_for_default_agents() -> None:
    assert "search_story_memory" in get_tool_names_for_categories(["story_memory_read"])

    for agent_key in (
        "build",
        "plan",
        "explore",
        "composer",
        "auditor",
        "writer",
        "actor",
        "reviewer",
    ):
        definition = get_default_agent_definition(agent_key)
        assert "search_story_memory" in get_tool_names_for_categories(
            definition.enabled_tool_categories
        )


def test_existing_search_chapters_registration_is_unchanged() -> None:
    """新增故事记忆工具不得改变既有章节检索工具的注册与权限。"""
    tool = ToolRegistry.get_tools(names=["search_chapters"], state=_make_state())[0]
    schema = tool.args_schema.model_json_schema()

    assert tool.name == "search_chapters"
    assert tool.access_level == "readonly"
    assert set(schema["properties"].keys()) == {"query", "force"}
    assert get_default_tool_permission_mode("search_chapters") == "allow"
    assert "search_chapters" in get_tool_names_for_categories(["chapter_read"])


def test_search_story_memory_is_visible_in_agent_tool_list() -> None:
    """未登记在展示顺序里的工具不会出现在 /agent/tools 中，必须一并登记。"""
    from app.api.routers.agent_runtime import TOOL_DISPLAY_ORDER

    assert "search_story_memory" in TOOL_DISPLAY_ORDER
    assert TOOL_DISPLAY_ORDER["search_story_memory"] == (
        TOOL_DISPLAY_ORDER["search_chapters"] + 0.5
    )


# ============================================
# 错误路径
# ============================================


@pytest.mark.asyncio
async def test_search_story_memory_returns_error_without_embedding_model(
    session: AsyncSession,
) -> None:
    session.add(Project(id=PROJECT_ID, title="故事记忆项目"))
    await session.commit()

    tool = ToolRegistry.get_tools(names=["search_story_memory"], state=_make_state())[0]
    data = await _invoke(tool, session, {"query": "北城"})

    assert data["type"] == "fail"
    assert "default_embedding_model" in data["message"]


@pytest.mark.asyncio
async def test_search_story_memory_rejects_blank_query(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _module, _retrieval, tool = await _prepare_session(session, monkeypatch, {})

    data = await _invoke(tool, session, {"query": "   "})

    assert data["type"] == "fail"
    assert "检索语句" in data["message"]


@pytest.mark.asyncio
async def test_search_story_memory_hides_retrieval_error_details(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = await _create_embedding_model(session)
    await _seed_project(session, model=model)
    await setting_repo.upsert(session, "default_embedding_model", model.id)
    await session.commit()

    module = importlib.import_module(MODULE_PATH)
    monkeypatch.setattr(
        module, "OpenFicRetrievalService", lambda: FailingRetrievalService("secret-detail-xyz")
    )

    async def _fake_build_embedding_client(session_, model_ref_id: str):
        _ = (session_, model_ref_id)
        return FakeEmbeddingClient(config=None)

    monkeypatch.setattr(module, "_build_embedding_client", _fake_build_embedding_client)
    tool = ToolRegistry.get_tools(names=["search_story_memory"], state=_make_state())[0]

    data = await _invoke(tool, session, {"query": "北城"})

    assert data["type"] == "fail"
    assert "secret-detail-xyz" not in json.dumps(data, ensure_ascii=False)
    assert "故事记忆检索执行失败" in data["message"]


# ============================================
# 来源覆盖
# ============================================


@pytest.mark.asyncio
async def test_search_story_memory_covers_all_sources_with_attribution(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    results_by_index = {
        CHAPTER_INDEX_KEY: [
            _chapter_chunk(chapter_id="chapter-1", text="林洛在雨夜抵达北城。", score=0.91)
        ],
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(source="character", entity_id="char-1", text="人物：林洛", score=0.88),
            _entity_chunk(source="world_entry", entity_id="entry-1", text="世界设定：北城", score=0.83),
            _entity_chunk(source="outline", entity_id="outline-1", text="大纲[book]：全书主线", score=0.72),
            _entity_chunk(source="note", entity_id="note-1", text="笔记：设定笔记", score=0.61),
        ],
    }
    _module, retrieval, tool = await _prepare_session(session, monkeypatch, results_by_index)

    data = await _invoke(tool, session, {"query": "北城"})

    assert data["searched_sources"] == ["chapter", "character", "world_entry", "outline", "note"]
    assert data["skipped_sources"] == []
    assert [item["source"] for item in data["results"]] == [
        "chapter",
        "character",
        "world_entry",
        "outline",
        "note",
    ]
    chapter_item = data["results"][0]
    assert chapter_item["title"] == "雨夜来客"
    assert chapter_item["chapter_order"] == 3
    assert chapter_item["volume_id"] == "volume-1"
    assert chapter_item["entity_id"] == "chapter-1"
    assert chapter_item["source_label"] == "章节"
    assert data["results"][1]["title"] == "林洛"
    assert data["results"][1]["source_label"] == "人物"
    assert data["results"][2]["title"] == "北城"
    assert data["results"][3]["title"] == "全书主线"
    assert data["results"][4]["title"] == "设定笔记"

    # 未启用 rerank 时 score 仍是 RRF 置信度，重排字段为 null。
    assert [item["score"] for item in data["results"]] == [
        0.91,
        0.88,
        0.83,
        0.72,
        0.61,
    ]
    assert all(item["rerank_score"] is None for item in data["results"])

    # 两个索引都被查询，并按 project_id 过滤。
    assert retrieval.queries == [CHAPTER_INDEX_KEY, STORY_MEMORY_INDEX_KEY]
    for builder in retrieval.builders:
        assert ("filter_eq", ("project_id", PROJECT_ID)) in builder.calls


@pytest.mark.asyncio
async def test_search_story_memory_reports_skipped_sources_when_index_missing(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _module, retrieval, tool = await _prepare_session(
        session,
        monkeypatch,
        {
            CHAPTER_INDEX_KEY: [
                _chapter_chunk(chapter_id="chapter-1", text="正文", score=0.9)
            ]
        },
        story_memory_index=False,
    )

    data = await _invoke(tool, session, {"query": "北城"})

    assert data["searched_sources"] == ["chapter"]
    assert data["skipped_sources"] == ["character", "world_entry", "outline", "note"]
    assert [item["source"] for item in data["results"]] == ["chapter"]
    assert retrieval.queries == [CHAPTER_INDEX_KEY]


@pytest.mark.asyncio
async def test_search_story_memory_drops_stale_and_cross_project_items(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    results_by_index = {
        CHAPTER_INDEX_KEY: [
            # 属于别的项目的章节分块，即使索引返回也必须丢弃。
            _chapter_chunk(
                chapter_id="chapter-other",
                text="别的项目正文",
                score=0.99,
                project_id=OTHER_PROJECT_ID,
            ),
            _chapter_chunk(chapter_id="chapter-1", text="本项目正文", score=0.5),
        ],
        STORY_MEMORY_INDEX_KEY: [
            # 实体已删除的悬空索引条目。
            _entity_chunk(source="character", entity_id="char-gone", text="人物：已删除", score=0.95),
            _entity_chunk(source="character", entity_id="char-1", text="人物：林洛", score=0.4),
        ],
    }
    _module, _retrieval, tool = await _prepare_session(session, monkeypatch, results_by_index)

    data = await _invoke(tool, session, {"query": "北城"})

    titles = [item["title"] for item in data["results"]]
    assert titles == ["雨夜来客", "林洛"]
    assert all(item["entity_id"] != "chapter-other" for item in data["results"])
    assert all(item["entity_id"] != "char-gone" for item in data["results"])


@pytest.mark.asyncio
async def test_search_story_memory_drops_cross_project_world_entry(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    results_by_index = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="world_entry",
                entity_id="entry-1",
                text="世界设定：北城",
                score=0.9,
            ),
            _entity_chunk(
                source="world_entry",
                entity_id="entry-other",
                text="世界设定：不应泄漏",
                score=0.95,
            ),
        ]
    }
    _module, _retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )

    data = await _invoke(
        tool, session, {"query": "世界设定", "sources": ["world_entry"]}
    )

    assert [item["entity_id"] for item in data["results"]] == ["entry-1"]


@pytest.mark.asyncio
async def test_search_story_memory_skips_stale_story_memory_snapshot(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    results_by_index = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="character",
                entity_id="char-1",
                text="旧人物资料",
                score=0.9,
            )
        ]
    }
    _module, retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )
    index_row = await retrieval_index_repo.get_by_index_key(
        session, STORY_MEMORY_INDEX_KEY
    )
    assert index_row is not None
    index_row.source_fingerprint = "0" * 64
    await retrieval_index_repo.update(session, index_row)
    await session.commit()

    data = await _invoke(
        tool, session, {"query": "人物", "sources": ["character"]}
    )

    assert data["searched_sources"] == []
    assert data["skipped_sources"] == ["character"]
    assert data["results"] == []
    assert STORY_MEMORY_INDEX_KEY not in retrieval.queries


@pytest.mark.asyncio
async def test_search_story_memory_drops_currently_hidden_world_entry(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    results_by_index = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="world_entry",
                entity_id="entry-1",
                text="作者秘密：旧索引片段",
                score=0.9,
            )
        ]
    }
    module, _retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )
    session.add(
        WorldEntryMeta(
            entry_id="entry-1",
            project_id=PROJECT_ID,
            ai_visible=False,
        )
    )
    await session.commit()
    # Exercise the live visibility guard even if a legacy or inconsistent index
    # is incorrectly reported as fresh.
    monkeypatch.setattr(
        module,
        "story_memory_index_is_fresh",
        AsyncMock(return_value=True),
    )

    data = await _invoke(
        tool, session, {"query": "作者秘密", "sources": ["world_entry"]}
    )

    assert data["results"] == []
    assert "作者秘密：旧索引片段" not in json.dumps(data, ensure_ascii=False)


@pytest.mark.asyncio
async def test_search_story_memory_drops_currently_hidden_note(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """隐藏笔记的索引内容不得进入模型上下文，即使索引被报告为最新。"""
    leaked = "泄漏哨兵-NOTE-HIDDEN-CONTENT"
    results_by_index = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="note",
                entity_id="note-1",
                text=leaked,
                score=0.95,
            )
        ]
    }
    module, _retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )
    note = await session.get(Note, "note-1")
    assert note is not None
    note.is_hidden = True
    await session.commit()
    # 强制 fresh：验证拒绝逻辑来自 live 的 is_hidden 检查，而不是 stale 降级。
    monkeypatch.setattr(
        module,
        "story_memory_index_is_fresh",
        AsyncMock(return_value=True),
    )

    data = await _invoke(tool, session, {"query": "私密线索", "sources": ["note"]})

    assert data["results"] == []
    assert leaked not in json.dumps(data, ensure_ascii=False)


@pytest.mark.asyncio
async def test_search_story_memory_rechecks_freshness_before_returning_results(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """源数据在检索途中变化（例如世界设定被切换为对 AI 隐藏）时，
    故事记忆结果必须在交付给模型之前丢弃。"""
    leaked = "作者秘密：检索途中被切换为隐藏"
    results_by_index = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="world_entry",
                entity_id="entry-1",
                text=leaked,
                score=0.9,
            )
        ]
    }
    module, _retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )
    # 检索开始时索引仍最新，交付前复查发现源数据已变化。
    monkeypatch.setattr(
        module,
        "story_memory_index_is_fresh",
        AsyncMock(side_effect=[True, False]),
    )

    data = await _invoke(tool, session, {"query": "秘密", "sources": ["world_entry"]})

    assert data["results"] == []
    assert data["searched_sources"] == []
    assert data["skipped_sources"] == ["world_entry"]
    assert leaked not in json.dumps(data, ensure_ascii=False)


@pytest.mark.asyncio
async def test_search_story_memory_skips_stale_chapter_index(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _module, retrieval, tool = await _prepare_session(
        session,
        monkeypatch,
        {
            CHAPTER_INDEX_KEY: [
                _chapter_chunk(chapter_id="chapter-1", text="旧的正文索引内容", score=0.95)
            ]
        },
    )
    chapter = await session.get(Chapter, "chapter-1")
    assert chapter is not None
    chapter.content = "已经更新的新正文。"
    await session.commit()

    data = await _invoke(
        tool, session, {"query": "旧的正文", "sources": ["chapter"]}
    )

    assert data["searched_sources"] == []
    assert data["skipped_sources"] == ["chapter"]
    assert data["results"] == []
    assert CHAPTER_INDEX_KEY not in retrieval.queries


@pytest.mark.asyncio
async def test_search_story_memory_respects_source_filter_and_limit(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    results_by_index = {
        CHAPTER_INDEX_KEY: [
            _chapter_chunk(chapter_id="chapter-1", text="正文", score=0.9)
        ],
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(source="character", entity_id="char-1", text="人物：林洛", score=0.8),
            _entity_chunk(source="note", entity_id="note-1", text="笔记：设定笔记", score=0.7),
        ],
    }
    _module, retrieval, tool = await _prepare_session(session, monkeypatch, results_by_index)

    data = await _invoke(tool, session, {"query": "北城", "sources": ["note"], "limit": 1})

    assert data["searched_sources"] == ["note"]
    assert data["skipped_sources"] == []
    # 只查询故事记忆索引，章节索引不参与。
    assert retrieval.queries == [STORY_MEMORY_INDEX_KEY]
    assert [item["source"] for item in data["results"]] == ["note"]


@pytest.mark.asyncio
async def test_search_story_memory_rejects_empty_source_selection(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _module, retrieval, tool = await _prepare_session(session, monkeypatch, {})

    data = await _invoke(tool, session, {"query": "北城", "sources": []})

    assert data["type"] == "fail"
    assert "数据源" in data["message"]
    assert retrieval.queries == []


@pytest.mark.asyncio
async def test_search_story_memory_rejects_unknown_source_key(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _module, retrieval, tool = await _prepare_session(session, monkeypatch, {})

    data = await _invoke(tool, session, {"query": "北城", "sources": ["unknown"]})

    assert data["type"] == "fail"
    assert data["code"] == "validation_error"
    assert retrieval.queries == []


# ============================================
# rerank 配置
# ============================================


class _FakeRerankClient:
    """rerank client 替身：按文本查表给出相关度，并按相关度降序返回。"""

    def __init__(self, scores_by_text: dict[str, float]) -> None:
        self.scores_by_text = scores_by_text
        self.calls: list[tuple[str, list[str], int | None]] = []

    async def rerank(self, query: str, documents: list[str], top_n: int | None = None):
        from app.models.clients.rerank_client import RerankItem, RerankResponse

        self.calls.append((query, documents, top_n))
        items = [
            RerankItem(index=index, relevance_score=self.scores_by_text.get(text, 0.0))
            for index, text in enumerate(documents)
        ]
        items.sort(key=lambda item: item.relevance_score, reverse=True)
        if top_n is not None:
            items = items[:top_n]
        return RerankResponse(results=items, model="fake-reranker")


async def _enable_rerank(
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    module,
    client: Any,
) -> None:
    """打开 rerank 设置，并把 rerank client 构造替换为替身。"""
    await setting_repo.upsert(session, "index_rerank_enabled", "true")
    await setting_repo.upsert(session, "default_rerank_model", "rerank-model-1")
    await session.commit()

    async def _fake_build_rerank_client(session_, model_ref_id: str):
        _ = (session_, model_ref_id)
        return client

    monkeypatch.setattr(module, "_build_rerank_client", _fake_build_rerank_client)


@pytest.mark.asyncio
async def test_search_story_memory_keeps_rrf_order_when_rerank_disabled(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """未启用 rerank 时不调用 rerank，候选上限与 RRF 顺序保持不变。"""
    results_by_index = {
        CHAPTER_INDEX_KEY: [
            _chapter_chunk(chapter_id="chapter-1", text="章节正文", score=0.9)
        ],
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="character", entity_id="char-1", text="人物：林洛", score=0.4
            )
        ],
    }
    module, retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )

    data = await _invoke(tool, session, {"query": "北城"})

    assert [item["source"] for item in data["results"]] == ["chapter", "character"]
    # 未启用 rerank 时只暴露 RRF 分数，不虚构重排分数。
    assert [item["score"] for item in data["results"]] == [0.9, 0.4]
    assert [item["rerank_score"] for item in data["results"]] == [None, None]
    assert len(retrieval.builders) == 2
    for builder in retrieval.builders:
        assert all(name != "rerank" for name, _ in builder.calls)
        assert ("limit", module.CANDIDATE_TOP_K) in builder.calls


@pytest.mark.asyncio
async def test_search_story_memory_reranks_candidates_before_limit(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """启用 rerank 后两个索引都先重排候选池，再按重排相关度合并返回。"""
    results_by_index = {
        CHAPTER_INDEX_KEY: [
            _chapter_chunk(
                chapter_id="chapter-1", text="章节正文", score=0.9, rerank_score=0.12
            )
        ],
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="character",
                entity_id="char-1",
                text="人物：林洛",
                score=0.4,
                rerank_score=0.95,
            )
        ],
    }
    module, retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )
    rerank_client = _FakeRerankClient({"章节正文": 0.12, "人物：林洛": 0.95})
    await _enable_rerank(session, monkeypatch, module, rerank_client)

    data = await _invoke(tool, session, {"query": "北城"})

    # 重排相关度高的故事记忆候选，排在 RRF 更高但重排分低的章节候选之前。
    assert [item["source"] for item in data["results"]] == ["character", "chapter"]
    # score 保持原有 RRF 含义不变，排序依据另以 rerank_score 单独暴露，
    # 模型不会再收到「顺序与唯一分数相互矛盾」的结果。
    assert [item["score"] for item in data["results"]] == [0.4, 0.9]
    assert [item["rerank_score"] for item in data["results"]] == [0.95, 0.12]
    assert len(retrieval.builders) == 2
    for builder in retrieval.builders:
        names = [name for name, _ in builder.calls]
        assert ("rerank", (rerank_client, module.CANDIDATE_TOP_K)) in builder.calls
        # rerank 必须发生在最终候选上限之前。
        assert names.index("rerank") < names.index("limit") < names.index("run")

    # FakeQueryBuilder 只记录 rerank 配置，run() 直接返回预置结果，不会真正调用
    # rerank client；实际重排由检索服务在 run() 内完成。所以这里断言的是「工具把
    # 配置好的 reranker 挂到两个索引的查询构建器上，各一次」，以及「工具自身不直接
    # 调用 rerank client、把执行权委托给检索服务」，而不是替身 client 的执行次数。
    rerank_configs = [
        payload
        for builder in retrieval.builders
        for name, payload in builder.calls
        if name == "rerank"
    ]
    assert rerank_configs == [
        (rerank_client, module.CANDIDATE_TOP_K),
        (rerank_client, module.CANDIDATE_TOP_K),
    ]
    assert rerank_client.calls == []


@pytest.mark.asyncio
async def test_search_story_memory_only_marks_reranked_candidates(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """候选池大于 top_n 时，只有真正被重排的候选带 rerank_score，其余保持 null。"""
    results_by_index = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="character",
                entity_id="char-1",
                text="人物：林洛",
                score=0.4,
                rerank_score=0.95,
            ),
            _entity_chunk(
                source="note",
                entity_id="note-1",
                text="笔记：设定笔记",
                score=0.9,
                rerank_score=None,
            ),
        ]
    }
    module, _retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )
    rerank_client = _FakeRerankClient({"人物：林洛": 0.95})
    await _enable_rerank(session, monkeypatch, module, rerank_client)

    data = await _invoke(
        tool, session, {"query": "北城", "sources": ["character", "note"]}
    )

    # 已重排候选排在前面并带重排分；未重排的尾部候选仍只按 RRF 分数暴露。
    assert [item["source"] for item in data["results"]] == ["character", "note"]
    assert [item["rerank_score"] for item in data["results"]] == [0.95, None]
    assert [item["score"] for item in data["results"]] == [0.4, 0.9]


@pytest.mark.asyncio
async def test_search_story_memory_skips_rerank_when_model_is_not_a_reranker(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """rerank 开关打开但配置的模型不是 rerank 模型时，退回纯 RRF 且不报错。"""
    results_by_index = {
        CHAPTER_INDEX_KEY: [
            _chapter_chunk(chapter_id="chapter-1", text="章节正文", score=0.9)
        ],
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk(
                source="character", entity_id="char-1", text="人物：林洛", score=0.4
            )
        ],
    }
    module, retrieval, tool = await _prepare_session(
        session, monkeypatch, results_by_index
    )
    embedding_setting = await setting_repo.get_by_key(
        session, "default_embedding_model"
    )
    assert embedding_setting is not None
    await setting_repo.upsert(session, "index_rerank_enabled", "true")
    await setting_repo.upsert(session, "default_rerank_model", embedding_setting.value)
    await session.commit()

    data = await _invoke(tool, session, {"query": "北城"})

    assert [item["source"] for item in data["results"]] == ["chapter", "character"]
    # 降级为纯 RRF 时不暴露任何重排分数。
    assert [item["rerank_score"] for item in data["results"]] == [None, None]
    assert len(retrieval.builders) == 2
    for builder in retrieval.builders:
        assert all(name != "rerank" for name, _ in builder.calls)
