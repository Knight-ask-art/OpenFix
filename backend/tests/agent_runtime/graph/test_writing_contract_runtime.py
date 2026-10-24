"""Exercise the real ReAct graph with deterministic synthetic tools."""

import json
from unittest.mock import Mock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.tools import StructuredTool
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent_runtime.graph.react_agent import (
    create_react_agent,
    is_writing_loop_stop_message,
)
from app.agent_runtime.types import ReactAgentConfig, TerminationCondition
from app.agent_runtime.writing_contract import WritingContract
from app.agent_runtime.tools.impls.chapter.measure_text import MeasureTextTool
from app.agent_runtime.persistence import MessagePersister, load_history


@pytest.mark.asyncio
@pytest.mark.parametrize("contracted", [True, False])
async def test_parallel_measurements_respect_contract_and_keep_tool_pairs(contracted):
    executions = []
    model_calls = []

    async def measure_text(text: str, series: str = "first") -> str:
        executions.append((text, series))
        return json.dumps({"within_range": True, "word_count": 1})

    tool = StructuredTool.from_function(
        coroutine=measure_text, name="measure_text", description="synthetic"
    )
    model = Mock()
    model.bind_tools.return_value = model

    async def invoke(*_args, **_kwargs):
        model_calls.append(1)
        if len(model_calls) > 1:
            return AIMessage(content="legacy completion")
        return AIMessage(
            content="",
            tool_calls=[
                {
                    "id": f"measure-{i}",
                    "name": "measure_text",
                    "args": {"text": "合成", "series": str(i)},
                }
                for i in range(4)
            ],
        )

    config = ReactAgentConfig(
        name="writer",
        tools=[tool],
        max_iterations=20,
        termination=TerminationCondition(mode="no_tool_call"),
        writing_contract=WritingContract(goal="synthetic", max_revisions=1)
        if contracted
        else None,
    )
    with patch("app.agent_runtime.graph.react_agent._invoke_model", side_effect=invoke):
        result = await create_react_agent(config, model=model).ainvoke(
            {
                "messages": [HumanMessage(content="synthetic task")],
                "iteration_count": 0,
                "is_done": False,
                "final_output": None,
            },
            config={"recursion_limit": 100},
        )
    results = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert {m.tool_call_id for m in results} == {f"measure-{i}" for i in range(4)}
    assert len(results) == 4
    assert len(executions) == (2 if contracted else 4)
    assert len(model_calls) == (1 if contracted else 2)
    assert is_writing_loop_stop_message(result["messages"][-1]) is contracted
    if contracted:
        assert sum("limit_exceeded" in str(m.content) for m in results) == 2


@pytest.mark.asyncio
async def test_success_and_changed_series_do_not_reset_contract_budget():
    executions = []
    model_calls = []

    async def measure_text(text: str, series: str) -> str:
        executions.append(series)
        return json.dumps({"within_range": True, "word_count": 1})

    tool = StructuredTool.from_function(
        coroutine=measure_text, name="measure_text", description="synthetic"
    )
    model = Mock()
    model.bind_tools.return_value = model

    async def invoke(*_args, **_kwargs):
        model_calls.append(1)
        index = len(model_calls)
        assert index <= 3, "graph must stop before a fourth model call"
        return AIMessage(
            content="",
            tool_calls=[
                {
                    "id": f"m-{index}",
                    "name": "measure_text",
                    "args": {"text": "合成", "series": f"changed-{index}"},
                }
            ],
        )

    config = ReactAgentConfig(
        name="writer",
        tools=[tool],
        max_iterations=20,
        termination=TerminationCondition(mode="no_tool_call"),
        writing_contract=WritingContract(goal="synthetic", max_revisions=1),
    )
    with patch("app.agent_runtime.graph.react_agent._invoke_model", side_effect=invoke):
        result = await create_react_agent(config, model=model).ainvoke(
            {
                "messages": [HumanMessage(content="synthetic task")],
                "iteration_count": 0,
                "is_done": False,
                "final_output": None,
            },
            config={"recursion_limit": 100},
        )
    assert executions == ["changed-1", "changed-2"]
    assert len(model_calls) == 3
    assert len([m for m in result["messages"] if isinstance(m, ToolMessage)]) == 3
    assert is_writing_loop_stop_message(result["messages"][-1])


