import json
from dataclasses import replace
from types import MappingProxyType, SimpleNamespace

import pytest
from pydantic import ValidationError

from app.agent_runtime.agents.definitions import AgentDefinition
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.orchestration import common
from app.agent_runtime.tools.impls.orchestration.dispatch_subagent import (
    DispatchSubagentInput,
    DispatchSubagentTool,
)


def _make_definition(
    key: str,
    kind: str,
    delegatable_agents: tuple[str, ...] = (),
) -> AgentDefinition:
    return AgentDefinition(
        key=key,
        display_name=key,
        description=key,
        kind=kind,  # type: ignore[arg-type]
        prompt_agent_name=key,
        model_id=None,
        enabled_tool_categories=(),
        enabled_skills=(),
        metadata=MappingProxyType({}),
        delegatable_agents=delegatable_agents,
    )


@pytest.mark.asyncio
async def test_dispatch_subagent_rejects_empty_primary_delegatable_agents(
    monkeypatch: pytest.MonkeyPatch,
):
    definitions = {
        "build": _make_definition("build", "primary"),
        "explore": _make_definition("explore", "subagent"),
    }

    async def load_definition(
        _self: DispatchSubagentTool,
        agent_key: str,
        _configurable: dict,
    ) -> AgentDefinition:
        return definitions[agent_key]

    monkeypatch.setattr(DispatchSubagentTool, "_load_definition", load_definition)
    tool = DispatchSubagentTool(_state={"active_agent": "build"})

    with pytest.raises(
        ToolExecutionError, match="not in the delegatable agents whitelist"
    ):
        await tool._validate_dispatch("explore", {})


@pytest.mark.asyncio
async def test_ensure_primary_accepts_custom_primary_agent(
    monkeypatch: pytest.MonkeyPatch,
):
    class Session:
        async def close(self) -> None:
            pass

    async def load_definition(
        _session: Session,
        agent_key: str,
    ) -> AgentDefinition:
        assert agent_key == "custom-primary"
        return _make_definition("custom-primary", "primary")

    monkeypatch.setattr(common, "load_agent_definition", load_definition)

    await common.ensure_primary({"active_agent": "custom-primary"}, lambda: Session())


@pytest.mark.asyncio
async def test_ensure_primary_rejects_subagent(
    monkeypatch: pytest.MonkeyPatch,
):
    class Session:
        async def close(self) -> None:
            pass

    async def load_definition(
        _session: Session,
        _agent_key: str,
    ) -> AgentDefinition:
        return _make_definition("writer", "subagent")

    monkeypatch.setattr(common, "load_agent_definition", load_definition)

    with pytest.raises(ToolExecutionError, match="primary agent"):
        await common.ensure_primary({"active_agent": "writer"}, lambda: Session())


@pytest.mark.asyncio
async def test_ensure_primary_rejects_disabled_primary_agent(
    monkeypatch: pytest.MonkeyPatch,
):
    class Session:
        async def close(self) -> None:
            pass

    async def load_definition(
        _session: Session,
        _agent_key: str,
    ) -> AgentDefinition:
        definition = _make_definition("disabled-primary", "primary")
        return replace(definition, enabled=False)

    monkeypatch.setattr(common, "load_agent_definition", load_definition)

    with pytest.raises(ToolExecutionError, match="primary agent"):
        await common.ensure_primary(
            {"active_agent": "disabled-primary"}, lambda: Session()
        )


@pytest.mark.asyncio
async def test_dispatch_subagent_returns_dispatch_id_when_child_request_is_cancelled(
    monkeypatch: pytest.MonkeyPatch,
):
    import app.agent_runtime.tools.impls.orchestration.dispatch_subagent as dispatch_module

    row = SimpleNamespace(
        id="child-run-1",
        child_thread_id="parent:child:dispatch-cancelled",
        dispatch_id="dispatch-cancelled",
        metadata_json={"agent_number": 3},
        pending_approval_json=None,
    )

    async def noop(*_args, **_kwargs) -> None:
        return None

    async def open_session(*_args, **_kwargs) -> object:
        return object()

    async def load_waiting_child_run(*_args, **_kwargs):
        return None

    async def create_child_run(*_args, **_kwargs):
        return row

    async def persist_child_user_message(*_args, **_kwargs):
        return SimpleNamespace(id="message-1", seq=1)

    async def load_initial_request_id(*_args, **_kwargs) -> str:
        return "request-1"

    async def wait_for_assistant_content(*_args, **_kwargs) -> str:
        raise ToolExecutionError("subagent request was cancelled")

    class Runner:
        async def publish_parent_subagent_status(self, _child_run_id: str) -> None:
            return None

    monkeypatch.setattr(DispatchSubagentTool, "_validate_dispatch", noop)
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_load_waiting_child_run",
        load_waiting_child_run,
    )
    monkeypatch.setattr(DispatchSubagentTool, "_create_child_run", create_child_run)
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_load_initial_request_id",
        load_initial_request_id,
    )
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_wait_for_assistant_content",
        wait_for_assistant_content,
    )
    monkeypatch.setattr(dispatch_module, "latest_checkpoint_id_for_thread", noop)
    monkeypatch.setattr(
        dispatch_module, "persist_child_user_message", persist_child_user_message
    )
    monkeypatch.setattr(dispatch_module, "open_session", open_session)
    monkeypatch.setattr(dispatch_module, "close_session", noop)
    monkeypatch.setattr(dispatch_module, "update_child_run_request_boundaries", noop)
    monkeypatch.setattr(
        dispatch_module, "make_subagent_runner", lambda **_kwargs: Runner()
    )

    tool = DispatchSubagentTool(
        _state={
            "session_id": "parent",
            "task_id": "task-1",
            "project_id": "project-1",
        }
    )

    result = json.loads(
        await tool._arun(
            agent_type="writer",
            description="write scene",
            prompt="write scene",
        )
    )

    assert result == {
        "dispatch_id": "dispatch-cancelled",
        "agent_number": 3,
        "type": "fail",
        "success": False,
        "code": "execution_failed",
        "message": "subagent request was cancelled",
    }


