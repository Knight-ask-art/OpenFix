import hashlib
import json
from types import SimpleNamespace

import pytest

import app.agent_runtime.tools.impls.orchestration.dispatch_subagent as dispatch_module
from app.agent_runtime.persistence.model import AgentRunMessage
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.orchestration import author_request
from app.agent_runtime.tools.impls.orchestration import handoff as handoff_module
from app.agent_runtime.tools.impls.orchestration import notify_subagent as notify_module
from app.agent_runtime.tools.impls.orchestration.dispatch_subagent import (
    DispatchSubagentTool,
)
from app.agent_runtime.tools.impls.orchestration.notify_subagent import (
    NotifySubagentTool,
)

PROJECT_ID = "project-1"
TASK_ID = "task-1"
SESSION_ID = "parent"
REVISION_ID = "revision-1"
MESSAGE_ID = "message-1"

AUTHOR_TEXT = (
    "第一章改写：主角已经用劳动换过一顿饭；只拿到七天的借住许可；"
    "关键物件的用途仍然未知，不要写成已安葬。"
)
SECRET_MARKERS = ("劳动换过一顿饭", "借住许可", "已安葬")


def _revision(**overrides):
    values = {
        "id": REVISION_ID,
        "project_id": PROJECT_ID,
        "task_id": TASK_ID,
        "agent_session_id": SESSION_ID,
        "user_message_id": MESSAGE_ID,
        "user_message_seq": 3,
        "status": "active",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _message(**overrides):
    values = {
        "id": MESSAGE_ID,
        "session_id": SESSION_ID,
        "task_id": TASK_ID,
        "project_id": PROJECT_ID,
        "role": "user",
        "status": "sent",
        "seq": 3,
        "content": AUTHOR_TEXT,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class _FakeSession:
    def __init__(self, revision, message):
        self.revision = revision
        self.message = message
        self.get_calls: list[tuple[type, str]] = []

    async def get(self, model, key):
        self.get_calls.append((model, key))
        if model is AgentRunMessage and self.message is not None:
            return self.message
        return None


def _install(
    monkeypatch: pytest.MonkeyPatch,
    *,
    revision=None,
    message=None,
) -> _FakeSession:
    session = _FakeSession(revision, message)

    async def get_by_id(_session, revision_id):
        return revision if revision is not None and revision.id == revision_id else None

    monkeypatch.setattr(author_request.revision_repo_module, "get_by_id", get_by_id)
    return session


async def _resolve(session, **overrides):
    kwargs = {
        "revision_id": REVISION_ID,
        "project_id": PROJECT_ID,
        "task_id": TASK_ID,
        "session_id": SESSION_ID,
    }
    kwargs.update(overrides)
    return await author_request.resolve_author_request(session, **kwargs)


def _state(**overrides):
    values = {
        "session_id": SESSION_ID,
        "task_id": TASK_ID,
        "project_id": PROJECT_ID,
        "current_revision_id": REVISION_ID,
        "active_agent": "novelist",
    }
    values.update(overrides)
    return values


class _Runner:
    async def publish_parent_subagent_status(self, _child_run_id: str) -> None:
        return None


def _patch_dispatch(monkeypatch, *, created, persisted, session, emitted=None):
    async def noop(*_args, **_kwargs) -> None:
        return None

    async def open_session(*_args, **_kwargs):
        return session

    async def load_waiting_child_run(*_args, **_kwargs):
        return None

    async def load_saved_chapter_writes(*_args, **_kwargs):
        return []

    async def create_child_run(*_args, **kwargs):
        created.append(kwargs)
        return SimpleNamespace(
            id="child-run-writer",
            child_thread_id="parent:child:dispatch-writer",
            dispatch_id="dispatch-writer",
            agent_key="writer",
            metadata_json={"agent_number": "#1001"},
            pending_approval_json=None,
        )

    async def load_initial_request_id(*_args, **_kwargs) -> str:
        return "request-1"

    async def persist_child_user_message(*_args, **kwargs):
        persisted.append(kwargs["content"])
        return SimpleNamespace(id="child-message-1", seq=0)

    async def wait_for_assistant_content(*_args, **_kwargs) -> str:
        return "writer completed"

    async def event_sink(name: str, payload: dict) -> None:
        if emitted is not None:
            emitted.append((name, payload))

    monkeypatch.setattr(DispatchSubagentTool, "_validate_dispatch", noop)
    monkeypatch.setattr(
        DispatchSubagentTool, "_load_waiting_child_run", load_waiting_child_run
    )
    monkeypatch.setattr(
        DispatchSubagentTool, "_load_saved_chapter_writes", load_saved_chapter_writes
    )
    monkeypatch.setattr(DispatchSubagentTool, "_create_child_run", create_child_run)
    monkeypatch.setattr(
        DispatchSubagentTool, "_load_initial_request_id", load_initial_request_id
    )
    monkeypatch.setattr(
        DispatchSubagentTool, "_wait_for_assistant_content", wait_for_assistant_content
    )
    monkeypatch.setattr(dispatch_module, "latest_checkpoint_id_for_thread", noop)
    monkeypatch.setattr(
        dispatch_module, "persist_child_user_message", persist_child_user_message
    )
    monkeypatch.setattr(dispatch_module, "open_session", open_session)
    monkeypatch.setattr(dispatch_module, "close_session", noop)
    monkeypatch.setattr(
        dispatch_module, "update_child_run_request_boundaries", noop
    )
    monkeypatch.setattr(
        dispatch_module, "make_subagent_runner", lambda **_kwargs: _Runner()
    )
    return event_sink


@pytest.mark.asyncio
@pytest.mark.parametrize("message_status", ["sent", "pending"])
async def test_dispatch_injects_author_request_before_plan_prompt(
    monkeypatch: pytest.MonkeyPatch,
    message_status: str,
) -> None:
    session = _install(
        monkeypatch, revision=_revision(), message=_message(status=message_status)
    )
    created: list[dict] = []
    persisted: list[str] = []
    emitted: list[tuple[str, dict]] = []
    _patch_dispatch(
        monkeypatch,
        created=created,
        persisted=persisted,
        session=session,
        emitted=emitted,
    )

    tool = DispatchSubagentTool(_state=_state())

    await tool._arun(
        agent_type="writer",
        description="改写第一章",
        prompt="Plan：把旧物写成从废件堆捡来的。",
        config={"metadata": {"tool_call_id": "call-dispatch"}},
    )

    assert len(created) == 1
    request = created[0]["request"]
    task = request["task"]
    assert AUTHOR_TEXT in task
    assert task.index(AUTHOR_TEXT) < task.index("Plan：把旧物写成从废件堆捡来的。")
    assert request["author_request"] == {
        "status": "present",
        "revision_id": REVISION_ID,
        "message_id": MESSAGE_ID,
        "message_seq": 3,
        "content_sha256": hashlib.sha256(AUTHOR_TEXT.encode("utf-8")).hexdigest(),
        "chars": len(AUTHOR_TEXT),
        "tokens": request["author_request"]["tokens"],
        "source_consumption": "unverified",
    }
    assert request["author_request"]["tokens"] > 0
    serialized_metadata = json.dumps(request["author_request"], ensure_ascii=False)
    for marker in SECRET_MARKERS:
        assert marker not in serialized_metadata
    assert "content" not in request["author_request"]
    assert persisted == [task]
    # 预览只展示调用参数，不含作者原文。
    assert AUTHOR_TEXT not in json.dumps(emitted, ensure_ascii=False)
    assert created[0]["parent_revision_id"] == REVISION_ID


@pytest.mark.asyncio
async def test_dispatch_author_request_precedes_reference_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _install(monkeypatch, revision=_revision(), message=_message())
    created: list[dict] = []
    persisted: list[str] = []
    _patch_dispatch(monkeypatch, created=created, persisted=persisted, session=session)

    source_row = SimpleNamespace(
        id="child-run-writer-0",
        dispatch_id="dispatch-writer-0",
        parent_session_id=SESSION_ID,
        parent_task_id=TASK_ID,
        agent_key="writer",
        is_active=True,
        metadata_json={"agent_number": "#1000"},
    )
    source_request = SimpleNamespace(
        id="request-writer-0",
        child_run_id="child-run-writer-0",
        parent_session_id=SESSION_ID,
        parent_task_id=TASK_ID,
        status="completed",
        assistant_content="候选正文：天色渐暗。",
        content="给Writer的原始任务文本",
        seq=1,
    )

    async def get_child_run_for_parent_dispatch_id(_session, **_kwargs):
        return source_row

    async def get_latest_child_run_requests(_session, _ids):
        return {"child-run-writer-0": source_request}

    monkeypatch.setattr(
        handoff_module,
        "get_child_run_for_parent_dispatch_id",
        get_child_run_for_parent_dispatch_id,
    )
    monkeypatch.setattr(
        handoff_module, "get_latest_child_run_requests", get_latest_child_run_requests
    )

    tool = DispatchSubagentTool(_state=_state())

    await tool._arun(
        agent_type="writer",
        description="依据候选稿改写",
        prompt="请把候选稿改成第一人称。",
        source_dispatch_ids=["dispatch-writer-0"],
        config={"metadata": {"tool_call_id": "call-dispatch"}},
    )

    task = created[0]["request"]["task"]
    assert task.index(AUTHOR_TEXT) < task.index("请把候选稿改成第一人称。")
    assert task.index("请把候选稿改成第一人称。") < task.index("候选正文：天色渐暗。")
    assert task.endswith(handoff_module.REFERENCE_BLOCK_END)
    assert created[0]["request"]["handoff"]["source_dispatch_ids"] == [
        "dispatch-writer-0"
    ]
    assert created[0]["request"]["original_task"] == "请把候选稿改成第一人称。"
    assert persisted == [task]


@pytest.mark.asyncio
async def test_dispatch_without_revision_keeps_legacy_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _install(monkeypatch, revision=_revision(), message=_message())

    async def fail_if_resolved(*_args, **_kwargs):
        raise AssertionError("no revision must not query author request")

    monkeypatch.setattr(
        dispatch_module, "resolve_author_request", fail_if_resolved
    )
    created: list[dict] = []
    persisted: list[str] = []
    _patch_dispatch(monkeypatch, created=created, persisted=persisted, session=session)

    tool = DispatchSubagentTool(_state=_state(current_revision_id=None))

    await tool._arun(
        agent_type="writer",
        description="写场景",
        prompt="写一个雨夜场景。",
        config={"metadata": {"tool_call_id": "call-dispatch"}},
    )

    request = created[0]["request"]
    assert request["task"] == "写一个雨夜场景。"
    assert request["author_request"]["status"] == "unavailable"
    assert request["author_request"]["reason"] == "no_revision"
    assert persisted == ["写一个雨夜场景。"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("revision_kwargs", "message_kwargs"),
    [
        ({"project_id": "other-project"}, {}),
        ({"task_id": "other-task"}, {}),
        ({"agent_session_id": "other-session"}, {}),
        ({}, {"role": "assistant"}),
        ({}, {"status": "aborted"}),
        ({}, {"status": "partial"}),
        ({}, {"session_id": "other-session"}),
        ({}, {"task_id": "other-task"}),
        ({}, {"project_id": "other-project"}),
        ({}, {"seq": 9}),
        ({}, {"content": ""}),
    ],
)
async def test_dispatch_fails_closed_on_mismatch_without_child(
    monkeypatch: pytest.MonkeyPatch,
    revision_kwargs: dict,
    message_kwargs: dict,
) -> None:
    session = _install(
        monkeypatch,
        revision=_revision(**revision_kwargs),
        message=_message(**message_kwargs),
    )
    created: list[dict] = []
    persisted: list[str] = []
    _patch_dispatch(monkeypatch, created=created, persisted=persisted, session=session)

    tool = DispatchSubagentTool(_state=_state())

    result = json.loads(
        await tool._arun(
            agent_type="writer",
            description="改写第一章",
            prompt="Plan 摘要。",
            config={"metadata": {"tool_call_id": "call-dispatch"}},
        )
    )

    assert result["success"] is False
    assert result["code"] == "conflict"
    for marker in SECRET_MARKERS:
        assert marker not in json.dumps(result, ensure_ascii=False)
    assert created == []
    assert persisted == []


@pytest.mark.asyncio
@pytest.mark.parametrize("message", [None, _message(session_id="other-session")])
async def test_dispatch_missing_or_mismatched_message_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    message,
) -> None:
    session = _install(monkeypatch, revision=_revision(), message=message)
    created: list[dict] = []
    persisted: list[str] = []
    _patch_dispatch(monkeypatch, created=created, persisted=persisted, session=session)

    tool = DispatchSubagentTool(_state=_state())

    result = json.loads(
        await tool._arun(
            agent_type="writer",
            description="改写第一章",
            prompt="Plan 摘要。",
            config={"metadata": {"tool_call_id": "call-dispatch"}},
        )
    )

    assert result["success"] is False
    assert created == []
    assert persisted == []


@pytest.mark.asyncio
async def test_dispatch_missing_revision_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _install(monkeypatch, revision=None, message=_message())
    created: list[dict] = []
    persisted: list[str] = []
    _patch_dispatch(monkeypatch, created=created, persisted=persisted, session=session)

    tool = DispatchSubagentTool(_state=_state())

    result = json.loads(
        await tool._arun(
            agent_type="writer",
            description="改写第一章",
            prompt="Plan 摘要。",
            config={"metadata": {"tool_call_id": "call-dispatch"}},
        )
    )

    assert result["code"] == "not_found"
    assert created == []
    assert persisted == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "revision_state",
    ["", "  ", False, 0, 123, [], ["revision-1"], {"id": REVISION_ID}],
)
async def test_dispatch_rejects_invalid_revision_state_without_child(
    monkeypatch: pytest.MonkeyPatch,
    revision_state,
) -> None:
    session = _install(monkeypatch, revision=_revision(), message=_message())
    created: list[dict] = []
    persisted: list[str] = []
    _patch_dispatch(monkeypatch, created=created, persisted=persisted, session=session)

    tool = DispatchSubagentTool(_state=_state(current_revision_id=revision_state))

    result = json.loads(
        await tool._arun(
            agent_type="writer",
            description="改写第一章",
            prompt="Plan 摘要。",
            config={"metadata": {"tool_call_id": "call-dispatch"}},
        )
    )

    assert result["success"] is False
    assert result["code"] == "validation_error"
    assert created == []
    assert persisted == []


