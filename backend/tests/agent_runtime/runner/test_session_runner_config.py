import asyncio
import weakref
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.agent_runtime.context import ContextBuildError
from app.agent_runtime.runner.run_registry import AgentRunRegistry
from app.agent_runtime.runner.session_runner import SessionRunner
from app.agent_runtime.tools.impls.orchestration.common import ensure_child_processing


def test_missing_max_context_tokens_raises() -> None:
    with pytest.raises(ContextBuildError) as exc:
        SessionRunner(
            session_id="s1",
            task_id="task_test",
            model_config={},
            project_id="p1",
        )
    assert exc.value.part == "config"


def test_zero_max_context_tokens_disables_context_compaction() -> None:
    runner = SessionRunner(
        session_id="s1",
        task_id="task_test",
        model_config={"max_context_tokens": 0},
        project_id="p1",
    )

    assert runner.model_config["max_context_tokens"] == 0


def test_valid_config_constructs_ok() -> None:
    runner = SessionRunner(
        session_id="s1",
        task_id="task_test",
        model_config={"max_context_tokens": 8000},
        project_id="p1",
    )
    assert runner.session_id == "s1"


def test_max_iterations_is_carried_into_runtime_config() -> None:
    runner = SessionRunner(
        session_id="s1",
        task_id="task_test",
        model_config={"max_context_tokens": 8000},
        project_id="p1",
        max_iterations=3,
    )

    config = runner._build_runtime_config(
        runtime_session=object(),  # type: ignore[arg-type]
        runtime_context={},
        audit_context=object(),  # type: ignore[arg-type]
    )

    assert runner.max_iterations == 3
    assert config["configurable"]["max_iterations"] == 3


def test_legacy_and_invalid_max_iterations_fall_back_to_default() -> None:
    legacy = SessionRunner(
        session_id="s1",
        task_id="task_test",
        model_config={"max_context_tokens": 8000},
        project_id="p1",
    )
    invalid = SessionRunner(
        session_id="s2",
        task_id="task_test",
        model_config={"max_context_tokens": 8000},
        project_id="p1",
        max_iterations=0,
    )

    # None means "no requested cap"; the orchestrator then uses its legacy
    # default instead of writing an arbitrary value into the checkpoint.
    assert legacy.max_iterations is None
    assert invalid.max_iterations is None


def test_termination_payload_reports_structured_stop_reason() -> None:
    state = SimpleNamespace(
        values={
            "termination_reason": "max_iterations",
            "max_iterations": 4,
        }
    )

    assert SessionRunner._termination_payload(state) == {
        "termination_reason": "max_iterations",
        "max_iterations": 4,
    }
    assert SessionRunner._termination_payload(
        SimpleNamespace(values={"max_iterations": 4})
    ) == {}


@pytest.mark.asyncio
async def test_resume_restores_persisted_max_iterations() -> None:
    runner = SessionRunner(
        session_id="s1",
        task_id="task_test",
        model_config={"max_context_tokens": 8000},
        project_id="p1",
    )
    fake_graph = SimpleNamespace(
        aget_state=AsyncMock(
            return_value=SimpleNamespace(
                values={"max_iterations": 7, "current_revision_id": None}
            )
        )
    )
    fake_session = MagicMock(close=AsyncMock())
    fake_registry = SimpleNamespace(is_cancelled=AsyncMock(return_value=True))

    with (
        patch.object(runner, "_get_graph", AsyncMock(return_value=fake_graph)),
        patch.object(runner, "_make_persister", MagicMock()),
        patch(
            "app.agent_runtime.runner.session_runner.create_session",
            AsyncMock(return_value=fake_session),
        ),
        patch(
            "app.agent_runtime.runner.session_runner.get_agent_run_registry",
            return_value=fake_registry,
        ),
    ):
        # The cancellation guard returns early, after the checkpoint values
        # (including the cap) have been restored onto the runner.
        await runner.resume({"action_type": "tool_approval", "approved": True})

    assert runner.max_iterations == 7
    fake_session.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_register_can_preserve_session_cancellation() -> None:
    registry = AgentRunRegistry()
    blocker = asyncio.Event()
    task = asyncio.create_task(blocker.wait())
    try:
        await registry.mark_cancelled("session-cancelled")
        await registry.register("session-cancelled", task, clear_cancelled=False)

        assert await registry.is_cancelled("session-cancelled") is True
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_session_locks_are_not_retained_after_use() -> None:
    registry = AgentRunRegistry()
    lock = registry.session_lock("finished-session")
    lock_ref = weakref.ref(lock)

    del lock

    assert lock_ref() is None
    assert "finished-session" not in registry._session_locks


