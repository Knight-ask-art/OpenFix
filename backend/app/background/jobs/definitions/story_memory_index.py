"""Background job that rebuilds the project story memory retrieval index."""

from pydantic import BaseModel

from loguru import logger

from app.background.jobs.base import EmptyJobResult, JobDefinition
from app.background.jobs.constants import (
    JOB_QUEUE_LLM,
    JOB_TYPE_STORY_MEMORY_REBUILD,
)
from app.background.jobs.definitions.retrieval_chapter_index_batch import (
    _build_embedding_client,
)
from app.background.runtime.context import JobContext
from app.retrieval.service import OpenFicRetrievalService
from app.retrieval.story_memory import (
    build_story_memory_documents,
    collect_story_memory_source_tokens,
    fingerprint_story_memory_sources,
    story_memory_index_key,
)
from app.storage.repos import retrieval_index_repo, setting_repo

SETTING_KEY_DEFAULT_EMBEDDING_MODEL = "default_embedding_model"


class StoryMemoryRebuildInput(BaseModel):
    project_id: str


class StoryMemoryRebuildContext(BaseModel):
    embedding_model_ref_id: str


async def handle_story_memory_rebuild(context: JobContext) -> dict[str, int]:
    job_input = StoryMemoryRebuildInput.model_validate(context.input)
    metadata = StoryMemoryRebuildContext.model_validate(context.metadata)
    project_id = job_input.project_id

    await context.check_cancelled()

    setting = await setting_repo.get_by_key(
        context.session, SETTING_KEY_DEFAULT_EMBEDDING_MODEL
    )
    current_model_ref_id = setting.value.strip() if setting is not None else ""
    if current_model_ref_id != metadata.embedding_model_ref_id:
        raise RuntimeError("default_embedding_model changed; start the rebuild again")

    # 先取一次便宜的来源令牌，作为本次构建的认证快照：它不读正文，
    # 却在源数据增删改或可见性 / 确认状态切换时逐字变化。
    source_tokens = await collect_story_memory_source_tokens(
        context.session, project_id
    )
    source_fingerprint = fingerprint_story_memory_sources(source_tokens)
    documents = await build_story_memory_documents(context.session, project_id)
    embedding_client = await _build_embedding_client(
        context.session, metadata.embedding_model_ref_id
    )
    result = await OpenFicRetrievalService().rebuild(
        context.session,
        story_memory_index_key(project_id),
        documents,
        embedding_client,
    )
    index_row = await retrieval_index_repo.get_by_index_key(
        context.session, story_memory_index_key(project_id)
    )
    if index_row is not None:
        # A partial rebuild must never certify the snapshot as fresh. If a
        # source changes while embeddings are built, a later freshness check
        # compares the live documents with this captured snapshot and reports
        # stale until another rebuild succeeds.
        index_row.source_fingerprint = (
            source_fingerprint
            if result.failed_count == 0
            and result.succeeded_count == result.total_documents
            else None
        )
        await retrieval_index_repo.update(context.session, index_row)
    await context.session.commit()
    logger.info(
        f"story memory rebuild done: project={project_id}, "
        f"succeeded={result.succeeded_count}, failed={result.failed_count}"
    )
    return {
        "total": result.total_documents,
        "succeeded": result.succeeded_count,
        "failed": result.failed_count,
    }


STORY_MEMORY_REBUILD_JOB = JobDefinition(
    type=JOB_TYPE_STORY_MEMORY_REBUILD,
    name="故事记忆索引重建",
    description="把人物、世界设定、大纲、笔记，以及已确认的世界事实、人物信念、情节线与场景计划全量重建到检索索引",
    input_model=StoryMemoryRebuildInput,
    handler=handle_story_memory_rebuild,
    result_model=EmptyJobResult,
    default_queue=JOB_QUEUE_LLM,
    default_timeout_seconds=600,
    supports_cancel=True,
)
