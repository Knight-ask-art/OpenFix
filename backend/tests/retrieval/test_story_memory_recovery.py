"""Persisted index lifecycle and read-only restart recovery regressions."""

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest

from app.background.events.publisher import BackgroundEventPublisher
from app.background.jobs.constants import JOB_TYPE_STORY_MEMORY_REBUILD
from app.background.jobs.definitions.story_memory_index import STORY_MEMORY_REBUILD_JOB
from app.background.jobs.models import BackgroundJob
from app.background.jobs import service as job_service
from app.background.runtime.context import JobContext
from app.background.runtime.registry import JobRegistry
from app.retrieval import story_memory
from app.storage.models.retrieval_index import RetrievalIndex


def _index(project_id: str, status: str = "building") -> RetrievalIndex:
    return RetrievalIndex(
        index_key=story_memory.story_memory_index_key(project_id),
        table_name=f"memory_{project_id}",
        status=status,
        embedding_model_ref_id="fake-model",
        embedding_model_id_snapshot="fake-embedding",
        embedding_dimensions_snapshot=3,
        source_fingerprint="old-fingerprint",
    )


def _job(project_id: str, status: str = "running", **kwargs) -> BackgroundJob:
    return BackgroundJob(
        type=JOB_TYPE_STORY_MEMORY_REBUILD,
        subject_type="project",
        subject_id=project_id,
        payload_json=json.dumps({"project_id": project_id}),
        status=status,
        **kwargs,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("hook_name", ["on_failed", "on_timeout", "on_cancelled"])
async def test_terminal_hooks_finalize_committed_building(session, hook_name):
    row = _index("p1")
    other = _index("p2")
    job = _job("p1")
    session.add_all([row, other, job])
    await session.commit()
    hook = getattr(STORY_MEMORY_REBUILD_JOB, hook_name)
    assert hook is not None
    await hook(JobContext(session, job, BackgroundEventPublisher()), "private error")
    await session.flush()
    await session.refresh(row)
    await session.refresh(other)
    assert row.status == "failed"
    assert row.source_fingerprint is None
    assert row.last_error is not None
    assert "private error" not in row.last_error
    assert other.status == "building"
    assert other.source_fingerprint == "old-fingerprint"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["ready", "failed", "registered", "needs_rebuild"])
async def test_late_terminal_hook_preserves_nonbuilding_index(session, status):
    row = _index("p1", status)
    job = _job("p1")
    session.add_all([row, job])
    await session.flush()
    hook = STORY_MEMORY_REBUILD_JOB.on_timeout
    assert hook is not None
    await hook(JobContext(session, job, BackgroundEventPublisher()), "late")
    await session.refresh(row)
    assert row.status == status
    assert row.source_fingerprint == "old-fingerprint"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status", ["pending", "running", "cancel_requested", "succeeded"]
)
async def test_old_hook_does_not_touch_replacement_rebuild(session, status):
    now = datetime.now(UTC)
    row = _index("p1")
    job = _job("p1", created_at=now - timedelta(seconds=10))
    replacement = _job("p1", status, created_at=now)
    session.add_all([row, job, replacement])
    await session.flush()
    hook = STORY_MEMORY_REBUILD_JOB.on_failed
    assert hook is not None
    await hook(JobContext(session, job, BackgroundEventPublisher()), "late")
    await session.refresh(row)
    assert row.status == "building"
    assert row.source_fingerprint == "old-fingerprint"


@pytest.mark.asyncio
async def test_hook_rejects_mismatched_project_subject(session):
    row = _index("p1")
    job = _job("p1")
    job.subject_id = "p2"
    session.add_all([row, job])
    await session.flush()
    hook = STORY_MEMORY_REBUILD_JOB.on_failed
    assert hook is not None
    await hook(JobContext(session, job, BackgroundEventPublisher()), "late")
    await session.refresh(row)
    assert row.status == "building"


@pytest.mark.asyncio
async def test_restart_lease_recovery_calls_terminal_hook(session, monkeypatch):
    registry = JobRegistry()
    registry.register(STORY_MEMORY_REBUILD_JOB)
    monkeypatch.setattr(job_service, "get_job_registry", lambda: registry)
    row = _index("p1")
    job = _job("p1", attempt_count=1, max_attempts=1)
    session.add_all([row, job])
    await session.commit()
    await job_service.recover_stale_job(
        session, BackgroundEventPublisher(), job, reason="worker lease expired"
    )
    await session.flush()
    await session.refresh(row)
    assert job.status == "timeout"
    assert row.status == "failed"


@pytest.mark.asyncio
async def test_restart_retry_keeps_building_until_rescheduled_job_runs(session):
    row = _index("p1")
    job = _job("p1", attempt_count=1, max_attempts=2)
    session.add_all([row, job])
    await session.flush()
    await job_service.recover_stale_job(
        session, BackgroundEventPublisher(), job, reason="worker lease expired"
    )
    await session.refresh(row)
    assert job.status == "pending"
    assert row.status == "building"


def _patch_status_dependencies(monkeypatch):
    monkeypatch.setattr(story_memory, "get_index_settings", AsyncMock(return_value={}))
    monkeypatch.setattr(
        story_memory, "resolve_index_embedding_model", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(
        story_memory.character_repo, "list_all_by_project", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        story_memory.chapter_repo, "count_by_project", AsyncMock(return_value=0)
    )
    monkeypatch.setattr(
        story_memory.outline_repo, "list_by_project", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        story_memory.note_repo, "list_by_project", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        story_memory.world_info_repo, "get_by_project_id", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(
        story_memory, "story_memory_index_is_fresh", AsyncMock(return_value=True)
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "terminal", [None, "failed", "timeout", "cancelled", "succeeded"]
)
async def test_status_reports_restart_orphan_without_writing(
    session, monkeypatch, terminal
):
    _patch_status_dependencies(monkeypatch)
    row = _index("p1")
    # A different project's active job must not conceal this orphan.
    session.add_all([row, _job("p2")])
    if terminal is not None:
        session.add(_job("p1", terminal))
    await session.flush()
    result = await story_memory.compute_story_memory_status(session, project_id="p1")
    assert result.index_status == "failed"
    assert result.rebuild_job_status is None
    assert result.last_error is not None
    assert "重新重建" in result.last_error
    await session.refresh(row)
    assert row.status == "building"
    assert row.last_error is None


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["pending", "running", "cancel_requested"])
async def test_status_preserves_active_building(session, monkeypatch, status):
    _patch_status_dependencies(monkeypatch)
    row = _index("p1")
    session.add_all([row, _job("p1", status)])
    await session.flush()
    result = await story_memory.compute_story_memory_status(session, project_id="p1")
    assert result.index_status == "building"
    assert result.rebuild_job_status == status


@pytest.mark.asyncio
async def test_status_preserves_ready_without_active_job(session, monkeypatch):
    _patch_status_dependencies(monkeypatch)
    row = _index("p1", "ready")
    session.add(row)
    await session.flush()
    result = await story_memory.compute_story_memory_status(session, project_id="p1")
    assert result.index_status == "ready"


@pytest.mark.asyncio
async def test_status_rechecks_job_started_during_initial_reads(session, monkeypatch):
    _patch_status_dependencies(monkeypatch)
    session.add(_index("p1"))
    await session.flush()

    async def newly_started_job(*args, **kwargs):
        session.add(_job("p1"))
        await session.flush()
        return []

    monkeypatch.setattr(story_memory.background_service, "list_jobs", newly_started_job)
    result = await story_memory.compute_story_memory_status(session, project_id="p1")
    assert result.index_status == "building"
