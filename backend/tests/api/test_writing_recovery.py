from unittest.mock import AsyncMock

import pytest

from app.agent_runtime.writing_recovery import (
    WritingCandidate, WritingRecoveryConflict, WritingRecoveryUnavailable,
)


async def test_writing_recovery_route_preserves_unaccepted_status(client, monkeypatch):
    candidate = WritingCandidate("child", "合成稿", "a" * 64, 3, False, 2, 3)
    load = AsyncMock(return_value=candidate)
    monkeypatch.setattr("app.api.routers.agent_runtime.load_writing_candidate", load)
    response = await client.get("/api/v1/agent/subagents/child/writing-candidate")
    assert response.status_code == 200
    data = response.json()
    assert data["approved"] is False
    assert data["within_contract_range"] is False
    assert data["content"] == "合成稿"
    assert data["measurement_attempt"] == 2
    assert data["failure_reason"] == "writing_request_failed"


@pytest.mark.parametrize("exception, expected", [
    (WritingRecoveryUnavailable("not found"), 404),
    (WritingRecoveryConflict("child_run_running", "still running"), 409),
])
async def test_writing_recovery_route_maps_unavailable_states(client, monkeypatch, exception, expected):
    monkeypatch.setattr(
        "app.api.routers.agent_runtime.load_writing_candidate", AsyncMock(side_effect=exception),
    )
    response = await client.get("/api/v1/agent/subagents/child/writing-candidate")
    assert response.status_code == expected
