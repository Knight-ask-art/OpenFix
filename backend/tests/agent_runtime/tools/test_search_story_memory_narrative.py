# -*- coding: utf-8 -*-
"""search_story_memory 叙事来源接入测试。

覆盖：默认来源不含叙事状态、任务画像选择来源、叙事结果按当前行重新渲染、
未确认 / 已被取代的叙事行即使命中旧索引也必须丢弃、场景隐藏信息带作者可见标注、
以及结果仍然受检索 token 预算约束。
"""

import importlib
import json
from dataclasses import dataclass
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.tools.registry import ToolRegistry
from app.models.repos import model_provider_repo, model_repo
from app.core.encryption import EncryptionService
from app.retrieval.narrative_memory import SCENE_AUTHOR_ONLY_MARKER
from app.retrieval.story_memory import (
    collect_story_memory_source_tokens,
    fingerprint_story_memory_sources,
)
from app.retrieval.types import ChunkSearchResult
from app.settings import settings
from app.storage.models.chapter import Chapter
from app.storage.models.character import Character
from app.storage.models.character_belief import CharacterBelief
from app.storage.models.plotline import Plotline
from app.storage.models.project import Project
from app.storage.models.retrieval_index import RetrievalIndex
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.volume import Volume
from app.storage.models.world_fact import WorldFact
from app.storage.repos import retrieval_index_repo, setting_repo

MODULE_PATH = "app.agent_runtime.tools.impls.memory.search_story_memory"
PROJECT_ID = "project-narrative-memory"
STORY_MEMORY_INDEX_KEY = f"story_memory:{PROJECT_ID}"


@dataclass
class FakeEmbeddingClient:
    config: Any


class FakeQueryBuilder:
    """最小可用的查询构建器：记录下推的来源过滤，并按过滤截断候选。"""

    def __init__(self, results: list[ChunkSearchResult]) -> None:
        self.results = results
        self.filters: dict[str, Any] = {}
        self.limit_count: int | None = None

    def hybrid(self):
        return self

    def vector_top_k(self, count: int):
        _ = count
        return self

    def bm25_top_k(self, count: int):
        _ = count
        return self

    def ef(self, ef: int):
        _ = ef
        return self

    def filter_eq(self, field: str, value: Any):
        self.filters[field] = value
        return self

    def rerank(self, rerank_client, *, top_n=None):
        _ = (rerank_client, top_n)
        return self

    def limit(self, count: int):
        self.limit_count = count
        return self

    async def run(self) -> list[ChunkSearchResult]:
        rows = [
            row
            for row in self.results
            if all(
                row.metadata.get(field) == value for field, value in self.filters.items()
            )
        ]
        return rows[: self.limit_count] if self.limit_count is not None else rows


class FakeRetrievalService:
    def __init__(self, results_by_index: dict[str, list[ChunkSearchResult]]) -> None:
        self.results_by_index = results_by_index
        self.queries: list[str] = []
        self.builders: list[FakeQueryBuilder] = []

    async def query(self, session, index_key: str, text: str, embedding_client):
        _ = (session, text, embedding_client)
        self.queries.append(index_key)
        builder = FakeQueryBuilder(self.results_by_index.get(index_key, []))
        self.builders.append(builder)
        return builder


def _state() -> dict[str, Any]:
    return {
        "session_id": "session-narrative",
        "project_id": PROJECT_ID,
        "model_config": {},
        "active_agent": None,
        "is_completed": False,
        "error": None,
        "retry_count": 0,
        "message_checkpoints": [],
        "user_request": "",
    }