class _Runner:
    async def publish_parent_subagent_status(self, _child_run_id: str) -> None:
        return None


def _patch_dispatch_runtime(
    monkeypatch: pytest.MonkeyPatch,
    dispatch_module,
    *,
    child_row: SimpleNamespace,
    created: list[dict],
    persisted: list[str],
    waiting_row: SimpleNamespace | None = None,
    wait_calls: list[dict] | None = None,
    assistant_content: str = "actor completed",
) -> None:
    async def noop(*_args, **_kwargs) -> None:
        return None

    async def open_session(*_args, **_kwargs) -> object:
        return object()

    async def load_waiting_child_run(*_args, **_kwargs):
        return waiting_row

    async def load_running_request_id(*_args, **_kwargs) -> str:
        return "request-running"

    async def create_child_run(*_args, **kwargs):
        created.append(kwargs)
        return child_row

    async def load_initial_request_id(*_args, **_kwargs) -> str:
        return "request-1"

    async def persist_child_user_message(*_args, **kwargs):
        persisted.append(kwargs["content"])
        return SimpleNamespace(id="message-1", seq=1)

    async def wait_for_assistant_content(*_args, **kwargs) -> str:
        if wait_calls is not None:
            wait_calls.append(kwargs)
        return assistant_content

    monkeypatch.setattr(DispatchSubagentTool, "_validate_dispatch", noop)
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_load_waiting_child_run",
        load_waiting_child_run,
    )
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_load_running_request_id",
        load_running_request_id,
    )
    monkeypatch.setattr(DispatchSubagentTool, "_create_child_run", create_child_run)
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_load_initial_request_id",
        load_initial_request_id,
    )
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_wait_for_assistant_content",
        wait_for_assistant_content,
    )
    monkeypatch.setattr(dispatch_module, "latest_checkpoint_id_for_thread", noop)
    monkeypatch.setattr(
        dispatch_module,
        "persist_child_user_message",
        persist_child_user_message,
    )
    monkeypatch.setattr(dispatch_module, "open_session", open_session)
    monkeypatch.setattr(dispatch_module, "close_session", noop)
    monkeypatch.setattr(dispatch_module, "update_child_run_request_boundaries", noop)
    monkeypatch.setattr(
        dispatch_module,
        "make_subagent_runner",
        lambda **_kwargs: _Runner(),
    )


def _parent_state() -> dict:
    return {
        "session_id": "parent",
        "task_id": "task-1",
        "project_id": "project-1",
    }


