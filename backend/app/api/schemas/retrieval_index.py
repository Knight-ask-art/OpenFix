# -*- coding: utf-8 -*-
"""Schemas for project retrieval index APIs."""

from pydantic import BaseModel, Field

IndexStatus = str
IndexMode = str


class IndexProjectStatusResponse(BaseModel):
    """单个项目的索引状态汇总（不含内部 ID）。"""

    project_id: str
    enabled: bool
    status: IndexStatus
    title: str = ""
    total_chapters: int = 0
    indexed_count: int = 0
    pending_count: int = 0
    in_progress_count: int = 0
    failed_count: int = 0
    empty_content_count: int = 0
    last_error: str | None = None
    progress: float = 0.0


class IndexOverallStatusResponse(BaseModel):
    """索引总体状态（跨启用项目聚合）。"""

    mode: IndexMode
    embedding_model_configured: bool
    total_projects: int = 0
    total_chapters: int = 0
    indexed_count: int = 0
    pending_count: int = 0
    in_progress_count: int = 0
    failed_count: int = 0
    projects: list[IndexProjectStatusResponse] = Field(default_factory=list)


class IndexStartResponse(BaseModel):
    """手动开始索引的响应。"""

    project_id: str
    enqueued_count: int
    skipped_count: int = 0


class IndexStopResponse(BaseModel):
    """手动停止索引的响应。"""

    project_id: str
    stopped_count: int


class StoryMemoryCounts(BaseModel):
    characters: int = 0
    world_entries: int = 0
    outlines: int = 0
    notes: int = 0
    chapters: int = 0


class StoryMemoryStatusResponse(BaseModel):
    """故事记忆索引状态。"""

    project_id: str
    embedding_configured: bool
    index_status: str
    last_error: str | None = None
    last_ready_at: str | None = None
    rebuild_job_status: str | None = None
    counts: StoryMemoryCounts = Field(default_factory=StoryMemoryCounts)


class StoryMemoryRebuildResponse(BaseModel):
    """提交故事记忆重建的响应。"""

    project_id: str
    job_id: str | None = None
    enqueued: bool