def _entity_chunk(source: str, entity_id: str, text: str, score: float) -> ChunkSearchResult:
    return ChunkSearchResult(
        document_id=f"{source}:{entity_id}",
        chunk_id=f"{source}:{entity_id}:0",
        chunk_index=0,
        text=text,
        metadata={"project_id": PROJECT_ID, "source": source, "entity_id": entity_id},
        score=score,
        matched_by="hybrid",
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


async def _seed(session: AsyncSession) -> dict[str, str]:
    session.add(Project(id=PROJECT_ID, title="叙事检索项目"))
    session.add(Volume(id="volume-1", project_id=PROJECT_ID, title="第一卷", order=1))
    session.add(
        Chapter(
            id="chapter-1",
            project_id=PROJECT_ID,
            volume_id="volume-1",
            title="第三章 雨夜入城",
            content="正文",
            order=1,
            word_count=2,
        )
    )
    session.add(
        Character(id="char-1", project_id=PROJECT_ID, name="林洛", description="记者")
    )
    session.add(
        WorldFact(
            id="fact-1",
            project_id=PROJECT_ID,
            statement="北城有三座城门",
            status="confirmed",
            confirmation="confirmed",
        )
    )
    session.add(
        WorldFact(
            id="fact-candidate",
            project_id=PROJECT_ID,
            statement="尚未确认的断言",
            status="confirmed",
            confirmation="candidate",
        )
    )
    session.add(
        CharacterBelief(
            id="belief-1",
            project_id=PROJECT_ID,
            character_id="char-1",
            proposition="北城的雨是诅咒",
            belief_state="mistaken",
            confirmation="confirmed",
        )
    )
    session.add(
        Plotline(
            id="plotline-1",
            project_id=PROJECT_ID,
            title="失踪的兄长",
            state="open",
            confirmation="confirmed",
        )
    )
    session.add(
        ScenePlan(
            id="scene-1",
            project_id=PROJECT_ID,
            chapter_id="chapter-1",
            scene_index=0,
            goal="让林洛发现客栈的异常",
            pov_character_id="char-1",
            known_information_json=json.dumps(["门外有人走动"], ensure_ascii=False),
            hidden_information_json=json.dumps(["真凶其实是管家"], ensure_ascii=False),
            confirmation="confirmed",
        )
    )
    await session.flush()

    model = await _create_embedding_model(session)
    await setting_repo.upsert(session, "default_embedding_model", model.id)
    session.add(
        RetrievalIndex(
            index_key=STORY_MEMORY_INDEX_KEY,
            table_name="story_memory_narrative",
            status="ready",
            embedding_model_ref_id=model.id,
            embedding_model_id_snapshot=model.model_id,
            embedding_dimensions_snapshot=3,
            source_fingerprint=fingerprint_story_memory_sources(
                await collect_story_memory_source_tokens(session, PROJECT_ID)
            ),
        )
    )
    await session.flush()
    return {"model_id": model.id}


async def _certify_index(session: AsyncSession) -> None:
    """把索引行重新认证为「与当前源快照一致」。"""
    row = await retrieval_index_repo.get_by_index_key(session, STORY_MEMORY_INDEX_KEY)
    assert row is not None
    row.status = "ready"
    row.source_fingerprint = fingerprint_story_memory_sources(
        await collect_story_memory_source_tokens(session, PROJECT_ID)
    )
    await session.flush()


async def _prepare(session: AsyncSession, monkeypatch, results_by_index):
    await _seed(session)
    await session.commit()

    module = importlib.import_module(MODULE_PATH)
    retrieval = FakeRetrievalService(results_by_index)
    monkeypatch.setattr(module, "OpenFicRetrievalService", lambda: retrieval)

    async def _fake_build_embedding_client(session_, model_ref_id: str):
        _ = (session_, model_ref_id)
        return FakeEmbeddingClient(config=None)

    monkeypatch.setattr(module, "_build_embedding_client", _fake_build_embedding_client)
    tool = ToolRegistry.get_tools(names=["search_story_memory"], state=_state())[0]
    return module, retrieval, tool


async def _invoke(tool, session: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
    raw = await tool.ainvoke(payload, config={"configurable": {"db_session": session}})
    return json.loads(raw)


@pytest.mark.asyncio
async def test_default_sources_exclude_narrative_state(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """不传参数时行为与叙事来源引入之前一致：不检索叙事状态。"""
    _module, retrieval, tool = await _prepare(session, monkeypatch, {})

    data = await _invoke(tool, session, {"query": "北城"})

    assert data["searched_sources"] == [
        "character",
        "world_entry",
        "outline",
        "note",
    ]
    # 章节索引尚未建立，叙事状态来源则不在默认集合里。
    assert data["skipped_sources"] == ["chapter"]
    assert retrieval.queries == [STORY_MEMORY_INDEX_KEY] * 4
    pushed = [builder.filters["source"] for builder in retrieval.builders]
    assert pushed == ["character", "world_entry", "outline", "note"]


@pytest.mark.asyncio
async def test_narrative_profile_searches_only_narrative_sources(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _module, retrieval, tool = await _prepare(session, monkeypatch, {})

    data = await _invoke(tool, session, {"query": "北城", "profile": "narrative"})

    assert data["skipped_sources"] == []
    assert len(retrieval.queries) == 4
    pushed = [builder.filters["source"] for builder in retrieval.builders]
    assert pushed == ["world_fact", "character_belief", "open_plotline", "scene_state"]


@pytest.mark.asyncio
async def test_sources_argument_overrides_profile(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _module, retrieval, tool = await _prepare(session, monkeypatch, {})

    await _invoke(
        tool,
        session,
        {"query": "北城", "profile": "narrative", "sources": ["world_fact"]},
    )

    assert retrieval.queries == [STORY_MEMORY_INDEX_KEY]
    assert retrieval.builders[0].filters["source"] == "world_fact"


@pytest.mark.asyncio
async def test_unknown_profile_is_rejected(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    _module, retrieval, tool = await _prepare(session, monkeypatch, {})

    data = await _invoke(tool, session, {"query": "北城", "profile": "unknown"})

    assert data["type"] == "fail"
    assert data["code"] == "validation_error"
    assert retrieval.queries == []


@pytest.mark.asyncio
async def test_narrative_result_is_rendered_from_current_row(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """向量命中的是旧文本时，返回给模型的一律是数据库当前行渲染的结果。"""
    obsolete = "旧文本：北城只有一座城门"
    results = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk("world_fact", "fact-1", obsolete, 0.9),
            _entity_chunk("character_belief", "belief-1", "旧信念文本", 0.8),
        ]
    }
    _module, _retrieval, tool = await _prepare(session, monkeypatch, results)

    data = await _invoke(
        tool,
        session,
        {"query": "北城", "sources": ["world_fact", "character_belief"]},
    )

    rendered = json.dumps(data, ensure_ascii=False)
    assert obsolete not in rendered
    assert "旧信念文本" not in rendered
    assert "北城有三座城门" in rendered
    assert "世界事实" in rendered
    assert "人物信念" in rendered
    assert "林洛" in rendered

    by_source = {item["source"]: item for item in data["results"]}
    assert by_source["world_fact"]["source_label"] == "世界事实"
    assert by_source["character_belief"]["source_label"] == "人物信念"
    assert by_source["character_belief"]["entity_id"] == "belief-1"
    # 已确认的误解仍然是「人物相信」，不得写成世界事实。
    assert "世界事实（" not in by_source["character_belief"]["text"]


@pytest.mark.asyncio
async def test_unconfirmed_narrative_rows_are_dropped_even_when_index_hits(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """旧索引里残留的候选记录命中后必须在交付前丢弃。"""
    leaked = "泄漏哨兵-未确认断言"
    results = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk("world_fact", "fact-candidate", leaked, 0.99),
            _entity_chunk("world_fact", "fact-1", "北城有三座城门", 0.4),
        ]
    }
    _module, _retrieval, tool = await _prepare(session, monkeypatch, results)

    data = await _invoke(tool, session, {"query": "断言", "sources": ["world_fact"]})

    rendered = json.dumps(data, ensure_ascii=False)
    assert leaked not in rendered
    assert [item["entity_id"] for item in data["results"]] == ["fact-1"]


@pytest.mark.asyncio
async def test_scene_result_keeps_author_only_marker(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    results = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk("scene_state", "scene-1", "旧场景文本", 0.9),
        ]
    }
    _module, _retrieval, tool = await _prepare(session, monkeypatch, results)

    data = await _invoke(tool, session, {"query": "客栈", "sources": ["scene_state"]})

    assert [item["entity_id"] for item in data["results"]] == ["scene-1"]
    text = data["results"][0]["text"]
    assert "真凶其实是管家" in text
    assert SCENE_AUTHOR_ONLY_MARKER in text
    # 隐藏信息永远排在「本场已知信息」区块之后，不会被当成已知信息。
    assert text.index("本场已知信息") < text.index(SCENE_AUTHOR_ONLY_MARKER)


@pytest.mark.asyncio
async def test_open_plotline_result_is_retrievable(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    results = {
        STORY_MEMORY_INDEX_KEY: [
            _entity_chunk("open_plotline", "plotline-1", "旧情节线", 0.9),
        ]
    }
    _module, _retrieval, tool = await _prepare(session, monkeypatch, results)

    data = await _invoke(tool, session, {"query": "兄长", "sources": ["open_plotline"]})

    assert data["results"][0]["title"] == "失踪的兄长"
    assert data["results"][0]["source_label"] == "情节线"
    assert "尚未兑现" in data["results"][0]["text"]


@pytest.mark.asyncio
async def test_stale_narrative_index_skips_sources_without_embedding(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """叙事状态一改，故事记忆来源直接跳过：不会为此重新读取正文或重新嵌入。"""
    results: dict[str, list[ChunkSearchResult]] = {STORY_MEMORY_INDEX_KEY: []}
    _module, retrieval, tool = await _prepare(session, monkeypatch, results)

    session.add(
        WorldFact(
            id="fact-new",
            project_id=PROJECT_ID,
            statement="新增的已确认断言",
            status="confirmed",
            confirmation="confirmed",
        )
    )
    await session.flush()

    data = await _invoke(tool, session, {"query": "断言", "sources": ["world_fact"]})

    assert data["searched_sources"] == []
    assert data["skipped_sources"] == ["world_fact"]
    assert data["results"] == []
    # 没有发起任何向量检索，也就没有产生嵌入调用。
    assert retrieval.queries == []


@pytest.mark.asyncio
async def test_narrative_results_respect_retrieval_token_budget(
    session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """叙事结果同样受检索 token 预算约束，不会把全部条目一次性塞进上下文。"""
    results: dict[str, list[ChunkSearchResult]] = {STORY_MEMORY_INDEX_KEY: []}
    module, _retrieval, tool = await _prepare(session, monkeypatch, results)

    long_statement = "北城常年阴雨，城墙外终年积水。" * 20
    facts = [
        WorldFact(
            id=f"fact-budget-{index}",
            project_id=PROJECT_ID,
            statement=long_statement,
            status="confirmed",
            confirmation="confirmed",
        )
        for index in range(4)
    ]
    session.add_all(facts)
    await session.flush()
    results[STORY_MEMORY_INDEX_KEY] = [
        _entity_chunk("world_fact", fact.id, "旧文本", 0.9 - index * 0.05)
        for index, fact in enumerate(facts)
    ]
    await _certify_index(session)

    monkeypatch.setattr(module, "retrieval_token_budget", lambda *args, **kwargs: 20000)
    unbounded = await _invoke(
        tool, session, {"query": "北城", "sources": ["world_fact"], "limit": 4}
    )
    assert len(unbounded["results"]) == 4

    # 预算收紧后条目数与文本长度同时被裁剪，绝不整包塞进上下文。
    monkeypatch.setattr(module, "retrieval_token_budget", lambda *args, **kwargs: 150)
    bounded = await _invoke(
        tool, session, {"query": "北城", "sources": ["world_fact"], "limit": 4}
    )

    assert 1 <= len(bounded["results"]) < len(unbounded["results"])
    assert len(json.dumps(bounded, ensure_ascii=False)) < len(
        json.dumps(unbounded, ensure_ascii=False)
    )