@pytest.mark.asyncio
async def test_dispatch_subagent_appends_referenced_deliverable_as_reference_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.agent_runtime.tools.impls.orchestration.dispatch_subagent as dispatch_module
    from app.agent_runtime.tools.impls.orchestration import handoff as handoff_module

    child_row = SimpleNamespace(
        id="child-run-actor",
        child_thread_id="parent:child:dispatch-actor",
        dispatch_id="dispatch-actor",
        agent_key="actor",
        metadata_json={"agent_number": "#1002"},
        pending_approval_json=None,
    )
    source_row = SimpleNamespace(
        id="child-run-writer",
        dispatch_id="dispatch-writer",
        parent_session_id="parent",
        parent_task_id="task-1",
        agent_key="writer",
        is_active=True,
        metadata_json={"agent_number": "#1001"},
    )
    source_request = SimpleNamespace(
        id="request-writer",
        child_run_id="child-run-writer",
        parent_session_id="parent",
        parent_task_id="task-1",
        status="completed",
        assistant_content="候选正文：灯灭了。",
        content="给Writer的原始任务文本",
        seq=1,
    )
    created: list[dict] = []
    persisted: list[str] = []
    emitted: list[tuple[str, dict]] = []

    _patch_dispatch_runtime(
        monkeypatch,
        dispatch_module,
        child_row=child_row,
        created=created,
        persisted=persisted,
    )

    async def get_child_run_for_parent_dispatch_id(
        _session,
        *,
        parent_session_id: str,
        dispatch_id: str,
    ):
        assert parent_session_id == "parent"
        return source_row if dispatch_id == "dispatch-writer" else None

    async def get_latest_child_run_requests(_session, child_run_ids):
        assert list(child_run_ids) == ["child-run-writer"]
        return {"child-run-writer": source_request}

    async def event_sink(name: str, payload: dict) -> None:
        emitted.append((name, payload))

    monkeypatch.setattr(
        handoff_module,
        "get_child_run_for_parent_dispatch_id",
        get_child_run_for_parent_dispatch_id,
    )
    monkeypatch.setattr(
        handoff_module,
        "get_latest_child_run_requests",
        get_latest_child_run_requests,
    )

    tool = DispatchSubagentTool(_state=_parent_state())

    result = json.loads(
        await tool._arun(
            agent_type="actor",
            description="依据候选稿改写",
            prompt="请把候选稿改成第一人称。",
            source_dispatch_ids=["dispatch-writer"],
            config={
                "metadata": {"tool_call_id": "call-dispatch"},
                "configurable": {"agent_event_sink": event_sink},
            },
        )
    )

    assert result["dispatch_id"] == "dispatch-actor"
    assert result["result"] == "actor completed"
    assert created[0]["agent_key"] == "actor"

    request = created[0]["request"]
    assert request["description"] == "依据候选稿改写"
    assert request["original_task"] == "请把候选稿改成第一人称。"
    assert request["task"].startswith("请把候选稿改成第一人称。")
    assert request["task"].endswith(handoff_module.REFERENCE_BLOCK_END)
    assert "候选正文：灯灭了。" in request["task"]
    assert "给Writer的原始任务文本" not in request["task"]
    assert request["handoff"]["source_dispatch_ids"] == ["dispatch-writer"]
    assert request["handoff"]["sources"][0]["agent_key"] == "writer"
    assert persisted == [request["task"]]

    preview = emitted[0][1]
    assert preview["tool"] == "dispatch_subagent"
    assert preview["input"] == {
        "agent_type": "actor",
        "description": "依据候选稿改写",
        "prompt": "请把候选稿改成第一人称。",
        "source_dispatch_ids": ["dispatch-writer"],
    }
    assert "候选正文：灯灭了。" not in json.dumps(preview, ensure_ascii=False)


@pytest.mark.asyncio
async def test_dispatch_subagent_without_reference_ids_keeps_plain_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.agent_runtime.tools.impls.orchestration.dispatch_subagent as dispatch_module

    child_row = SimpleNamespace(
        id="child-run-writer",
        child_thread_id="parent:child:dispatch-writer",
        dispatch_id="dispatch-writer",
        agent_key="writer",
        metadata_json={"agent_number": "#1001"},
        pending_approval_json=None,
    )
    created: list[dict] = []
    persisted: list[str] = []
    emitted: list[tuple[str, dict]] = []

    _patch_dispatch_runtime(
        monkeypatch,
        dispatch_module,
        child_row=child_row,
        created=created,
        persisted=persisted,
    )

    async def fail_if_looked_up(*_args, **_kwargs):
        raise AssertionError("handoff sources must not be resolved without ids")

    monkeypatch.setattr(
        dispatch_module,
        "resolve_handoff_sources",
        fail_if_looked_up,
    )

    async def event_sink(name: str, payload: dict) -> None:
        emitted.append((name, payload))

    tool = DispatchSubagentTool(_state=_parent_state())

    await tool._arun(
        agent_type="writer",
        description="写场景",
        prompt="写一个雨夜场景。",
        config={
            "metadata": {"tool_call_id": "call-dispatch"},
            "configurable": {"agent_event_sink": event_sink},
        },
    )

    assert created[0]["request"] == {
        "description": "写场景",
        "task": "写一个雨夜场景。",
    }
    assert persisted == ["写一个雨夜场景。"]
    assert emitted[0][1]["input"] == {
        "agent_type": "writer",
        "description": "写场景",
        "prompt": "写一个雨夜场景。",
    }