@pytest.mark.asyncio
@pytest.mark.parametrize("revision_state", ["", "  ", False, 0, 123, [], {"id": REVISION_ID}])
async def test_notify_rejects_invalid_revision_state_without_enqueue(
    monkeypatch: pytest.MonkeyPatch,
    revision_state,
) -> None:
    enqueued: list[dict] = []
    persisted: list[str] = []

    async def noop(*_args, **_kwargs) -> None:
        return None

    async def resolve_child_run(**_kwargs):
        return SimpleNamespace(id="child-run-writer", is_active=True)

    async def enqueue_child_run_request(*_args, **kwargs):
        enqueued.append(kwargs)
        return SimpleNamespace(id="request-2")

    async def persist_child_user_message(*_args, **kwargs):
        persisted.append(kwargs["content"])
        return SimpleNamespace(id="child-message-2", seq=1)

    monkeypatch.setattr(notify_module, "ensure_primary", noop)
    monkeypatch.setattr(notify_module, "resolve_child_run", resolve_child_run)
    monkeypatch.setattr(
        notify_module, "enqueue_child_run_request", enqueue_child_run_request
    )
    monkeypatch.setattr(
        notify_module, "persist_child_user_message", persist_child_user_message
    )

    tool = NotifySubagentTool(_state=_state(current_revision_id=revision_state))

    result = json.loads(
        await tool._arun(
            dispatch_id="dispatch-writer",
            prompt="补充。",
            config={"metadata": {"tool_call_id": "call-notify"}},
        )
    )

    assert result["success"] is False
    assert result["code"] == "validation_error"
    assert enqueued == []
    assert persisted == []


