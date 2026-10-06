"""已保存章节写入状态的取数与重复判定规则。"""

import json
from types import SimpleNamespace

import pytest

from app.agent_runtime.tools.impls.orchestration import saved_writes


def _child_run(
    *,
    run_id: str = "child-1",
    thread_id: str = "sess-1:child:dispatch-1",
    parent_session_id: str = "sess-1",
    parent_task_id: str = "task-1",
    agent_key: str = "writer",
    agent_number: str | None = "#1001",
):
    return SimpleNamespace(
        id=run_id,
        child_thread_id=thread_id,
        parent_session_id=parent_session_id,
        parent_task_id=parent_task_id,
        agent_key=agent_key,
        metadata_json={"agent_number": agent_number} if agent_number else {},
    )


def _tool_row(content, *, tool_name: str = "write_chapter", seq: int = 1):
    return SimpleNamespace(
        id=f"msg-{seq}",
        role="tool",
        tool_name=tool_name,
        content=json.dumps(content, ensure_ascii=False),
        seq=seq,
    )


def _create_result(
    *,
    chapter_id: str = "chap-7",
    title: str = "第七章",
    order: int = 7,
    volume: str | None = "第一卷",
):
    diff = {
        "operation": "create",
        "chapter_id": chapter_id,
        "chapter_title": title,
        "order": order,
        "sections": [],
    }
    if volume is not None:
        diff["path"] = [volume]
    return {"success": True, "word_count": 2956, "metadata": {"chapter_diff": diff}}


def _install_persistence(monkeypatch, *, runs, rows_by_thread):
    async def list_child_runs_for_parent(_session, _parent_session_id):
        return list(runs)

    async def list_by_sessions(_session, _session_ids, **_kwargs):
        return dict(rows_by_thread)

    monkeypatch.setattr(
        saved_writes, "list_child_runs_for_parent", list_child_runs_for_parent
    )
    monkeypatch.setattr(
        saved_writes.message_repo, "list_by_sessions", list_by_sessions
    )


@pytest.mark.asyncio
async def test_collect_saved_chapter_writes_reads_persisted_create_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _child_run()
    _install_persistence(
        monkeypatch,
        runs=[run],
        rows_by_thread={run.child_thread_id: [_tool_row(_create_result())]},
    )

    writes = await saved_writes.collect_saved_chapter_writes(object(), [run])

    assert [write.chapter_id for write in writes] == ["chap-7"]
    write = writes[0]
    assert write.title == "第七章"
    assert write.order == 7
    assert write.volume_title == "第一卷"
    assert write.agent_key == "writer"
    assert write.agent_number == "#1001"
    assert write.to_payload() == {
        "chapter_id": "chap-7",
        "title": "第七章",
        "order": 7,
        "status": "saved",
        "volume": "第一卷",
        "agent": "writer",
        "agent_number": "#1001",
    }


@pytest.mark.asyncio
async def test_unpersisted_writes_are_not_reported_as_saved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _child_run()
    rows = [
        _tool_row(
            {
                "type": "ok",
                "success": True,
                "reason": "approval_preview",
                "message": "需要审批",
            },
            seq=1,
        ),
        _tool_row(
            {
                "type": "control",
                "success": False,
                "status": "approval_denied",
                "message": "工具调用已被用户拒绝",
            },
            seq=2,
        ),
        _tool_row(
            {"type": "fail", "success": False, "code": "conflict", "message": "已存在"},
            seq=3,
        ),
        _tool_row(_create_result(), tool_name="list_chapters", seq=4),
    ]
    _install_persistence(
        monkeypatch, runs=[run], rows_by_thread={run.child_thread_id: rows}
    )

    assert await saved_writes.collect_saved_chapter_writes(object(), [run]) == []


@pytest.mark.asyncio
async def test_collect_saved_chapter_writes_dedupes_repeated_chapter_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _child_run()
    _install_persistence(
        monkeypatch,
        runs=[run],
        rows_by_thread={
            run.child_thread_id: [
                _tool_row(_create_result(), seq=1),
                _tool_row(_create_result(), seq=2),
            ]
        },
    )

    writes = await saved_writes.collect_saved_chapter_writes(object(), [run])

    assert [write.chapter_id for write in writes] == ["chap-7"]


@pytest.mark.asyncio
async def test_task_child_runs_ignore_other_tasks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = _child_run()
    other = _child_run(run_id="child-2", thread_id="sess-1:child:2", parent_task_id="task-2")
    _install_persistence(monkeypatch, runs=[current, other], rows_by_thread={})

    runs = await saved_writes.list_task_child_runs(
        object(), parent_session_id="sess-1", parent_task_id="task-1"
    )

    assert [run.id for run in runs] == ["child-1"]


