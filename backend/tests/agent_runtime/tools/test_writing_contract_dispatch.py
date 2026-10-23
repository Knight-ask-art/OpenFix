"""Contract opt-in is persisted on existing dispatches without a new store."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.orchestration import dispatch_subagent as module
from app.agent_runtime.tools.impls.orchestration.dispatch_subagent import (
    DispatchSubagentTool,
)
from app.agent_runtime.writing_contract import WritingContract


@pytest.mark.asyncio
@pytest.mark.parametrize("agent", ["reviewer", "explore", "plan"])
async def test_contract_rejects_other_roles_before_dispatch(monkeypatch, agent):
    create = AsyncMock()
    validate = AsyncMock()
    monkeypatch.setattr(DispatchSubagentTool, "_create_child_run", create)
    monkeypatch.setattr(DispatchSubagentTool, "_validate_dispatch", validate)
    with pytest.raises(ToolExecutionError, match="writer/actor"):
        await DispatchSubagentTool()._execute(
            agent, "synthetic", "synthetic", writing_contract={"goal": "synthetic"}
        )
    create.assert_not_called()
    validate.assert_not_called()


@pytest.mark.asyncio
async def test_invalid_contract_rejected_before_child_creation(monkeypatch):
    create = AsyncMock()
    monkeypatch.setattr(DispatchSubagentTool, "_create_child_run", create)
    with pytest.raises(ToolExecutionError, match="invalid writing_contract"):
        await DispatchSubagentTool()._execute(
            "writer",
            "synthetic",
            "synthetic",
            writing_contract={"goal": "synthetic", "max_revisions": True},
        )
    create.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "agent,contract",
    [
        ("writer", None),
        (
            "writer",
            {"goal": "synthetic", "min_words": 2, "max_words": 8, "max_revisions": 0},
        ),
        ("actor", WritingContract(goal="synthetic", max_revisions=1)),
    ],
)
async def test_dispatch_persists_opt_in_without_altering_legacy_request(
    monkeypatch, agent, contract
):
    row = SimpleNamespace(
        id="child",
        child_thread_id="child-thread",
        dispatch_id="dispatch",
        metadata_json={},
        pending_approval_json=None,
    )
    create = AsyncMock(return_value=row)
    monkeypatch.setattr(DispatchSubagentTool, "_validate_dispatch", AsyncMock())
    monkeypatch.setattr(
        DispatchSubagentTool, "_load_waiting_child_run", AsyncMock(return_value=None)
    )
    build = AsyncMock(
        return_value=({"task": "synthetic", "description": "synthetic"}, None)
    )
    monkeypatch.setattr(DispatchSubagentTool, "_build_dispatch_request", build)
    monkeypatch.setattr(DispatchSubagentTool, "_create_child_run", create)
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_load_initial_request_id",
        AsyncMock(return_value="request"),
    )
    monkeypatch.setattr(
        DispatchSubagentTool,
        "_wait_for_assistant_content",
        AsyncMock(return_value="candidate"),
    )
    monkeypatch.setattr(
        DispatchSubagentTool, "_load_saved_chapter_writes", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        module, "latest_checkpoint_id_for_thread", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(
        module,
        "persist_child_user_message",
        AsyncMock(return_value=SimpleNamespace(id="message", seq=1)),
    )
    monkeypatch.setattr(module, "open_session", AsyncMock(return_value=object()))
    monkeypatch.setattr(module, "close_session", AsyncMock())
    monkeypatch.setattr(module, "update_child_run_request_boundaries", AsyncMock())
    monkeypatch.setattr(module, "emit_subagent_tool_preview", AsyncMock())
    monkeypatch.setattr(
        module,
        "make_subagent_runner",
        lambda **kwargs: SimpleNamespace(publish_parent_subagent_status=AsyncMock()),
    )
    tool = DispatchSubagentTool(
        _state={"session_id": "parent", "task_id": "task", "project_id": "project"}
    )
    result = json.loads(
        await tool._execute(agent, "synthetic", "synthetic", writing_contract=contract)
    )
    assert result["result"] == "candidate"
    request = create.call_args.kwargs["request"]
    if contract is None:
        assert request == {"task": "synthetic", "description": "synthetic"}
    else:
        expected = WritingContract.model_validate(contract).model_dump()
        assert request["writing_contract"] == expected
    assert build.call_args.kwargs == {
        "description": "synthetic",
        "prompt": "synthetic",
        "source_dispatch_ids": [],
        "configurable": {},
    }
