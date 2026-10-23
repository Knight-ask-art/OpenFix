"""LF-03 regression: the requested max_iterations reaches the real ReAct loop."""

import asyncio
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command, interrupt

from app.agent_runtime.context.types import ContextMessage
from app.agent_runtime.graph.orchestrator import graph as orchestrator_graph_module
from app.agent_runtime.graph.orchestrator.graph import build_orchestrator_graph
from app.agent_runtime.types import (
    DEFAULT_AGENT_MAX_ITERATIONS,
    TERMINATION_REASON_MAX_ITERATIONS,
)

TOOL_NAME = "count_tool"


def _model_config() -> dict:
    return {
        "provider_type": "openai",
        "model_id": "gpt-test",
        "api_key": "test-key",
        "base_url": "",
        "max_context_tokens": 8000,
    }


def _runtime_config(
    thread_id: str,
    *,
    max_iterations: int | None = None,
) -> dict:
    configurable: dict = {
        "thread_id": thread_id,
        "db_session": object(),
        "model_config": _model_config(),
    }
    if max_iterations is not None:
        configurable["max_iterations"] = max_iterations
    return {"configurable": configurable}


def _initial_state(*, max_iterations: int | None = None) -> dict:
    state = {
        "session_id": "max-iterations-session",
        "task_id": "task-1",
        "project_id": "project-1",
        "model_config": _model_config(),
        "active_agent": None,
        "agent_key": "build",
        "is_completed": False,
        "error": None,
        "retry_count": 0,
        "user_request": "",
        "user_attachments": [],
        "current_revision_id": "rev-1",
        "messages": [],
    }
    if max_iterations is not None:
        state["max_iterations"] = max_iterations
    return state


def _counting_tool(executions: list[int]) -> StructuredTool:
    async def _run() -> str:
        executions[0] += 1
        return '{"success": true}'

    return StructuredTool.from_function(
        coroutine=_run,
        name=TOOL_NAME,
        description="count executions",
    )


def _always_tool_invoke(model_calls: list[int]):
    async def _invoke(*_args, **_kwargs):
        model_calls[0] += 1
        return AIMessage(
            content="",
            tool_calls=[
                {
                    "id": f"call-{model_calls[0]}",
                    "name": TOOL_NAME,
                    "args": {},
                }
            ],
        )

    return _invoke


@contextmanager
def _patched_primary_react(tool: StructuredTool, invoke_model):
    class _Model:
        def bind_tools(self, _tools):
            return self

    with (
        patch(
            "app.agent_runtime.graph.orchestrator.graph.create_chat_model",
            return_value=_Model(),
        ),
        patch(
            "app.agent_runtime.graph.orchestrator.graph.ToolRegistry.get_tools",
            return_value=[tool],
        ),
        patch(
            "app.agent_runtime.graph.orchestrator.graph._primary_tool_names",
            AsyncMock(return_value=[TOOL_NAME]),
        ),
        patch(
            "app.agent_runtime.graph.orchestrator.graph._primary_build_hooks",
            AsyncMock(return_value=[]),
        ),
        patch(
            "app.agent_runtime.graph.react_agent._invoke_model",
            side_effect=invoke_model,
        ),
        patch(
            "app.agent_runtime.graph.react_agent.build_context_parts",
            AsyncMock(
                return_value=[ContextMessage(role="user", content="run the task")]
            ),
        ),
    ):
        yield


@pytest.mark.asyncio
async def test_requested_low_cap_stops_real_graph_without_extra_tool_dispatch() -> (
    None
):
    model_calls = [0]
    tool_executions = [0]
    graph = build_orchestrator_graph(checkpointer=InMemorySaver())

    with _patched_primary_react(
        _counting_tool(tool_executions),
        _always_tool_invoke(model_calls),
    ):
        result = await graph.ainvoke(
            _initial_state(max_iterations=2),
            config=_runtime_config("max-iterations-low-cap"),
        )

    # Exactly the allowed number of model calls and tool dispatches happen;
    # the exhausted budget never starts another LLM call or tool batch.
    assert model_calls[0] == 2
    assert tool_executions[0] == 2
    assert result["max_iterations"] == 2
    assert result["termination_reason"] == TERMINATION_REASON_MAX_ITERATIONS
    assert result["is_completed"] is True