async def test_notify_injects_current_author_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _install(monkeypatch, revision=_revision(), message=_message())
    enqueued: list[dict] = []
    persisted: list[str] = []

    async def noop(*_args, **_kwargs) -> None:
        return None

    async def open_session(*_args, **_kwargs):
        return session

    async def resolve_child_run(**_kwargs):
        return SimpleNamespace(
            id="child-run-writer",
            child_thread_id="parent:child:dispatch-writer",
            dispatch_id="dispatch-writer",
            is_active=True,
            metadata_json={"agent_number": "#1001"},
            pending_approval_json=None,
        )

    async def enqueue_child_run_request(*_args, **kwargs):
        enqueued.append(kwargs)
        return SimpleNamespace(id="request-2")

    async def persist_child_user_message(*_args, **kwargs):
        persisted.append(kwargs["content"])
        return SimpleNamespace(id="child-message-2", seq=1)

    async def wait_for_assistant_content(*_args, **_kwargs) -> str:
        return "writer revised"

    monkeypatch.setattr(
        NotifySubagentTool,
        "_wait_for_assistant_content",
        wait_for_assistant_content,
    )
    notify_module = __import__(
        "app.agent_runtime.tools.impls.orchestration.notify_subagent",
        fromlist=["notify_subagent"],
    )
    monkeypatch.setattr(notify_module, "ensure_primary", noop)
    monkeypatch.setattr(notify_module, "resolve_child_run", resolve_child_run)
    monkeypatch.setattr(notify_module, "open_session", open_session)
    monkeypatch.setattr(notify_module, "close_session", noop)
    monkeypatch.setattr(notify_module, "latest_checkpoint_id_for_thread", noop)
    monkeypatch.setattr(
        notify_module, "enqueue_child_run_request", enqueue_child_run_request
    )
    monkeypatch.setattr(
        notify_module, "persist_child_user_message", persist_child_user_message
    )
    monkeypatch.setattr(notify_module, "update_child_run_request_boundaries", noop)
    monkeypatch.setattr(notify_module, "emit_subagent_tool_preview", noop)
    monkeypatch.setattr(
        notify_module, "make_subagent_runner", lambda **_kwargs: _Runner()
    )

    tool = NotifySubagentTool(_state=_state())

    result = json.loads(
        await tool._arun(
            dispatch_id="dispatch-writer",
            prompt="补充：下一章仍从七天借住期限开始。",
            config={"metadata": {"tool_call_id": "call-notify"}},
        )
    )

    assert result["result"] == "writer revised"
    assert len(enqueued) == 1
    content = enqueued[0]["content"]
    assert AUTHOR_TEXT in content
    assert content.index(AUTHOR_TEXT) < content.index("补充：下一章仍从七天借住期限开始。")
    assert enqueued[0]["request_kind"] == "notify"
    assert enqueued[0]["parent_revision_id"] == REVISION_ID
    assert persisted == [content]


