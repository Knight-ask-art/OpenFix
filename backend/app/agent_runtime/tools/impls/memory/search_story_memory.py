"""Story Memory 统一检索工具。

把章节索引（chapters:<project_id>）与 Story Memory 索引（story_memory:<project_id>）
的检索结果合并为一份带来源标注的结果列表，供 Agent 一次性取到
正文、人物、世界设定、大纲与笔记上下文。

复用既有 OpenFicRetrievalService 与索引 contract，不新建第二套 RAG；
只读，不写入任何数据，且严格按 project_id 过滤。
"""

from collections import OrderedDict
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.chapter.search_chapters import (
    _compute_index_freshness,
)
from app.agent_runtime.tools.registry import ToolRegistry
from app.background.jobs.definitions.retrieval_chapter_index_batch import (
    _build_embedding_client,
)
from app.models.repos import model_repo
from app.retrieval.chapter_index import (
    INDEX_STATUS_FRESH,
    SETTING_KEY_DEFAULT_EMBEDDING_MODEL,
    chapter_index_key,
)
from app.retrieval.service import IndexNotReadyError, OpenFicRetrievalService
from app.retrieval.story_memory import (
    story_memory_index_is_fresh,
    story_memory_index_key,
)
from app.retrieval.types import ChunkSearchResult
from app.storage.database import create_session
from app.storage.repos import (
    chapter_repo,
    character_repo,
    note_repo,
    outline_repo,
    retrieval_index_repo,
    setting_repo,
    world_info_repo,
    world_info_entry_repo,
)
from app.storage.services import world_entry_meta_service

StoryMemorySource = Literal["chapter", "character", "world_entry", "outline", "note"]

ALL_SOURCES: tuple[str, ...] = ("chapter", "character", "world_entry", "outline", "note")

# Story Memory 索引里除章节外的数据源。
STORY_MEMORY_SOURCES: tuple[str, ...] = ("character", "world_entry", "outline", "note")

STORY_SOURCE_LABELS: dict[str, str] = {
    "chapter": "章节",
    "character": "人物",
    "world_entry": "世界设定",
    "outline": "大纲",
    "note": "笔记",
}

# 单次检索的候选池与最终返回条数。
CANDIDATE_TOP_K = 20
DEFAULT_RESULT_LIMIT = 8
MAX_RESULT_LIMIT = 20
MAX_RESULT_TEXT_CHARS = 1_200


class SearchStoryMemoryInput(BaseModel):
    query: str = Field(description="检索语句")
    sources: list[StoryMemorySource] | None = Field(
        default=None,
        description="可选：限定检索的数据源（chapter / character / world_entry / outline / note），默认全部",
    )
    limit: int = Field(
        default=DEFAULT_RESULT_LIMIT,
        ge=1,
        le=MAX_RESULT_LIMIT,
        description="返回结果条数上限",
    )


class StoryMemoryResultItem(BaseModel):
    source: str
    source_label: str
    title: str
    text: str
    score: float
    entity_id: str | None = None
    chapter_order: int | None = None
    volume_id: str | None = None


class SearchStoryMemoryOutput(BaseModel):
    query: str
    searched_sources: list[str]
    skipped_sources: list[str]
    results: list[StoryMemoryResultItem]


def _metadata_str(result: ChunkSearchResult, key: str) -> str | None:
    value = result.metadata.get(key)
    return value if isinstance(value, str) and value else None