@pytest.mark.asyncio
async def test_cap_persisted_in_checkpoint_survives_restart_and_next_turn() -> None:
    checkpointer = InMemorySaver()
    thread_id = "max-iterations-restart"
    thread_config = {"configurable": {"thread_id": thread_id}}
    graph = build_orchestrator_graph(checkpointer=checkpointer)
    await graph.aupdate_state(
        thread_config,
        _initial_state(max_iterations=1),
    )

    first_model_calls = [0]
    first_tool_executions = [0]
    with _patched_primary_react(
        _counting_tool(first_tool_executions),
        _always_tool_invoke(first_model_calls),
    ):
        await graph.ainvoke(
            {"user_request": "第一轮", "messages": []},
            config=_runtime_config(thread_id),
        )

    assert first_model_calls[0] == 1
    assert first_tool_executions[0] == 1
    stored = await graph.aget_state(thread_config)
    assert stored.values["max_iterations"] == 1

    # A fresh graph instance sharing the checkpointer simulates a process
    # restart: the requested cap must still be restored from the checkpoint.
    restarted_graph = build_orchestrator_graph(checkpointer=checkpointer)
    restored = await restarted_graph.aget_state(thread_config)
    assert restored.values["max_iterations"] == 1

    second_model_calls = [0]
    second_tool_executions = [0]
    with _patched_primary_react(
        _counting_tool(second_tool_executions),
        _always_tool_invoke(second_model_calls),
    ):
        result = await restarted_graph.ainvoke(
            {"user_request": "第二轮", "messages": []},
            config=_runtime_config(thread_id),
        )

    assert second_model_calls[0] == 1
    assert second_tool_executions[0] == 1
    assert result["max_iterations"] == 1
    assert result["termination_reason"] == TERMINATION_REASON_MAX_ITERATIONS


@pytest.mark.asyncio
async def test_runtime_config_cap_applies_when_checkpoint_has_no_cap() -> None:
    model_calls = [0]
    tool_executions = [0]
    graph = build_orchestrator_graph(checkpointer=InMemorySaver())

    with _patched_primary_react(
        _counting_tool(tool_executions),
        _always_tool_invoke(model_calls),
    ):
        result = await graph.ainvoke(
            _initial_state(),
            config=_runtime_config("max-iterations-config-fallback", max_iterations=1),
        )

    assert model_calls[0] == 1
    assert tool_executions[0] == 1
    assert result["max_iterations"] == 1
    assert result["termination_reason"] == TERMINATION_REASON_MAX_ITERATIONS


@pytest.mark.asyncio
async def test_legacy_session_without_cap_uses_default_1000() -> None:
    model_calls = [0]

    async def _finish_without_tools(*_args, **_kwargs):
        model_calls[0] += 1
        return AIMessage(content="done")

    captured_caps: list[int] = []
    original_create_react_agent = orchestrator_graph_module.create_react_agent

    def _capture_react_config(config, **kwargs):
        captured_caps.append(config.max_iterations)
        return original_create_react_agent(config, **kwargs)

    graph = build_orchestrator_graph(checkpointer=InMemorySaver())
    with (
        _patched_primary_react(_counting_tool([0]), _finish_without_tools),
        patch.object(
            orchestrator_graph_module,
            "create_react_agent",
            _capture_react_config,
        ),
    ):
        result = await graph.ainvoke(
            _initial_state(),
            config=_runtime_config("max-iterations-legacy"),
        )

    assert captured_caps == [DEFAULT_AGENT_MAX_ITERATIONS]
    assert result["max_iterations"] == DEFAULT_AGENT_MAX_ITERATIONS
    # A natural finish is not mislabeled as a budget stop.
    assert result["termination_reason"] is None


@pytest.mark.asyncio
async def test_queued_injection_cannot_extend_exhausted_budget() -> None:
    inject_queue: asyncio.Queue = asyncio.Queue()
    model_calls = [0]

    async def _queue_message_and_run() -> str:
        await inject_queue.put((None, "user", "继续执行"))
        return '{"success": true}'

    tool = StructuredTool.from_function(
        coroutine=_queue_message_and_run,
        name=TOOL_NAME,
        description="queue an injected message",
    )
    config = _runtime_config("max-iterations-injection")
    config["configurable"]["inject_queue"] = inject_queue
    graph = build_orchestrator_graph(checkpointer=InMemorySaver())

    with _patched_primary_react(tool, _always_tool_invoke(model_calls)):
        result = await graph.ainvoke(
            _initial_state(max_iterations=1),
            config=config,
        )

    assert model_calls[0] == 1
    assert inject_queue.qsize() == 1
    assert result["termination_reason"] == TERMINATION_REASON_MAX_ITERATIONS


