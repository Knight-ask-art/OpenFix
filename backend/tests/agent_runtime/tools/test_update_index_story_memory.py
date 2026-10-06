"""Focused tests for the update_index tool covering chapter and Story Memory."""

import importlib
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.retrieval.chapter_index import IndexEnqueueResult, IndexSettingsConfig

MODULE_PATH = "app.agent_runtime.tools.impls.chapter.update_index"


def _make_state() -> dict[str, Any]:
    return {
        "session_id": "sess-1",
        "task_id": "task-1",
        "project_id": "proj-1",
        "model_config": {},
    }


def _settings_config(
    *, mode: str = "all", enabled_projects: set[str] | None = None
) -> IndexSettingsConfig:
    return IndexSettingsConfig(
        mode=mode,
        enabled_projects=enabled_projects or set(),
        chunk_size=800,
        chunk_overlap=100,
        auto_strategy="off",
        embedding_model_ref_id="model-1",
        rerank_enabled=False,
        rerank_model_ref_id="",
    )


@pytest.fixture
def tool_env(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Patch every collaborator so the tool runs without a database."""
    module = importlib.import_module(MODULE_PATH)
    session = AsyncMock()
    service = SimpleNamespace(
        commit_and_notify=AsyncMock(),
        rollback_and_discard=AsyncMock(),
        list_jobs=AsyncMock(return_value=[]),
    )
    env = SimpleNamespace(
        module=module,
        session=session,
        service=service,
        get_index_settings=AsyncMock(return_value=_settings_config()),
        resolve_index_embedding_model=AsyncMock(
            return_value=SimpleNamespace(id="model-1")
        ),
        is_project_index_enabled=MagicMock(return_value=True),
        enqueue_project_index_update=AsyncMock(
            return_value=IndexEnqueueResult(enqueued_count=0, skipped_count=0)
        ),
        story_memory_index_is_fresh=AsyncMock(return_value=True),
        enqueue_story_memory_rebuild=AsyncMock(return_value="job-memory"),
        schedule_emit_index_status=MagicMock(),
    )
    monkeypatch.setattr(module, "create_session", AsyncMock(return_value=session))
    monkeypatch.setattr(module, "background_service", service)
    monkeypatch.setattr(module, "get_index_settings", env.get_index_settings)
    monkeypatch.setattr(
        module, "resolve_index_embedding_model", env.resolve_index_embedding_model
    )
    monkeypatch.setattr(module, "is_project_index_enabled", env.is_project_index_enabled)
    monkeypatch.setattr(
        module, "enqueue_project_index_update", env.enqueue_project_index_update
    )
    monkeypatch.setattr(
        module, "story_memory_index_is_fresh", env.story_memory_index_is_fresh
    )
    monkeypatch.setattr(
        module, "enqueue_story_memory_rebuild", env.enqueue_story_memory_rebuild
    )
    monkeypatch.setattr(
        module, "schedule_emit_index_status", env.schedule_emit_index_status
    )
    return env


async def test_update_index_enqueues_stale_story_memory_with_fresh_chapters(
    tool_env: SimpleNamespace,
) -> None:
    tool_env.enqueue_project_index_update.return_value = IndexEnqueueResult(
        enqueued_count=0, skipped_count=114
    )
    tool_env.story_memory_index_is_fresh.return_value = False
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload["success"] is True
    assert payload["chapter_index"]["status"] == "fresh"
    assert payload["chapter_index"]["enqueued_count"] == 0
    assert payload["story_memory_index"]["status"] == "queued"
    assert payload["story_memory_index"]["job_id"] == "job-memory"
    assert "已加入重建队列" in payload["story_memory_index"]["message"]
    assert "尚未完成" in payload["note"]
    tool_env.enqueue_story_memory_rebuild.assert_awaited_once_with(
        tool_env.session, project_id="proj-1"
    )
    tool_env.schedule_emit_index_status.assert_called_once_with(
        tool_env.session, "proj-1"
    )
    tool_env.service.commit_and_notify.assert_awaited_once_with(tool_env.session)
    tool_env.session.close.assert_awaited_once()


async def test_update_index_reports_fresh_when_both_indexes_are_current(
    tool_env: SimpleNamespace,
) -> None:
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload["chapter_index"]["status"] == "fresh"
    assert payload["story_memory_index"] == {
        "status": "fresh",
        "job_id": None,
        "message": "故事记忆索引已是最新，无需重建。",
    }
    assert "note" not in payload
    tool_env.enqueue_story_memory_rebuild.assert_not_awaited()
    tool_env.schedule_emit_index_status.assert_called_once_with(
        tool_env.session, "proj-1"
    )
    tool_env.service.commit_and_notify.assert_awaited_once_with(tool_env.session)


async def test_update_index_queues_both_indexes_and_marks_them_not_ready(
    tool_env: SimpleNamespace,
) -> None:
    tool_env.enqueue_project_index_update.return_value = IndexEnqueueResult(
        enqueued_count=3, skipped_count=1, job_id="job-chapters"
    )
    tool_env.story_memory_index_is_fresh.return_value = False
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload["chapter_index"]["status"] == "queued"
    assert payload["chapter_index"]["enqueued_count"] == 3
    assert "3 个章节" in payload["chapter_index"]["message"]
    assert payload["story_memory_index"]["status"] == "queued"
    assert "尚未完成" in payload["note"]
    tool_env.service.commit_and_notify.assert_awaited_once_with(tool_env.session)


async def test_update_index_skips_disabled_chapter_index_but_updates_memory(
    tool_env: SimpleNamespace,
) -> None:
    tool_env.is_project_index_enabled.return_value = False
    tool_env.get_index_settings.return_value = _settings_config(mode="off")
    tool_env.story_memory_index_is_fresh.return_value = False
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload["chapter_index"]["status"] == "disabled"
    assert payload["chapter_index"]["enqueued_count"] == 0
    assert payload["story_memory_index"]["status"] == "queued"
    tool_env.enqueue_project_index_update.assert_not_awaited()
    tool_env.enqueue_story_memory_rebuild.assert_awaited_once_with(
        tool_env.session, project_id="proj-1"
    )


async def test_update_index_does_not_duplicate_queued_story_memory_rebuild(
    tool_env: SimpleNamespace,
) -> None:
    tool_env.service.list_jobs.return_value = [
        SimpleNamespace(id="job-existing", status="running")
    ]
    tool_env.story_memory_index_is_fresh.return_value = False
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload["story_memory_index"]["status"] == "already_queued"
    assert payload["story_memory_index"]["job_id"] == "job-existing"
    tool_env.enqueue_story_memory_rebuild.assert_not_awaited()
    tool_env.story_memory_index_is_fresh.assert_not_awaited()
    tool_env.service.list_jobs.assert_awaited_once_with(
        tool_env.session,
        subject_type="project",
        subject_id="proj-1",
        statuses={"pending", "running"},
        job_type="story_memory_rebuild",
        limit=1,
        offset=0,
    )


async def test_update_index_reports_unavailable_without_embedding_model(
    tool_env: SimpleNamespace,
) -> None:
    tool_env.resolve_index_embedding_model.return_value = None
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload == {
        "type": "fail",
        "success": False,
        "code": "dependency_unavailable",
        "message": "当前项目未配置可用的嵌入模型，无法更新检索索引。",
    }
    tool_env.enqueue_project_index_update.assert_not_awaited()
    tool_env.enqueue_story_memory_rebuild.assert_not_awaited()
    tool_env.service.commit_and_notify.assert_not_awaited()
    tool_env.session.close.assert_awaited_once()


async def test_update_index_reports_unavailable_when_memory_enqueue_is_blocked(
    tool_env: SimpleNamespace,
) -> None:
    tool_env.story_memory_index_is_fresh.return_value = False
    tool_env.enqueue_story_memory_rebuild.return_value = None
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload["story_memory_index"]["status"] == "unavailable"
    assert payload["story_memory_index"]["job_id"] is None
    assert payload["chapter_index"]["status"] == "fresh"


async def test_update_index_rolls_back_when_chapter_enqueue_fails(
    tool_env: SimpleNamespace,
) -> None:
    tool_env.enqueue_project_index_update.side_effect = RuntimeError("boom")
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload["type"] == "fail"
    assert payload["success"] is False
    assert payload["code"] == "execution_failed"
    assert "boom" in payload["message"]
    tool_env.service.rollback_and_discard.assert_awaited_once_with(tool_env.session)
    tool_env.service.commit_and_notify.assert_not_awaited()
    tool_env.enqueue_story_memory_rebuild.assert_not_awaited()
    tool_env.session.close.assert_awaited_once()


async def test_update_index_rolls_back_when_memory_enqueue_fails(
    tool_env: SimpleNamespace,
) -> None:
    tool_env.enqueue_project_index_update.return_value = IndexEnqueueResult(
        enqueued_count=2, skipped_count=0, job_id="job-chapters"
    )
    tool_env.story_memory_index_is_fresh.return_value = False
    tool_env.enqueue_story_memory_rebuild.side_effect = RuntimeError("memory down")
    tool = tool_env.module.UpdateIndexTool(_state=_make_state())

    payload = json.loads(await tool.ainvoke({}))

    assert payload["code"] == "execution_failed"
    tool_env.service.rollback_and_discard.assert_awaited_once_with(tool_env.session)
    tool_env.service.commit_and_notify.assert_not_awaited()
