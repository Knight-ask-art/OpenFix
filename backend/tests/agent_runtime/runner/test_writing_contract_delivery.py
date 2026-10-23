"""Delivery-boundary tests with synthetic text and no database or provider."""

import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from app.agent_runtime.graph.react_agent import WRITING_LOOP_STOP_MARKER
from app.agent_runtime.runner.subagent_runner import SubagentRunner
from app.agent_runtime.writing_contract import WritingContract
from app.core.word_count import count_words


def measured(text):
    return [
        HumanMessage(content="synthetic request"),
        AIMessage(
            content="",
            tool_calls=[
                {"name": "measure_text", "id": "measure-1", "args": {"text": text}}
            ],
        ),
        ToolMessage(
            tool_call_id="measure-1",
            name="measure_text",
            content=json.dumps(
                {
                    "word_count": count_words(text),
                    "character_count": len(text),
                    "content_sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
            ),
        ),
    ]


async def run_delivery(
    messages, request_json=None, agent_key="writer", resume_payload=None
):
    runner = SubagentRunner(model_config={}, project_id="synthetic-project")
    row = SimpleNamespace(
        id="child",
        agent_key=agent_key,
        request_json=request_json or {},
        child_thread_id="synthetic-child",
        parent_task_id="task",
        parent_session_id="parent",
    )
    request = SimpleNamespace(
        id="request",
        content="synthetic request",
        parent_revision_id=None,
        request_kind="initial",
    )
    runner._load_agent_definition = AsyncMock(return_value=object())
    runner._load_history = AsyncMock(return_value=[])
    runner._build_runtime_state = AsyncMock(return_value={})
    runner._build_graph = AsyncMock(return_value=(object(), {}))
    runner._invoke_graph = AsyncMock(return_value={"messages": messages})
    runner._complete_request = AsyncMock(return_value=row)
    runner._publish_parent_subagent_status_row = AsyncMock()
    runner._mark_child_running = AsyncMock(return_value=row)
    result = await runner._run_request(row, request, resume_payload=resume_payload)
    return result, runner


CONTRACT = {
    "writing_contract": {"goal": "one complete synthetic candidate", "max_revisions": 1}
}


@pytest.mark.asyncio
async def test_contract_delivery_preserves_exact_whitespace():
    text = "  合成候选。\n\n"
    result, runner = await run_delivery(
        [*measured(text), AIMessage(content=text)], CONTRACT
    )
    assert result["assistant_content"] == text
    assert runner._complete_request.call_args.kwargs == {"assistant_content": text}


@pytest.mark.asyncio
@pytest.mark.parametrize("changed", ["合成候选。上", " 合成候选。", "合成候选。\n"])
async def test_changed_delivery_is_error_without_success_artifact(changed):
    result, runner = await run_delivery(
        [*measured("合成候选。"), AIMessage(content=changed)], CONTRACT
    )
    assert "delivery_text_mismatch" in result["error"]
    assert "assistant_content" not in runner._complete_request.call_args.kwargs


@pytest.mark.asyncio
async def test_missing_measurement_does_not_reuse_prior_artifact():
    messages = [
        *measured("旧候选"),
        HumanMessage(content="new request"),
        AIMessage(content="新候选"),
    ]
    result, runner = await run_delivery(messages, CONTRACT)
    assert "unmeasured" in result["error"]
    assert "assistant_content" not in runner._complete_request.call_args.kwargs


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "request_json,agent",
    [
        ({"writing_contract": None}, "writer"),
        ({"writing_contract": {"goal": "x", "max_revisions": "1"}}, "writer"),
        (CONTRACT, "reviewer"),
    ],
)
async def test_invalid_persisted_contract_fails_before_model(request_json, agent):
    result, runner = await run_delivery(
        [AIMessage(content="candidate")], request_json, agent
    )
    assert result == {"error": "invalid persisted writing_contract"}
    runner._build_graph.assert_not_called()
    assert "assistant_content" not in runner._complete_request.call_args.kwargs


@pytest.mark.asyncio
async def test_protective_stop_is_not_registered_as_delivery():
    stop = AIMessage(content="stop", additional_kwargs={WRITING_LOOP_STOP_MARKER: True})
    result, runner = await run_delivery(
        [AIMessage(content="old candidate"), stop], CONTRACT
    )
    assert "error" in result
    assert "assistant_content" not in runner._complete_request.call_args.kwargs


@pytest.mark.asyncio
async def test_legacy_delivery_remains_unmeasured_and_trimmed():
    result, _ = await run_delivery([AIMessage(content="  legacy answer  ")])
    assert result["assistant_content"] == "legacy answer"


@pytest.mark.asyncio
async def test_real_build_graph_reads_persisted_contract_into_agent_config(monkeypatch):
    from app.agent_runtime.runner import subagent_runner as module

    runner = SubagentRunner(
        model_config={"model_id": "synthetic"}, project_id="project"
    )
    tools = [object()]
    runner._build_tools = AsyncMock(return_value=tools)
    session, model, graph, checkpointer = object(), object(), object(), object()
    monkeypatch.setattr(module, "_open_session", AsyncMock(return_value=session))
    close = AsyncMock()
    monkeypatch.setattr(module, "_close_session", close)
    resolved = {"model_id": "synthetic-resolved"}
    monkeypatch.setattr(
        module, "_resolve_agent_model_config", AsyncMock(return_value=resolved)
    )
    monkeypatch.setattr(module, "to_client_model_config", lambda config: config)
    monkeypatch.setattr(module, "ModelConfig", lambda **kwargs: kwargs)
    monkeypatch.setattr(module, "create_chat_model", Mock(return_value=model))
    monkeypatch.setattr(
        module, "get_checkpointer", AsyncMock(return_value=checkpointer)
    )
    create_graph = Mock(return_value=graph)
    monkeypatch.setattr(module, "create_react_agent", create_graph)
    row = SimpleNamespace(agent_key="writer", request_json=CONTRACT)
    definition = SimpleNamespace(model_id=None, reasoning_effort=None)

    actual_graph, actual_config = await runner._build_graph(row, definition, {})

    assert actual_graph is graph
    assert actual_config == resolved
    config = create_graph.call_args.args[0]
    assert config.writing_contract == WritingContract.model_validate(
        CONTRACT["writing_contract"]
    )
    assert config.tools == tools
    assert config.name == "writer"
    assert create_graph.call_args.kwargs == {
        "model": model,
        "checkpointer": checkpointer,
    }
    close.assert_awaited_once_with(session)


@pytest.mark.asyncio
async def test_approval_resume_keeps_command_and_prior_measurement_budget():
    text = "合成候选。"
    messages = [HumanMessage(content="synthetic request")]
    for index in range(3):
        pair = measured(text)[1:]
        call_id = f"resume-measure-{index}"
        pair[0].tool_calls[0]["id"] = call_id
        pair[1].tool_call_id = call_id
        messages.extend(pair)
    messages.append(AIMessage(content=text))
    payload = {"approved": True}

    result, runner = await run_delivery(messages, CONTRACT, resume_payload=payload)

    graph_input = runner._invoke_graph.call_args.args[3]
    assert isinstance(graph_input, Command)
    assert graph_input.resume == payload
    assert graph_input.update is None
    assert "measurement_budget_exhausted" in result["error"]
    assert "assistant_content" not in runner._complete_request.call_args.kwargs
