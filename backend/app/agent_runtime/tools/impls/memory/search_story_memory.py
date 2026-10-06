"""Story Memory 统一检索工具。

把章节索引（chapters:<project_id>）与 Story Memory 索引（story_memory:<project_id>）
的检索结果合并为一份带来源标注的结果列表，供 Agent 一次性取到
正文、人物、世界设定、大纲与笔记上下文。

复用既有 OpenFicRetrievalService 与索引 contract，不新建第二套 RAG；
只读，不写入任何数据，且严格按 project_id 过滤。
"""

import json
from collections import OrderedDict
from typing import Any, Literal

from loguru import logger
from pydantic import BaseModel, Field, field_validator

from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.context.budget import retrieval_token_budget
from app.agent_runtime.context.compaction.tokens import count_text_tokens
from app.agent_runtime.tools.impls.chapter.search_chapters import (
    _build_rerank_client,
    _compute_index_freshness,
)
from app.agent_runtime.tools.registry import ToolRegistry
from app.background.jobs.definitions.retrieval_chapter_index_batch import (
    _build_embedding_client,
)
from app.models.clients.rerank_client import RerankClient
from app.models.repos import model_repo
from app.retrieval.chapter_index import (
    INDEX_STATUS_FRESH,
    SETTING_KEY_DEFAULT_EMBEDDING_MODEL,
    chapter_index_key,
    get_index_settings,
)
from app.retrieval.service import IndexNotReadyError, OpenFicRetrievalService
from app.retrieval.story_memory import (
    story_memory_index_is_fresh,
    story_memory_index_key,
)
from app.retrieval.types import ChunkSearchResult
from app.retrieval.token_budget import fit_ranked_text_results
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

ALL_SOURCES: tuple[str, ...] = (
    "chapter",
    "character",
    "world_entry",
    "outline",
    "note",
)

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
MAX_ECHOED_QUERY_CHARS = 160


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

    @field_validator("sources", mode="before")
    @classmethod
    def normalize_json_sources(cls, value: Any) -> Any:
        # Some compatible providers encode nested arrays as JSON strings.
        # Decode only this bounded read filter; Literal validation remains authoritative.
        if isinstance(value, str) and len(value) <= 512:
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError:
                return value
            if isinstance(decoded, list):
                return decoded
        return value


class StoryMemoryResultItem(BaseModel):
    source: str
    source_label: str
    title: str
    text: str
    score: float = Field(
        description=(
            "检索置信度：hybrid 融合后的归一化 RRF 分数（0~1）。"
            "未启用重排时即为排序依据；启用重排时排序以 rerank_score 为准"
        ),
    )
    rerank_score: float | None = Field(
        default=None,
        description=(
            "重排模型给出的相关度（0~1），未启用重排时为 null。"
            "启用重排时结果顺序由该值决定，与 score 量纲不同，两者不可直接比较"
        ),
    )
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


def _candidate_sort_key(item: tuple[str, ChunkSearchResult]) -> tuple[int, float]:
    """候选排序键：启用 rerank 时以重排相关度为准，否则沿用 RRF 置信度。

    重排过的候选一律排在未重排候选之前，避免两种分数量纲混排。
    """
    result = item[1]
    if result.rerank_score is not None:
        return (1, result.rerank_score)
    return (0, result.score)