@pytest.mark.asyncio
async def test_approval_resume_across_graph_rebuilds_keeps_iteration_budget() -> None:
    thread_id = "max-iterations-approval-resume"
    thread_config = {"configurable": {"thread_id": thread_id}}
    checkpointer = InMemorySaver()
    model_calls = [0]
    tool_executions = [0]

    async def _approval_tool() -> str:
        approved = interrupt(
            {"type": "tool_approval", "tool_name": TOOL_NAME, "args": {}}
        )
        # Count only completed executions: the node replays from the interrupt
        # on resume, so incrementing before it would double-count the tool.
        tool_executions[0] += 1
        return '{"success": true, "approved": ' + str(bool(approved)).lower() + "}"

    tool = StructuredTool.from_function(
        coroutine=_approval_tool,
        name=TOOL_NAME,
        description="requires approval",
    )

    async def _pending_interrupts(graph) -> list:
        state = await graph.aget_state(thread_config)
        return [
            pending for task in state.tasks for pending in getattr(task, "interrupts", ())
        ]

    graph = build_orchestrator_graph(checkpointer=checkpointer)
    with _patched_primary_react(tool, _always_tool_invoke(model_calls)):
        # The cap is written into the parent checkpoint by the caller; every
        # rebuilt graph must restore it from there, not from the runtime config.
        await graph.aupdate_state(thread_config, _initial_state(max_iterations=2))
        await graph.ainvoke(
            {"user_request": "第一轮", "messages": []},
            config=_runtime_config(thread_id),
        )

    # First model response asked for approval; same turn is now suspended.
    first_interrupts = await _pending_interrupts(graph)
    assert model_calls[0] == 1
    assert tool_executions[0] == 0
    assert len(first_interrupts) == 1
    assert (await graph.aget_state(thread_config)).values["max_iterations"] == 2

    resumed_graph = build_orchestrator_graph(checkpointer=checkpointer)
    with _patched_primary_react(tool, _always_tool_invoke(model_calls)):
        await resumed_graph.ainvoke(
            Command(resume={first_interrupts[0].id: True}),
            config=_runtime_config(thread_id),
        )

    # The resumed tool finishes and the second (last allowed) model response
    # asks for approval again; the remaining budget must not be reset by the resume.
    second_interrupts = await _pending_interrupts(resumed_graph)
    assert model_calls[0] == 2
    assert tool_executions[0] == 1
    assert len(second_interrupts) == 1
    second_state = await resumed_graph.aget_state(thread_config)
    assert second_state.values["max_iterations"] == 2

    rebuilt_graph = build_orchestrator_graph(checkpointer=checkpointer)
    with _patched_primary_react(tool, _always_tool_invoke(model_calls)):
        await rebuilt_graph.ainvoke(
            Command(resume={second_interrupts[0].id: True}),
            config=_runtime_config(thread_id),
        )

    result_state = await rebuilt_graph.aget_state(thread_config)
    # The budget is spent: the approved tool completes but no third model call
    # is made, and the stop is reported with the structured reason.
    assert model_calls[0] == 2
    assert tool_executions[0] == 2
    assert result_state.values["max_iterations"] == 2
    assert result_state.values["termination_reason"] == TERMINATION_REASON_MAX_ITERATIONS
    assert await _pending_interrupts(rebuilt_graph) == []


def test_termination_payload_is_structured_and_legacy_safe() -> None:
    from app.agent_runtime.runner.session_runner import SessionRunner

    stopped = SimpleNamespace(
        values={
            "termination_reason": TERMINATION_REASON_MAX_ITERATIONS,
            "max_iterations": 4,
        }
    )
    assert SessionRunner._termination_payload(stopped) == {
        "termination_reason": TERMINATION_REASON_MAX_ITERATIONS,
        "max_iterations": 4,
    }
    assert SessionRunner._termination_payload(
        SimpleNamespace(values={"max_iterations": 4})
    ) == {}
    assert SessionRunner._termination_payload(SimpleNamespace(values=None)) == {}