def _install_duplicate_lookup(
    monkeypatch: pytest.MonkeyPatch, *, saved_chapter, run
):
    _install_persistence(
        monkeypatch,
        runs=[run],
        rows_by_thread={run.child_thread_id: [_tool_row(_create_result())]},
    )

    async def get_by_id(_session, chapter_id):
        return saved_chapter if chapter_id == saved_chapter.id else None

    monkeypatch.setattr(saved_writes.chapter_repo, "get_by_id", get_by_id)


def _chapter(*, chapter_id="chap-7", title="第七章", content="已保存正文", volume_id="vol-1"):
    return SimpleNamespace(
        id=chapter_id,
        project_id="proj-1",
        volume_id=volume_id,
        title=title,
        content=content,
        order=7,
    )


@pytest.mark.asyncio
async def test_duplicate_requires_same_volume_title_and_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _child_run()
    _install_duplicate_lookup(
        monkeypatch, saved_chapter=_chapter(), run=run
    )

    duplicate = await saved_writes.find_duplicate_saved_chapter(
        object(),
        parent_session_id="sess-1",
        parent_task_id="task-1",
        project_id="proj-1",
        volume_id="vol-1",
        title="第七章",
        content="已保存正文",
    )

    assert duplicate is not None
    assert duplicate.chapter_id == "chap-7"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        {"title": "第七章", "content": "改过的正文", "volume_id": "vol-1"},
        {"title": "第八章", "content": "已保存正文", "volume_id": "vol-1"},
        {"title": "第七章", "content": "已保存正文", "volume_id": "vol-2"},
    ],
)
async def test_duplicate_ignores_title_only_content_only_or_other_volume(
    monkeypatch: pytest.MonkeyPatch, case: dict
) -> None:
    run = _child_run()
    _install_duplicate_lookup(monkeypatch, saved_chapter=_chapter(), run=run)

    duplicate = await saved_writes.find_duplicate_saved_chapter(
        object(),
        parent_session_id="sess-1",
        parent_task_id="task-1",
        project_id="proj-1",
        volume_id=case["volume_id"],
        title=case["title"],
        content=case["content"],
    )

    assert duplicate is None


@pytest.mark.asyncio
async def test_duplicate_lookup_is_empty_without_child_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_persistence(monkeypatch, runs=[], rows_by_thread={})

    duplicate = await saved_writes.find_duplicate_saved_chapter(
        object(),
        parent_session_id="sess-1",
        parent_task_id="task-1",
        project_id="proj-1",
        volume_id="vol-1",
        title="第七章",
        content="已保存正文",
    )

    assert duplicate is None


@pytest.mark.asyncio
async def test_collect_saved_chapter_writes_reads_real_child_tool_messages() -> None:
    """真实 SQLite 落库路径：子Agent的 write_chapter 工具消息会被读回。"""
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
    from sqlalchemy.orm import sessionmaker
    from sqlmodel import SQLModel

    from app.agent_runtime.persistence.model import AgentChildRun, AgentRunMessage
    from tests.model_registry import register_sqlmodel_models

    register_sqlmodel_models()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    run = AgentChildRun(
        id="child-1",
        parent_session_id="sess-1",
        parent_task_id="task-1",
        parent_thread_id="sess-1",
        child_thread_id="sess-1:child:dispatch-1",
        agent_key="writer",
        dispatch_id="dispatch-1",
        tool_call_id="call-1",
        status="completed",
        metadata_json={"agent_number": "#1001"},
    )
    persisted = AgentRunMessage(
        id="msg-1",
        session_id=run.child_thread_id,
        task_id="task-1",
        project_id="proj-1",
        role="tool",
        status="complete",
        content=json.dumps(_create_result(), ensure_ascii=False),
        tool_name="write_chapter",
        tool_call_id="call-1",
        seq=1,
    )
    preview = AgentRunMessage(
        id="msg-2",
        session_id=run.child_thread_id,
        task_id="task-1",
        project_id="proj-1",
        role="tool",
        status="complete",
        content=json.dumps(
            {
                "type": "ok",
                "success": True,
                "reason": "approval_preview",
                "message": "需要审批",
            },
            ensure_ascii=False,
        ),
        tool_name="write_chapter",
        tool_call_id="call-2",
        seq=2,
    )

    async with factory() as session:
        session.add(run)
        session.add(persisted)
        session.add(preview)
        await session.commit()

    async with factory() as session:
        writes = await saved_writes.collect_task_saved_chapter_writes(
            session, parent_session_id="sess-1", parent_task_id="task-1"
        )

    await engine.dispose()

    assert [write.chapter_id for write in writes] == ["chap-7"]
    assert writes[0].title == "第七章"
    assert writes[0].order == 7
    assert writes[0].volume_title == "第一卷"
    assert writes[0].agent_key == "writer"
    assert writes[0].agent_number == "#1001"