async def test_notify_fails_closed_on_mismatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _install(
        monkeypatch, revision=_revision(), message=_message(status="aborted")
    )
    enqueued: list[dict] = []
    persisted: list[str] = []

    async def noop(*_args, **_kwargs) -> None:
        return None

    async def open_session(*_args, **_kwargs):
        return session

    async def resolve_child_run(**_kwargs):
        return SimpleNamespace(id="child-run-writer", is_active=True)

    async def enqueue_child_run_request(*_args, **kwargs):
        enqueued.append(kwargs)
        return SimpleNamespace(id="request-2")

    async def persist_child_user_message(*_args, **kwargs):
        persisted.append(kwargs["content"])
        return SimpleNamespace(id="child-message-2", seq=1)

    notify_module = __import__(
        "app.agent_runtime.tools.impls.orchestration.notify_subagent",
        fromlist=["notify_subagent"],
    )
    monkeypatch.setattr(notify_module, "ensure_primary", noop)
    monkeypatch.setattr(notify_module, "resolve_child_run", resolve_child_run)
    monkeypatch.setattr(notify_module, "open_session", open_session)
    monkeypatch.setattr(notify_module, "close_session", noop)
    monkeypatch.setattr(
        notify_module, "enqueue_child_run_request", enqueue_child_run_request
    )
    monkeypatch.setattr(
        notify_module, "persist_child_user_message", persist_child_user_message
    )

    tool = NotifySubagentTool(_state=_state())

    result = json.loads(
        await tool._arun(
            dispatch_id="dispatch-writer",
            prompt="补充。",
            config={"metadata": {"tool_call_id": "call-notify"}},
        )
    )

    assert result["success"] is False
    assert result["code"] == "conflict"
    for marker in SECRET_MARKERS:
        assert marker not in json.dumps(result, ensure_ascii=False)
    assert enqueued == []
    assert persisted == []


