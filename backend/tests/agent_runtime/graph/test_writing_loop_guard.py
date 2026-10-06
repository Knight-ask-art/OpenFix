import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent_runtime.graph.react_agent import (
    WRITING_LOOP_STOP_MARKER,
    WRITING_LOOP_STOP_NOTICE_KEY,
    WRITING_LOOP_TURN_START_KEY,
    _writing_loop_start,
    create_react_agent,
    is_writing_loop_stop_message,
    writing_loop_stop_notice,
)
from app.agent_runtime.graph.writing_loop_guard import writing_loop_stop_reason
from app.agent_runtime.persistence import MessagePersister, load_history
from app.agent_runtime.runner.session_runner import SessionRunner
from app.agent_runtime.runner.subagent_runner import _last_assistant_content
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


# ---------------------------------------------------------------------------
# 停止提示的可观测性（B4）与回合边界（B5）
# ---------------------------------------------------------------------------


def _notify_tool() -> StructuredTool:
    async def notify_subagent(dispatch_id: str, prompt: str) -> str:
        return json.dumps({"status": "queued", "dispatch_id": dispatch_id})

    return StructuredTool.from_function(
        coroutine=notify_subagent,
        name="notify_subagent",
        description="synthetic notify",
    )


def _notify_model(*, handoffs: int, calls: list[int], answer: str = "synthetic answer"):
    """假模型：先续派同一子智能体 ``handoffs`` 次，再给出最终答复。"""

    async def invoke(*_args, **_kwargs) -> AIMessage:
        calls.append(len(calls) + 1)
        if len(calls) > handoffs:
            return AIMessage(content=answer)
        return AIMessage(
            content="",
            tool_calls=[
                {
                    "id": f"n-{len(calls)}",
                    "name": "notify_subagent",
                    "args": {"dispatch_id": "child-a", "prompt": "synthetic followup"},
                }
            ],
        )

    return invoke


def _guarded_config(repetition_limit: int) -> ReactAgentConfig:
    return ReactAgentConfig(
        name="build",
        tools=[_notify_tool()],
        termination=TerminationCondition(mode="no_tool_call"),
        max_iterations=20,
        max_writing_repetitions=repetition_limit,
    )


async def _run_guarded_graph(
    *,
    config: ReactAgentConfig,
    messages: list[BaseMessage],
    model_calls: list[int],
    handoffs: int,
    runtime_context: dict | None = None,
    answer: str = "synthetic answer",
) -> dict:
    model = Mock()
    model.bind_tools.return_value = model
    runtime_configurable: dict = {}
    if runtime_context is not None:
        runtime_configurable["runtime_context"] = runtime_context
    with patch(
        "app.agent_runtime.graph.react_agent._invoke_model",
        side_effect=_notify_model(handoffs=handoffs, calls=model_calls, answer=answer),
    ):
        return await create_react_agent(config, model=model).ainvoke(
            {
                "messages": messages,
                "iteration_count": 0,
                "is_done": False,
                "final_output": None,
            },
            config={
                "recursion_limit": 100,
                "configurable": runtime_configurable,
            },
        )


@pytest.mark.asyncio
async def test_stop_notice_is_marked_and_published_for_the_runner():
    model_calls: list[int] = []
    runtime_context: dict = {}

    result = await _run_guarded_graph(
        config=_guarded_config(2),
        messages=[HumanMessage(content="synthetic instruction")],
        model_calls=model_calls,
        handoffs=2,
        runtime_context=runtime_context,
    )

    last = result["messages"][-1]
    assert is_writing_loop_stop_message(last) is True
    assert "停止继续自动往返" in result["final_output"]
    assert writing_loop_stop_notice(result["messages"]) == result["final_output"]
    # runner 依赖该共享 runtime_context 取回停止提示并补写用户可见消息
    assert runtime_context[WRITING_LOOP_STOP_NOTICE_KEY] == result["final_output"]
    # 正常工具调用与结果仍然成对保留，未被停止改写
    assert len([m for m in result["messages"] if isinstance(m, ToolMessage)]) == 2