@pytest.mark.parametrize("claimed_bounds", [{}, {"min_words": 0, "max_words": 1000}])
async def test_real_measurement_uses_trusted_bounds_and_remaining_budget(claimed_bounds):
    model = Mock()
    model.bind_tools.return_value = model
    calls = []

    async def invoke(_model, messages, **_kwargs):
        calls.append(1)
        if len(calls) == 1:
            return AIMessage(content="", tool_calls=[{
                "id": "measure", "name": "measure_text",
                "args": {"text": "山风起", **claimed_bounds},
            }])
        return AIMessage(content="山风起")

    config = ReactAgentConfig(
        name="writer", tools=[MeasureTextTool(_state={})], max_iterations=4,
        termination=TerminationCondition(mode="no_tool_call"),
        writing_contract=WritingContract(goal="synthetic", min_words=5, max_words=7, max_revisions=1),
    )
    with patch("app.agent_runtime.graph.react_agent._invoke_model", side_effect=invoke):
        result = await create_react_agent(config, model=model).ainvoke({
            "messages": [HumanMessage(content="synthetic")], "iteration_count": 0,
            "is_done": False, "final_output": None,
        }, config={"recursion_limit": 30})
    payload = json.loads(next(m.content for m in result["messages"] if isinstance(m, ToolMessage)))
    assert payload["range"] == {"min_words": 5, "max_words": 7}
    assert payload["within_range"] is False
    assert payload["writing_budget"]["remaining_measurements"] == 1
    assert payload["writing_budget"]["next_action"] == "revise_complete_candidate"


class _ContractEventModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


@pytest.mark.parametrize("max_revisions", [None, 0, 1])
async def test_real_tool_events_graph_and_persisted_history_share_budget_payload(
    db_engine, max_revisions
):
    """Real model/tool callbacks must expose the exact graph measurement payload."""
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    session_id = f"contract-events-{max_revisions}"
    persister = MessagePersister(
        session_id=session_id,
        task_id=f"task-{session_id}",
        project_id="synthetic-contract-project",
        db_session_factory=factory,
    )
    count = 2 if max_revisions == 1 else 1
    calls = [
        {
            "id": f"event-measure-{index}",
            "name": "measure_text",
            "args": {"text": "山风起。", "min_words": 0, "max_words": 100},
        }
        for index in range(count)
    ]
    model = _ContractEventModel(responses=[
        AIMessage(content="", tool_calls=calls),
        AIMessage(content="山风起。"),
    ])
    contract = (
        None if max_revisions is None else WritingContract(
            goal="synthetic", min_words=5, max_words=7, max_revisions=max_revisions
        )
    )
    graph = create_react_agent(ReactAgentConfig(
        name="writer", tools=[MeasureTextTool(_state={})], max_iterations=4,
        termination=TerminationCondition(mode="no_tool_call"),
        writing_contract=contract,
    ), model=model)
    tool_events = {}
    final_state = None
    async for event in graph.astream_events({
        "messages": [HumanMessage(content="synthetic task")],
        "iteration_count": 0, "is_done": False, "final_output": None,
    }, config={"recursion_limit": 40}, version="v2"):
        await persister.handle(event)
        if event["event"] == "on_tool_end" and event["name"] == "measure_text":
            tool_events[event["metadata"]["tool_call_id"]] = event["data"]["output"]
        if event["event"] == "on_chain_end":
            output = event.get("data", {}).get("output")
            if isinstance(output, dict) and "messages" in output:
                final_state = output
    await persister.finalize(reason="done")
    assert final_state is not None
    graph_payloads = {
        message.tool_call_id: message.content
        for message in final_state["messages"] if isinstance(message, ToolMessage)
    }
    assert len(tool_events) == count
    assert graph_payloads == tool_events
    async with factory() as session:
        history = await load_history(session, session_id)
    persisted_payloads = {
        message.tool_call_id: message.content
        for message in history if isinstance(message, ToolMessage)
    }
    assert persisted_payloads == graph_payloads
    for index, call in enumerate(calls, start=1):
        payload = json.loads(tool_events[call["id"]])
        if contract is None:
            assert "writing_budget" not in payload
            assert payload["range"] == {"min_words": 0, "max_words": 100}
        else:
            assert payload["range"] == {"min_words": 5, "max_words": 7}
            assert payload["within_range"] is False
            assert payload["writing_budget"] == {
                "attempt": index,
                "measurement_limit": count,
                "remaining_measurements": count - index,
                "next_action": (
                    "stop_and_retain_candidate" if index == count
                    else "revise_complete_candidate"
                ),
            }