def test_capture_metadata_has_no_body() -> None:
    capture = author_request.AuthorRequestCapture(
        revision_id=REVISION_ID,
        message_id=MESSAGE_ID,
        message_seq=3,
        content=AUTHOR_TEXT,
    )
    metadata = capture.to_metadata(token_counter=lambda text: 7)

    assert metadata["tokens"] == 7
    assert metadata["chars"] == len(AUTHOR_TEXT)
    assert metadata["source_consumption"] == "unverified"
    serialized = json.dumps(metadata, ensure_ascii=False)
    for marker in SECRET_MARKERS:
        assert marker not in serialized


def test_author_budget_at_and_over_bound() -> None:
    def fixed_tokens(_text: str) -> int:
        return 1

    at_bound = AUTHOR_TEXT + "甲" * (author_request.MAX_AUTHOR_REQUEST_CHARS - len(AUTHOR_TEXT))
    capture = author_request.AuthorRequestCapture(
        revision_id=REVISION_ID,
        message_id=MESSAGE_ID,
        message_seq=3,
        content=at_bound,
    )
    author_request.enforce_author_request_budget(capture, token_counter=fixed_tokens)

    over_bound = at_bound + "乙"
    over = author_request.AuthorRequestCapture(
        revision_id=REVISION_ID,
        message_id=MESSAGE_ID,
        message_seq=3,
        content=over_bound,
    )
    with pytest.raises(ToolExecutionError) as exc_info:
        author_request.enforce_author_request_budget(over, token_counter=fixed_tokens)
    assert exc_info.value.code == "limit_exceeded"
    assert "乙" not in str(exc_info.value)

    token_at = author_request.AuthorRequestCapture(
        revision_id=REVISION_ID,
        message_id=MESSAGE_ID,
        message_seq=3,
        content="短文本",
    )
    author_request.enforce_author_request_budget(
        token_at,
        token_counter=lambda _text: author_request.MAX_AUTHOR_REQUEST_TOKENS,
    )
    with pytest.raises(ToolExecutionError) as exc_info:
        author_request.enforce_author_request_budget(
            token_at,
            token_counter=lambda _text: author_request.MAX_AUTHOR_REQUEST_TOKENS + 1,
        )
    assert exc_info.value.code == "limit_exceeded"
    assert "短文本" not in str(exc_info.value)


