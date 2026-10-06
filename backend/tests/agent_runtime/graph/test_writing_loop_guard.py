import json
from unittest.mock import Mock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool

from app.agent_runtime.graph.react_agent import create_react_agent
from app.agent_runtime.graph.writing_loop_guard import writing_loop_stop_reason
from app.agent_runtime.types import ReactAgentConfig, TerminationCondition


def measurement(index, *, within=False, low=2800, high=3200):
    call_id = f"measure-{index}"
    return [
        AIMessage(
            content="",
            tool_calls=[
                {"id": call_id, "name": "measure_text", "args": {"text": "synthetic"}}
            ],
        ),
        ToolMessage(
            tool_call_id=call_id,
            name="measure_text",
            content=json.dumps(
                {
                    "word_count": 4000,
                    "within_range": within,
                    "range": {"min_words": low, "max_words": high}
                    if within is not None
                    else None,
                }
            ),
        ),
    ]


def failed_measurements(count):
    return [message for i in range(count) for message in measurement(i)]


def test_six_completed_failed_measurements_stop_without_changing_history():
    messages = failed_measurements(6)
    original = list(messages)
    assert writing_loop_stop_reason(messages) is not None
    assert messages == original
    assert writing_loop_stop_reason(messages[:-1]) is None
    assert writing_loop_stop_reason(messages, limit=7) is None
    assert writing_loop_stop_reason(failed_measurements(2), limit=2) is not None


@pytest.mark.parametrize(
    "reset",
    [
        HumanMessage(content="a new deliberate instruction"),
        *measurement(20, within=True),
    ],
)
def test_new_user_or_success_breaks_failure_streak(reset):
    # A lone successful tool result without its call is not authoritative.
    middle = (
        [reset] if isinstance(reset, HumanMessage) else measurement(20, within=True)
    )
    assert (
        writing_loop_stop_reason([*failed_measurements(5), *middle, *measurement(30)])
        is None
    )


def test_changed_ranges_and_unbounded_batch_audits_do_not_stop():
    changed = [*failed_measurements(5), *measurement(8, low=100, high=200)]
    assert writing_loop_stop_reason(changed) is None
    unbounded = [message for i in range(20) for message in measurement(i, within=None)]
    assert writing_loop_stop_reason(unbounded) is None


def notify(index, dispatch_id):
    call_id = f"notify-{index}"
    return [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": call_id,
                    "name": "notify_subagent",
                    "args": {
                        "dispatch_id": dispatch_id,
                        "prompt": "synthetic followup",
                    },
                }
            ],
        ),
        ToolMessage(tool_call_id=call_id, name="notify_subagent", content="done"),
    ]


def test_notifications_are_bounded_per_child_and_new_user_resets():
    independent = [message for i in range(12) for message in notify(i, f"child-{i}")]
    assert writing_loop_stop_reason(independent) is None
    same = [message for i in range(6) for message in notify(i, "child-a")]
    assert writing_loop_stop_reason(same) is not None
    assert (
        writing_loop_stop_reason(
            [*same, HumanMessage(content="continue"), *notify(7, "child-a")]
        )
        is None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("repetition_limit", [6, 2, 0])
async def test_graph_stops_after_results_or_respects_explicit_opt_out(repetition_limit):
    async def measure_text(text: str) -> str:
        return json.dumps(
            {
                "word_count": 4000,
                "within_range": False,
                "range": {"min_words": 2800, "max_words": 3200},
            }
        )

    tool = StructuredTool.from_function(
        coroutine=measure_text, name="measure_text", description="synthetic count"
    )
    model = Mock()
    model.bind_tools.return_value = model
    calls = 0

    async def invoke(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 8:
            return AIMessage(content="deliberate extended workflow completed")
        return AIMessage(
            content="",
            tool_calls=[
                {
                    "id": f"m-{calls}",
                    "name": "measure_text",
                    "args": {"text": "synthetic candidate"},
                }
            ],
        )

    config = ReactAgentConfig(
        name="writer",
        tools=[tool],
        termination=TerminationCondition(mode="no_tool_call"),
        max_iterations=50,
        max_writing_repetitions=repetition_limit,
    )
    with patch("app.agent_runtime.graph.react_agent._invoke_model", side_effect=invoke):
        result = await create_react_agent(config, model=model).ainvoke(
            {
                "messages": [HumanMessage(content="write a bounded candidate")],
                "iteration_count": 0,
                "is_done": False,
                "final_output": None,
            },
            config={"recursion_limit": 100},
        )
    assert calls == (repetition_limit or 8)
    assert result["is_done"] is True
    if repetition_limit:
        assert "停止自动修订" in result["final_output"]
    else:
        assert (
            result["messages"][-1].content == "deliberate extended workflow completed"
        )
    assert len([m for m in result["messages"] if isinstance(m, ToolMessage)]) == (
        repetition_limit or 7
    )
    assert len(
        [m for m in result["messages"] if isinstance(m, AIMessage) and m.tool_calls]
    ) == (repetition_limit or 7)
    assert not result["messages"][-1].tool_calls