def _per_source_candidate_budget(source_count: int) -> int:
    """把候选池均分给被请求的来源，保证每个来源都有确定的最小配额。

    Story Memory 的各来源共用同一个索引。若只在全局 top-k 之后才按来源过滤，
    条目数量多的来源（人物、世界设定）会占满候选池，把大纲、笔记饿死，
    导致被显式请求的来源也拿不到结果。
    """
    if source_count <= 0:
        return 1
    return max(1, CANDIDATE_TOP_K // source_count)


class _CachedEmbeddingClient:
    """同一次工具调用内复用同一句查询的向量。

    来源过滤下推后，一句查询会被章节索引与每个 Story Memory 来源各检索一次；
    不缓存就会对同一句查询重复调用 embedding 服务。
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self._vectors: dict[str, list[float]] = {}

    async def embed_single(self, text: str) -> list[float]:
        cached = self._vectors.get(text)
        if cached is None:
            cached = await self._inner.embed_single(text)
            self._vectors[text] = cached
        return cached

    def __getattr__(self, name: str) -> Any:
        # 其余属性（例如 config）透传给真实 client。
        return getattr(self._inner, name)


def _push_down_source_filter(query_builder: Any, source: str) -> Any:
    """把来源过滤下推到检索阶段：先按来源缩小候选池，再检索。

    旧索引契约未声明 source 过滤字段时退回不过滤：调用方仍会按 metadata.source
    过滤，结果语义不变，只是候选池退回全局 top-k。
    """
    try:
        return query_builder.filter_eq("source", source)
    except ValueError:
        logger.debug("故事记忆检索: 来源过滤未能下推 source={}", source)
        return query_builder


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


async def _rerank_merged_candidates(
    rerank_client: RerankClient,
    query: str,
    candidates: list[tuple[str, ChunkSearchResult]],
) -> None:
    """对合并后的 Story Memory 候选池重排一次，并按相关度就地写回 rerank_score。

    各来源仍按配额分别检索，但只在这一个合并候选池上调用重排接口：来源之间的
    相关度来自同一个模型与同一句查询，量纲一致，可以直接比较；按来源逐次重排
    只会把网络调用次数放大到来源数量倍，排序结果并不会更好。

    代价是各来源先按 RRF 截断到配额、再交给重排模型，同一来源内 RRF 排名靠后的
    条目无法再靠重排翻盘；这是为「保留来源配额」付出的确定性代价，不是遗漏。

    失败语义与章节检索一致：底层 provider 错误不暴露给模型。
    """
    if not candidates:
        return
    documents = [row.text or "" for _, row in candidates]
    try:
        response = await rerank_client.rerank(query, documents, top_n=len(documents))
        for item in response.results:
            candidates[item.index][1].rerank_score = max(
                0.0, min(float(item.relevance_score), 1.0)
            )
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, ToolExecutionError):
            raise
        raise ToolExecutionError("故事记忆检索执行失败") from exc


async def _query_index(
    session,
    *,
    index_key: str,
    project_id: str,
    query: str,
    embedding_client,
    rerank_client: RerankClient | None = None,
    source: str | None = None,
    candidate_limit: int = CANDIDATE_TOP_K,
) -> list[ChunkSearchResult]:
    try:
        builder = await OpenFicRetrievalService().query(
            session, index_key, query, embedding_client
        )
        query_builder = (
            builder.hybrid()
            .vector_top_k(candidate_limit)
            .bm25_top_k(candidate_limit)
            .ef(200)
            .filter_eq("project_id", project_id)
        )
        if source is not None:
            query_builder = _push_down_source_filter(query_builder, source)
        # 章节索引沿用既有行为：配置了 rerank 时先重排候选池，再套用取回上限。
        # Story Memory 各来源不在这里重排，由调用方对合并后的候选池统一重排一次。
        if rerank_client is not None:
            query_builder = query_builder.rerank(rerank_client, top_n=candidate_limit)
        return await query_builder.limit(candidate_limit).run()
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
                raise ToolExecutionError(
                    "未配置 default_embedding_model，无法检索故事记忆"
                )
            model = await model_repo.get_by_id(session, model_ref_id)
            if model is None or model.task_type != "embedding":
                raise ToolExecutionError(
                    "default_embedding_model 不存在或不是 embedding 模型"
                )
            if model.dimensions is None:
                raise ToolExecutionError(
                    "default_embedding_model 缺少 embedding dimensions"
                )
            try:
                embedding_client = await _build_embedding_client(session, model_ref_id)
            except Exception as exc:  # noqa: BLE001
                if isinstance(exc, ToolExecutionError):
                    raise
                raise ToolExecutionError(
                    "故事记忆检索 embedding client 初始化失败"
                ) from exc
            # 一句查询会被章节索引与每个 Story Memory 来源各检索一次，缓存查询向量。
            query_embedding_client = _CachedEmbeddingClient(embedding_client)

            index_config = await get_index_settings(session)
            rerank_client: RerankClient | None = None
            if index_config.rerank_enabled and index_config.rerank_model_ref_id:
                # 未配置可用的 rerank 模型时返回 None，降级为纯 RRF 排序。
                rerank_client = await _build_rerank_client(
                    session, index_config.rerank_model_ref_id
                )

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
                            embedding_client=query_embedding_client,
                            rerank_client=rerank_client,
                        )
                        candidates.extend(("chapter", row) for row in rows)
                        searched.append("chapter")
                    else:
                        skipped.append("chapter")
                else:
                    skipped.append("chapter")

            memory_sources = list(
                dict.fromkeys(
                    source for source in requested if source in STORY_MEMORY_SOURCES
                )
            )
            if memory_sources:
                index_key = story_memory_index_key(self.project_id)
                if await story_memory_index_is_fresh(
                    session,
                    project_id=self.project_id,
                ):
                    # 每个来源各自检索一次：来源过滤在检索之前下推，
                    # 候选配额按来源数量均分。否则条目数量多的来源会占满全局
                    # top-k，使被显式请求的来源（例如大纲）拿不到任何结果。
                    # 各来源不单独重排：候选合并成一个池子后统一重排一次，
                    # 既保留来源配额，又不把重排的网络调用放大到来源数量倍。
                    candidate_limit = _per_source_candidate_budget(len(memory_sources))
                    memory_candidates: list[tuple[str, ChunkSearchResult]] = []
                    for memory_source in memory_sources:
                        rows = await _query_index(
                            session,
                            index_key=index_key,
                            project_id=self.project_id,
                            query=effective_query,
                            embedding_client=query_embedding_client,
                            source=memory_source,
                            candidate_limit=candidate_limit,
                        )
                        for row in rows:
                            # 来源过滤未能下推（旧索引契约或旧引擎）时的兜底：
                            # 这里按 metadata.source 再过滤一次，语义不变。
                            if _metadata_str(row, "source") == memory_source:
                                memory_candidates.append((memory_source, row))
                    if rerank_client is not None:
                        await _rerank_merged_candidates(
                            rerank_client, effective_query, memory_candidates
                        )
                    candidates.extend(memory_candidates)
                    searched.extend(memory_sources)
                else:
                    skipped.extend(memory_sources)

            candidates.sort(key=_candidate_sort_key, reverse=True)

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
                            rerank_score=row.rerank_score,
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
                        rerank_score=row.rerank_score,
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
                searched = [
                    source for source in searched if source not in memory_sources
                ]
                skipped.extend(
                    source for source in memory_sources if source not in skipped
                )

            response_query = effective_query

            def render_results(
                items: list[StoryMemoryResultItem],
            ) -> str:
                return SearchStoryMemoryOutput(
                    query=response_query,
                    searched_sources=searched,
                    skipped_sources=skipped,
                    results=items,
                ).model_dump_json()

            max_tokens = retrieval_token_budget(
                self.runtime_state.get("model_config"),
                tool_schema_tokens=self.context_tool_schema_tokens,
            )
            empty_result_output = render_results([])
            if count_text_tokens(empty_result_output) > max_tokens:
                response_query = effective_query[:MAX_ECHOED_QUERY_CHARS]
                if len(effective_query) > MAX_ECHOED_QUERY_CHARS:
                    response_query += "…"
            bounded_results = fit_ranked_text_results(
                list(results.values()),
                token_budget=max_tokens,
                render=render_results,
            )
            return render_results(bounded_results)
        finally:
            if owns_session:
                await session.close()