def test_composed_budget_at_and_over_bound() -> None:
    def fixed_tokens(_text: str) -> int:
        return 1

    at_bound = "丙" * author_request.MAX_COMPOSED_TASK_CHARS
    author_request.enforce_composed_task_budget(at_bound, token_counter=fixed_tokens)

    with pytest.raises(ToolExecutionError) as exc_info:
        author_request.enforce_composed_task_budget(
            at_bound + "丁", token_counter=fixed_tokens
        )
    assert exc_info.value.code == "limit_exceeded"
    assert "丁" not in str(exc_info.value)
    assert "丙" not in str(exc_info.value)

    author_request.enforce_composed_task_budget(
        "小任务",
        token_counter=lambda _text: author_request.MAX_COMPOSED_TASK_TOKENS,
    )
    with pytest.raises(ToolExecutionError) as exc_info:
        author_request.enforce_composed_task_budget(
            "小任务",
            token_counter=lambda _text: author_request.MAX_COMPOSED_TASK_TOKENS + 1,
        )
    assert exc_info.value.code == "limit_exceeded"
    assert "小任务" not in str(exc_info.value)


@pytest.mark.asyncio
async def test_dispatch_over_composed_budget_creates_no_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _install(monkeypatch, revision=_revision(), message=_message())
    created: list[dict] = []
    persisted: list[str] = []
    _patch_dispatch(monkeypatch, created=created, persisted=persisted, session=session)

    monkeypatch.setattr(author_request, "MAX_COMPOSED_TASK_CHARS", 40)

    tool = DispatchSubagentTool(_state=_state())

    result = json.loads(
        await tool._arun(
            agent_type="writer",
            description="改写第一章",
            prompt="Plan 摘要。",
            config={"metadata": {"tool_call_id": "call-dispatch"}},
        )
    )

    assert result["code"] == "limit_exceeded"
    assert created == []
    assert persisted == []
    for marker in SECRET_MARKERS:
        assert marker not in json.dumps(result, ensure_ascii=False)


@pytest.mark.asyncio
async def test_dispatch_over_author_budget_creates_no_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _install(monkeypatch, revision=_revision(), message=_message())
    created: list[dict] = []
    persisted: list[str] = []
    _patch_dispatch(monkeypatch, created=created, persisted=persisted, session=session)

    monkeypatch.setattr(author_request, "MAX_AUTHOR_REQUEST_CHARS", 10)

    tool = DispatchSubagentTool(_state=_state())

    result = json.loads(
        await tool._arun(
            agent_type="writer",
            description="改写第一章",
            prompt="Plan 摘要。",
            config={"metadata": {"tool_call_id": "call-dispatch"}},
        )
    )

    assert result["code"] == "limit_exceeded"
    assert created == []
    assert persisted == []