@pytest.mark.asyncio
async def test_dispatch_subagent_rejects_unavailable_reference_without_child_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.agent_runtime.tools.impls.orchestration.dispatch_subagent as dispatch_module
    from app.agent_runtime.tools.impls.orchestration import handoff as handoff_module

    created: list[dict] = []
    persisted: list[str] = []
    emitted: list[tuple[str, dict]] = []

    _patch_dispatch_runtime(
        monkeypatch,
        dispatch_module,
        child_row=SimpleNamespace(
            id="child-run-actor",
            child_thread_id="parent:child:dispatch-actor",
            dispatch_id="dispatch-actor",
            agent_key="actor",
            metadata_json={"agent_number": "#1002"},
            pending_approval_json=None,
        ),
        created=created,
        persisted=persisted,
    )

    async def get_child_run_for_parent_dispatch_id(_session, **_kwargs):
        return None

    async def get_latest_child_run_requests(_session, _child_run_ids):
        raise AssertionError("unknown sources must fail before reading latest requests")

    async def event_sink(name: str, payload: dict) -> None:
        emitted.append((name, payload))

    monkeypatch.setattr(
        handoff_module,
        "get_child_run_for_parent_dispatch_id",
        get_child_run_for_parent_dispatch_id,
    )
    monkeypatch.setattr(
        handoff_module,
        "get_latest_child_run_requests",
        get_latest_child_run_requests,
    )

    tool = DispatchSubagentTool(_state=_parent_state())

    result = json.loads(
        await tool._arun(
            agent_type="actor",
            description="依据候选稿改写",
            prompt="请把候选稿改成第一人称。",
            source_dispatch_ids=["dispatch-missing"],
            config={
                "metadata": {"tool_call_id": "call-dispatch"},
                "configurable": {"agent_event_sink": event_sink},
            },
        )
    )

    assert result == {
        "type": "fail",
        "success": False,
        "code": "not_found",
        "message": "unknown source dispatch id: dispatch-missing",
    }
    assert created == []
    assert persisted == []
    assert emitted == []


@pytest.mark.asyncio
async def test_dispatch_subagent_resume_does_not_resolve_references_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.agent_runtime.tools.impls.orchestration.dispatch_subagent as dispatch_module

    waiting_row = SimpleNamespace(
        id="child-run-actor",
        child_thread_id="parent:child:dispatch-actor",
        dispatch_id="dispatch-actor",
        agent_key="actor",
        metadata_json={"agent_number": "#1002"},
        pending_approval_json={"approval_id": "approval-1"},
    )
    created: list[dict] = []
    persisted: list[str] = []
    wait_calls: list[dict] = []

    async def fail_if_resolved(*_args, **_kwargs):
        raise AssertionError("resumed dispatch must reuse the persisted request")

    monkeypatch.setattr(
        dispatch_module,
        "resolve_handoff_sources",
        fail_if_resolved,
    )
    _patch_dispatch_runtime(
        monkeypatch,
        dispatch_module,
        child_row=waiting_row,
        created=created,
        persisted=persisted,
        waiting_row=waiting_row,
        wait_calls=wait_calls,
    )

    tool = DispatchSubagentTool(_state=_parent_state())

    result = json.loads(
        await tool._arun(
            agent_type="actor",
            description="依据候选稿改写",
            prompt="请把候选稿改成第一人称。",
            source_dispatch_ids=["dispatch-writer"],
            config={"metadata": {"tool_call_id": "call-dispatch"}},
        )
    )

    assert result["dispatch_id"] == "dispatch-actor"
    assert result["result"] == "actor completed"
    assert created == []
    assert persisted == []
    assert len(wait_calls) == 1
    assert wait_calls[0]["child_run_id"] == "child-run-actor"
    assert wait_calls[0]["request_id"] == "request-running"
    assert wait_calls[0]["start_processing"] is False


def test_dispatch_subagent_input_defaults_to_no_reference() -> None:
    parsed = DispatchSubagentInput(
        agent_type="writer",
        description="写场景",
        prompt="写一个雨夜场景。",
    )

    assert parsed.source_dispatch_ids == []


def test_dispatch_subagent_input_accepts_up_to_three_references() -> None:
    parsed = DispatchSubagentInput(
        agent_type="actor",
        description="改写",
        prompt="改写第三幕。",
        source_dispatch_ids=["dispatch-1", "dispatch-2", "dispatch-3"],
    )

    assert parsed.source_dispatch_ids == ["dispatch-1", "dispatch-2", "dispatch-3"]


def test_dispatch_subagent_input_rejects_more_than_three_references() -> None:
    with pytest.raises(ValidationError):
        DispatchSubagentInput(
            agent_type="actor",
            description="改写",
            prompt="改写第三幕。",
            source_dispatch_ids=["a", "b", "c", "d"],
        )


def test_dispatch_subagent_input_forbids_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        DispatchSubagentInput(
            agent_type="actor",
            description="改写",
            prompt="改写第三幕。",
            handoff_source="dispatch-1",
        )