async def _resolve_story_entity(
    session, source: str, entity_id: str, project_id: str
) -> str | None:
    """返回 Story Memory 条目的当前标题；实体已删除或不属于本项目时返回 None。"""
    if source == "character":
        character = await character_repo.get_by_id(session, entity_id)
        if character is None or character.project_id != project_id:
            return None
        return character.name
    if source == "world_entry":
        entry = await world_info_entry_repo.get_by_id(session, entity_id)
        if entry is None:
            return None
        world_info = await world_info_repo.get_by_id(session, entry.world_info_id)
        if world_info is None or world_info.project_id != project_id:
            return None
        if not await world_entry_meta_service.is_entry_ai_visible(session, entity_id):
            return None
        return entry.name
    if source == "outline":
        outline = await outline_repo.get_by_id(session, entity_id)
        if outline is None or outline.project_id != project_id:
            return None
        return (outline.title or "").strip() or "（未命名）"
    if source == "note":
        note = await note_repo.get_by_id(session, entity_id)
        if note is None or note.project_id != project_id:
            return None
        if note.is_hidden:
            # 隐藏笔记不得进入模型上下文，即使旧索引仍声称是最新的。
            return None
        return (note.title or "").strip() or "（未命名）"
    return None


async def _query_index(
    session,
    *,
    index_key: str,
    project_id: str,
    query: str,
    embedding_client,
) -> list[ChunkSearchResult]:
    try:
        builder = await OpenFicRetrievalService().query(
            session, index_key, query, embedding_client
        )
        return (
            await builder.hybrid()
            .vector_top_k(CANDIDATE_TOP_K)
            .bm25_top_k(CANDIDATE_TOP_K)
            .ef(200)
            .filter_eq("project_id", project_id)
            .limit(CANDIDATE_TOP_K)
            .run()
        )
    except IndexNotReadyError:
        return []
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, ToolExecutionError):
            raise
        # 不向模型暴露底层检索库的原始错误信息。
        raise ToolExecutionError("故事记忆检索执行失败") from exc


async def _index_is_ready(session, index_key: str) -> bool:
    row = await retrieval_index_repo.get_by_index_key(session, index_key)
    return row is not None and row.status == "ready"


