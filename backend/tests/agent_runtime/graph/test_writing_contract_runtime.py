"""Exercise the real ReAct graph with deterministic synthetic tools."""

import json
from unittest.mock import Mock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool

from app.agent_runtime.graph.react_agent import (
    create_react_agent,
    is_writing_loop_stop_message,
)
from app.agent_runtime.types import ReactAgentConfig, TerminationCondition
from app.agent_runtime.writing_contract import WritingContract


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