@pytest.mark.asyncio
async def test_child_resume_does_not_clear_session_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = AgentRunRegistry()
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.orchestration.common.get_agent_run_registry",
        lambda: registry,
    )
    await registry.mark_cancelled("session-cancelled")

    class Runner:
        called = False

        async def resume(self, child_run_id: str, payload: dict) -> None:
            self.called = True

    runner = Runner()
    started = await ensure_child_processing(
        parent_session_id="session-cancelled",
        child_run_id="child-1",
        runner=runner,
        resume_payload={"approved": True},
        clear_cancelled=False,
    )

    assert started is False
    assert runner.called is False
    assert await registry.is_cancelled("session-cancelled") is True
    assert await registry.is_child_running("session-cancelled", "child-1") is False


@pytest.mark.asyncio
async def test_losing_child_start_does_not_unregister_winner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = AgentRunRegistry()
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.orchestration.common.get_agent_run_registry",
        lambda: registry,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.orchestration.common._clear_child_processing_failure",
        AsyncMock(),
    )

    registrations_ready = asyncio.Event()
    registration_count = 0
    original_try_register_child = registry.try_register_child

    async def synchronized_try_register_child(
        session_id: str,
        child_run_id: str,
        task: asyncio.Task[None],
        *,
        clear_cancelled: bool = True,
    ) -> bool:
        nonlocal registration_count
        registration_count += 1
        if registration_count == 2:
            registrations_ready.set()
        await registrations_ready.wait()
        return await original_try_register_child(
            session_id,
            child_run_id,
            task,
            clear_cancelled=clear_cancelled,
        )

    monkeypatch.setattr(registry, "try_register_child", synchronized_try_register_child)

    runner_started = asyncio.Event()
    release_runner = asyncio.Event()

    class Runner:
        async def run(self, child_run_id: str) -> None:
            runner_started.set()
            await release_runner.wait()

    runner = Runner()
    results = await asyncio.gather(
        ensure_child_processing(
            parent_session_id="session-race",
            child_run_id="child-race",
            runner=runner,
        ),
        ensure_child_processing(
            parent_session_id="session-race",
            child_run_id="child-race",
            runner=runner,
        ),
    )

    await asyncio.wait_for(runner_started.wait(), timeout=1)
    assert sorted(results) == [False, True]
    assert await registry.is_child_running("session-race", "child-race") is True

    release_runner.set()
    for _ in range(10):
        if not await registry.is_child_running("session-race", "child-race"):
            break
        await asyncio.sleep(0)
    assert await registry.is_child_running("session-race", "child-race") is False


@pytest.mark.asyncio
async def test_child_completion_continuation_preserves_session_cancellation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.agent_runtime.runner.subagent_runner import SubagentRunner

    ensure = AsyncMock()
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.orchestration.common.ensure_child_processing",
        ensure,
    )
    runner = SubagentRunner(
        session_factory=None,
        model_config={},
        project_id="p1",
    )
    monkeypatch.setattr(
        runner,
        "_load_child_run",
        AsyncMock(
            return_value=SimpleNamespace(
                is_active=True,
                status="queued",
            )
        ),
    )
    monkeypatch.setattr(runner, "_count_pending_requests", AsyncMock(return_value=1))

    await runner.on_child_processing_finished(
        parent_session_id="session-cancelled",
        child_run_id="child-1",
    )

    assert ensure.await_args is not None
    assert ensure.await_args.kwargs["clear_cancelled"] is False