@ToolRegistry.register
class SearchStoryMemoryTool(AgentTool):
    name: str = "search_story_memory"
    description: str = (
        "在当前项目的故事记忆中做统一语义检索，一次返回相关的章节正文、人物、"
        "世界设定、大纲与笔记，并标注每一条的来源"
    )
    access_level: str = "readonly"
    args_schema: type[BaseModel] = SearchStoryMemoryInput

    async def _execute(
        self,
        query: str,
        sources: list[str] | None = None,
        limit: int = DEFAULT_RESULT_LIMIT,
    ) -> str:
        effective_query = (query or "").strip()
        if not effective_query:
            raise ToolExecutionError("检索语句不能为空")

        source_selection = ALL_SOURCES if sources is None else sources
        requested = tuple(
            source for source in source_selection if source in ALL_SOURCES
        )
        if not requested:
            raise ToolExecutionError("没有可检索的数据源")

        session = self.get_runtime_db_session()
        owns_session = session is None
        if session is None:
            session = await create_session()
        try:
            setting = await setting_repo.get_by_key(
                session, SETTING_KEY_DEFAULT_EMBEDDING_MODEL
            )
            model_ref_id = setting.value.strip() if setting is not None else ""
            if not model_ref_id:
                raise ToolExecutionError("未配置 default_embedding_model，无法检索故事记忆")
            model = await model_repo.get_by_id(session, model_ref_id)
            if model is None or model.task_type != "embedding":
                raise ToolExecutionError(
                    "default_embedding_model 不存在或不是 embedding 模型"
                )
            if model.dimensions is None:
                raise ToolExecutionError("default_embedding_model 缺少 embedding dimensions")
            try:
                embedding_client = await _build_embedding_client(session, model_ref_id)
            except Exception as exc:  # noqa: BLE001
                if isinstance(exc, ToolExecutionError):
                    raise
                raise ToolExecutionError("故事记忆检索 embedding client 初始化失败") from exc

            candidates: list[tuple[str, ChunkSearchResult]] = []
            searched: list[str] = []
            skipped: list[str] = []

            if "chapter" in requested:
                index_key = chapter_index_key(self.project_id)
                if await _index_is_ready(session, index_key):
                    freshness = await _compute_index_freshness(
                        session,
                        project_id=self.project_id,
                        model=model,
                    )
                    if freshness == INDEX_STATUS_FRESH:
                        rows = await _query_index(
                            session,
                            index_key=index_key,
                            project_id=self.project_id,
                            query=effective_query,
                            embedding_client=embedding_client,
                        )
                        candidates.extend(("chapter", row) for row in rows)
                        searched.append("chapter")
                    else:
                        skipped.append("chapter")
                else:
                    skipped.append("chapter")

            memory_sources = [source for source in requested if source in STORY_MEMORY_SOURCES]
            if memory_sources:
                index_key = story_memory_index_key(self.project_id)
                if await story_memory_index_is_fresh(
                    session,
                    project_id=self.project_id,
                ):
                    rows = await _query_index(
                        session,
                        index_key=index_key,
                        project_id=self.project_id,
                        query=effective_query,
                        embedding_client=embedding_client,
                    )
                    for row in rows:
                        source = _metadata_str(row, "source")
                        if source in memory_sources:
                            candidates.append((source, row))
                    searched.extend(memory_sources)
                else:
                    skipped.extend(memory_sources)

            candidates.sort(key=lambda item: item[1].score, reverse=True)

            # 章节结果以数据库当前状态为准，并过滤掉不属于本项目的分块。
            chapter_ids = list(
                dict.fromkeys(
                    chapter_id
                    for source, row in candidates
                    if source == "chapter"
                    and (chapter_id := _metadata_str(row, "chapter_id")) is not None
                )
            )
            chapters_by_id: dict[str, Any] = {}
            if chapter_ids:
                for chapter in await chapter_repo.get_by_ids(session, chapter_ids):
                    if chapter.project_id == self.project_id:
                        chapters_by_id[chapter.id] = chapter

            results: OrderedDict[tuple[str, str], StoryMemoryResultItem] = OrderedDict()
            for source, row in candidates:
                if len(results) >= limit:
                    break
                text = (row.text or "").strip()
                if not text:
                    continue
                if source == "chapter":
                    entity_id = _metadata_str(row, "chapter_id")
                    chapter = chapters_by_id.get(entity_id) if entity_id else None
                    if chapter is None:
                        continue
                    results.setdefault(
                        ("chapter", chapter.id),
                        StoryMemoryResultItem(
                            source=source,
                            source_label=STORY_SOURCE_LABELS[source],
                            title=(chapter.title or "").strip(),
                            text=text[:MAX_RESULT_TEXT_CHARS],
                            score=row.score,
                            entity_id=chapter.id,
                            chapter_order=chapter.order,
                            volume_id=chapter.volume_id,
                        ),
                    )
                    continue

                entity_id = _metadata_str(row, "entity_id")
                if entity_id is None:
                    continue
                label = await _resolve_story_entity(
                    session, source, entity_id, self.project_id
                )
                if label is None:
                    # 实体已被删除或不属于本项目：索引是旧的，不返回悬空结果。
                    continue
                results.setdefault(
                    (source, entity_id),
                    StoryMemoryResultItem(
                        source=source,
                        source_label=STORY_SOURCE_LABELS.get(source, source),
                        title=label,
                        text=text[:MAX_RESULT_TEXT_CHARS],
                        score=row.score,
                        entity_id=entity_id,
                    ),
                )

            memory_searched = any(source in searched for source in memory_sources)
            if memory_searched and not await story_memory_index_is_fresh(
                session,
                project_id=self.project_id,
            ):
                # A source can change while retrieval results are being
                # hydrated. Drop those results before they reach the model.
                results = OrderedDict(
                    (key, item)
                    for key, item in results.items()
                    if item.source == "chapter"
                )
                searched = [source for source in searched if source not in memory_sources]
                skipped.extend(
                    source for source in memory_sources if source not in skipped
                )

            return SearchStoryMemoryOutput(
                query=effective_query,
                searched_sources=searched,
                skipped_sources=skipped,
                results=list(results.values()),
            ).model_dump_json()
        finally:
            if owns_session:
                await session.close()
