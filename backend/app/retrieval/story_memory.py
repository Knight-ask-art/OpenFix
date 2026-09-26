# -*- coding: utf-8 -*-
"""
Story Memory retrieval - 把人物、世界设定、大纲、笔记统一索引到独立检索表。

与章节索引共用 OpenFicRetrievalService（同一 LanceDB 引擎与 contract 机制），
只是 index_key 与文档来源不同；story memory 内容体量小，采用全量重建策略。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.background.jobs import service as background_service
from app.background.jobs.constants import JOB_TYPE_STORY_MEMORY_REBUILD
from app.background.jobs.states import JOB_STATUS_PENDING, JOB_STATUS_RUNNING
from app.retrieval.chapter_index import (
    DEFAULT_INDEX_CHUNK_OVERLAP,
    DEFAULT_INDEX_CHUNK_SIZE,
    resolve_index_embedding_model,
    get_index_settings,
)
from app.retrieval.service import OpenFicRetrievalService
from app.retrieval.types import (
    FilterableField,
    FilterableFieldType,
    IndexDocument,
    RetrievalIndexContract,
)
from app.storage.repos import (
    chapter_repo,
    character_repo,
    note_repo,
    outline_repo,
    retrieval_index_repo,
    world_info_entry_repo,
    world_info_repo,
)

STORY_MEMORY_SOURCES = ("character", "world_entry", "outline", "note")


def story_memory_index_key(project_id: str) -> str:
    return f"story_memory:{project_id}"


def story_document_id(source: str, entity_id: str) -> str:
    return f"{source}:{entity_id}"


def _join_parts(*parts: str) -> str:
    return "\n".join(part for part in parts if part.strip())


async def build_story_memory_documents(
    session: AsyncSession, project_id: str
) -> list[IndexDocument]:
    """收集项目内人物、世界设定、大纲、笔记，构建待索引文档。"""
    documents: list[IndexDocument] = []

    for character in await character_repo.list_all_by_project(session, project_id):
        text = _join_parts(
            f"人物：{character.name}",
            character.description,
        )
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("character", character.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "character"},
                    metadata={"source": "character", "entity_id": character.id},
                )
            )

    world_info = await world_info_repo.get_by_project_id(session, project_id)
    if world_info is not None:
        for entry in await world_info_entry_repo.list_enabled_by_world_info(
            session, world_info.id
        ):
            text = _join_parts(
                f"世界设定：{entry.name}",
                entry.content,
            )
            if text.strip():
                documents.append(
                    IndexDocument(
                        document_id=story_document_id("world_entry", entry.id),
                        text=text,
                        attributes={"project_id": project_id, "source": "world_entry"},
                        metadata={"source": "world_entry", "entity_id": entry.id},
                    )
                )

    for outline in await outline_repo.list_by_project(session, project_id):
        text = _join_parts(
            f"大纲[{outline.level}]：{outline.title}",
            outline.content,
        )
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("outline", outline.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "outline"},
                    metadata={"source": "outline", "entity_id": outline.id},
                )
            )

    for note in await note_repo.list_by_project(session, project_id):
        text = _join_parts(
            f"笔记：{note.title}",
            note.content,
        )
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("note", note.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "note"},
                    metadata={"source": "note", "entity_id": note.id},
                )
            )

    return documents


def build_story_memory_contract(model) -> RetrievalIndexContract:
    if model.dimensions is None:
        raise ValueError("default_embedding_model 必须提供 embedding dimensions")
    return RetrievalIndexContract(
        embedding_model_ref_id=model.id,
        embedding_model_id_snapshot=model.model_id,
        embedding_dimensions_snapshot=model.dimensions,
        distance_metric="cosine",
        chunker_type="recursive_character",
        chunk_size=DEFAULT_INDEX_CHUNK_SIZE,
        chunk_overlap=DEFAULT_INDEX_CHUNK_OVERLAP,
        filterable_fields=[
            FilterableField(name="project_id", field_type=FilterableFieldType.STRING),
            FilterableField(name="source", field_type=FilterableFieldType.STRING),
        ],
    )


async def ensure_story_memory_index(
    session: AsyncSession, project_id: str, model
) -> None:
    service = OpenFicRetrievalService()
    await service.register_index(
        session,
        story_memory_index_key(project_id),
        build_story_memory_contract(model),
        replace_contract_if_needs_rebuild=True,
    )


@dataclass
class StoryMemorySourceCounts:
    characters: int = 0
    world_entries: int = 0
    outlines: int = 0
    notes: int = 0
    chapters: int = 0


@dataclass
class StoryMemoryStatus:
    project_id: str
    embedding_configured: bool
    index_status: str
    last_error: str | None = None
    last_ready_at: datetime | None = None
    rebuild_job_status: str | None = None
    counts: StoryMemorySourceCounts = field(default_factory=StoryMemorySourceCounts)

    def to_payload(self) -> dict[str, object]:
        return {
            "project_id": self.project_id,
            "embedding_configured": self.embedding_configured,
            "index_status": self.index_status,
            "last_error": self.last_error,
            "last_ready_at": self.last_ready_at,
            "rebuild_job_status": self.rebuild_job_status,
            "counts": {
                "characters": self.counts.characters,
                "world_entries": self.counts.world_entries,
                "outlines": self.counts.outlines,
                "notes": self.counts.notes,
                "chapters": self.counts.chapters,
            },
        }


async def compute_story_memory_status(
    session: AsyncSession, *, project_id: str
) -> StoryMemoryStatus:
    config = await get_index_settings(session)
    model = await resolve_index_embedding_model(session, config)

    counts = StoryMemorySourceCounts(
        characters=len(await character_repo.list_all_by_project(session, project_id)),
        chapters=await chapter_repo.count_by_project(session, project_id),
        outlines=len(await outline_repo.list_by_project(session, project_id)),
        notes=len(await note_repo.list_by_project(session, project_id)),
    )
    world_info = await world_info_repo.get_by_project_id(session, project_id)
    if world_info is not None:
        counts.world_entries = len(
            await world_info_entry_repo.list_enabled_by_world_info(session, world_info.id)
        )

    index_row = await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    active_jobs = await background_service.list_jobs(
        session,
        subject_type="project",
        subject_id=project_id,
        job_type=JOB_TYPE_STORY_MEMORY_REBUILD,
        statuses={JOB_STATUS_PENDING, JOB_STATUS_RUNNING},
        limit=1,
        offset=0,
    )
    return StoryMemoryStatus(
        project_id=project_id,
        embedding_configured=model is not None,
        index_status=index_row.status if index_row is not None else "not_created",
        last_error=index_row.last_error if index_row is not None else None,
        last_ready_at=index_row.last_ready_at if index_row is not None else None,
        rebuild_job_status=active_jobs[0].status if active_jobs else None,
        counts=counts,
    )


async def enqueue_story_memory_rebuild(
    session: AsyncSession, *, project_id: str
) -> str | None:
    """提交全量重建任务；未配置可用 embedding 模型时返回 None。"""
    config = await get_index_settings(session)
    model = await resolve_index_embedding_model(session, config)
    if model is None:
        return None

    await ensure_story_memory_index(session, project_id, model)
    job = await background_service.submit_job(
        session,
        job_type=JOB_TYPE_STORY_MEMORY_REBUILD,
        payload={"project_id": project_id},
        context={"embedding_model_ref_id": model.id},
        subject_type="project",
        subject_id=project_id,
    )
    return job.id