@pytest.mark.asyncio
async def test_normal_answer_is_not_marked_as_a_stop_notice():
    model_calls: list[int] = []
    runtime_context: dict = {}

    result = await _run_guarded_graph(
        config=_guarded_config(6),
        messages=[HumanMessage(content="synthetic instruction")],
        model_calls=model_calls,
        handoffs=0,
        runtime_context=runtime_context,
        answer="synthetic final answer",
    )

    last = result["messages"][-1]
    assert last.content == "synthetic final answer"
    assert is_writing_loop_stop_message(last) is False
    assert writing_loop_stop_notice(result["messages"]) is None
    assert WRITING_LOOP_STOP_NOTICE_KEY not in runtime_context
    # 正常结束不写停止原因
    assert result.get("final_output") is None


@pytest.mark.asyncio
async def test_continuation_run_starts_from_a_fresh_quota():
    history = [
        HumanMessage(content="synthetic previous instruction"),
        *[message for i in range(6) for message in notify(i, "child-a")],
    ]
    model_calls: list[int] = []

    result = await _run_guarded_graph(
        config=_guarded_config(6),
        messages=history,
        model_calls=model_calls,
        handoffs=1,
        runtime_context={WRITING_LOOP_TURN_START_KEY: len(history)},
        answer="synthetic continued answer",
    )

    # 没有新 HumanMessage 的续跑轮次必须从新配额开始，而不是直接命中上一轮的计数
    assert len(model_calls) == 2
    assert result["messages"][-1].content == "synthetic continued answer"
    assert result.get("final_output") is None


def test_continuation_turn_start_overrides_checkpointed_previous_quota():
    """续跑显式边界必须覆盖 checkpoint 中上一轮保存的计数起点。"""
    state = {
        "messages": [HumanMessage(content="previous"), AIMessage(content="done")],
        "writing_loop_start": 0,
    }
    configurable = {
        "runtime_context": {WRITING_LOOP_TURN_START_KEY: len(state["messages"])}
    }

    assert _writing_loop_start(state, configurable) == len(state["messages"])


@pytest.mark.asyncio
async def test_history_without_a_turn_boundary_still_trips_the_guard():
    history = [
        HumanMessage(content="synthetic previous instruction"),
        *[message for i in range(6) for message in notify(i, "child-a")],
    ]
    model_calls: list[int] = []

    result = await _run_guarded_graph(
        config=_guarded_config(6),
        messages=history,
        model_calls=model_calls,
        handoffs=1,
    )

    assert model_calls == []
    assert result["is_done"] is True
    assert "停止继续自动往返" in result["final_output"]


def test_subagent_deliverable_ignores_a_stop_notice():
    stop = AIMessage(
        content="本轮已向同一子智能体续派 6 次，已停止继续自动往返，等待你的意见。",
        additional_kwargs={WRITING_LOOP_STOP_MARKER: True},
    )
    messages = [HumanMessage(content="synthetic instruction"), stop]
    # 停止提示不是交付物：不能成为 dispatch/notify 的 assistant_content
    assert _last_assistant_content(messages) is None
    assert writing_loop_stop_notice(messages) == stop.content
    # 正常答复仍照常作为交付物
    assert (
        _last_assistant_content(
            [HumanMessage(content="synthetic instruction"), AIMessage(content="draft")]
        )
        == "draft"
    )


def _fake_session_runner(session_id: str) -> SessionRunner:
    return SessionRunner(
        session_id=session_id,
        task_id=f"task_{session_id}",
        project_id="proj_loop_guard",
        model_config={
            "provider_type": "openai",
            "model_id": "gpt",
            "api_key": "k",
            "base_url": "",
            "max_context_tokens": 8000,
        },
    )


def _fake_state():
    return SimpleNamespace(next=(), tasks=(), values={}, config={"configurable": {}})


@pytest.mark.asyncio
@pytest.mark.parametrize("is_continuation", [False, True])
async def test_run_hands_each_round_a_new_writing_loop_quota(is_continuation):
    runner = _fake_session_runner(f"sess_loop_quota_{is_continuation}")
    history = [
        HumanMessage(content="synthetic previous instruction"),
        *[message for i in range(6) for message in notify(i, "child-a")],
    ]
    captured: dict = {}

    class _Graph:
        async def astream_events(self, initial_state, config=None, version=None):
            captured["config"] = config
            captured["initial_state"] = initial_state
            if False:
                yield None

        async def aget_state(self, *args, **kwargs):
            return _fake_state()

    fake_session = MagicMock(close=AsyncMock(), commit=AsyncMock())
    fake_persister = MagicMock(
        handle=AsyncMock(),
        mark_user_sent=AsyncMock(),
        finalize=AsyncMock(),
        persist_writing_loop_stop=AsyncMock(),
    )
    begin_turn = AsyncMock(
        return_value=(SimpleNamespace(id="msg_1"), SimpleNamespace(id="rev_1"))
    )
    with (
        patch.object(runner, "_get_graph", AsyncMock(return_value=_Graph())),
        patch.object(
            runner, "_prepare_run_persistence", AsyncMock(return_value=history)
        ),
        patch.object(
            runner, "_compile_user_message_content", AsyncMock(return_value="compiled")
        ),
        patch.object(runner, "_begin_user_turn", begin_turn),
        patch.object(runner, "_begin_existing_user_turn", begin_turn),
        patch(
            "app.agent_runtime.runner.session_runner.finalize_revision_status",
            AsyncMock(),
        ),
        patch("app.agent_runtime.runner.session_runner.emit", new=AsyncMock()),
        patch(
            "app.agent_runtime.runner.session_runner.create_session",
            AsyncMock(return_value=fake_session),
        ),
        patch.object(runner, "_make_persister", MagicMock(return_value=fake_persister)),
        patch.object(runner, "_prune_thread_checkpoints", AsyncMock()),
    ):
        await runner.run(
            user_request="synthetic instruction",
            user_message_id="msg_1" if is_continuation else None,
        )

    runtime_context = captured["config"]["configurable"]["runtime_context"]
    assert captured["initial_state"]["user_request"] == (
        "" if is_continuation else "compiled"
    )
    if is_continuation:
        # 续跑轮次没有新的 HumanMessage，必须显式给出本轮消息起点
        assert runtime_context[WRITING_LOOP_TURN_START_KEY] == len(history)
    else:
        # 普通轮次由追加的 HumanMessage 作为回合边界，不额外注入运行时状态
        assert WRITING_LOOP_TURN_START_KEY not in runtime_context


@pytest.mark.asyncio
async def test_run_persists_the_published_stop_notice():
    runner = _fake_session_runner("sess_loop_stop_publish")
    notice = "本轮已向同一子智能体续派 2 次，已停止继续自动往返，等待你的意见。"

    class _StopGraph:
        async def astream_events(self, initial_state, config=None, version=None):
            config["configurable"]["runtime_context"][WRITING_LOOP_STOP_NOTICE_KEY] = (
                notice
            )
            if False:
                yield None

        async def aget_state(self, *args, **kwargs):
            return _fake_state()

    fake_session = MagicMock(close=AsyncMock(), commit=AsyncMock())
    fake_persister = MagicMock(
        handle=AsyncMock(),
        mark_user_sent=AsyncMock(),
        finalize=AsyncMock(),
        persist_writing_loop_stop=AsyncMock(),
    )
    with (
        patch.object(runner, "_get_graph", AsyncMock(return_value=_StopGraph())),
        patch.object(runner, "_prepare_run_persistence", AsyncMock(return_value=[])),
        patch.object(
            runner, "_compile_user_message_content", AsyncMock(return_value="compiled")
        ),
        patch.object(
            runner,
            "_begin_user_turn",
            AsyncMock(
                return_value=(SimpleNamespace(id="msg_1"), SimpleNamespace(id="rev_1"))
            ),
        ),
        patch(
            "app.agent_runtime.runner.session_runner.finalize_revision_status",
            AsyncMock(),
        ),
        patch("app.agent_runtime.runner.session_runner.emit", new=AsyncMock()),
        patch(
            "app.agent_runtime.runner.session_runner.create_session",
            AsyncMock(return_value=fake_session),
        ),
        patch.object(runner, "_make_persister", MagicMock(return_value=fake_persister)),
        patch.object(runner, "_prune_thread_checkpoints", AsyncMock()),
    ):
        await runner.run(user_request="synthetic instruction")

    fake_persister.persist_writing_loop_stop.assert_awaited_once_with(notice)


@pytest.mark.asyncio
async def test_stop_notice_is_readable_from_session_history(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    persister = MessagePersister(
        session_id="sess_loop_stop_history",
        task_id="task_loop_stop_history",
        project_id="proj_loop_guard",
        db_session_factory=factory,
    )
    notice = "本轮连续 6 次相同目标范围测量仍未达标，已停止自动修订，等待你的意见。"

    await persister.persist_writing_loop_stop(notice)
    # 空通知不落库
    await persister.persist_writing_loop_stop("")

    async with factory() as session:
        history = await load_history(session, "sess_loop_stop_history")

    assert [message.content for message in history] == [notice]
    assert isinstance(history[0], AIMessage)
