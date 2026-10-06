import httpx
import pytest

from app.agent_runtime.runner.session_runner import SessionRunner


@pytest.mark.parametrize("error_type", [httpx.ReadError, httpx.ConnectError, httpx.ReadTimeout])
def test_transport_error_has_actionable_reason_without_provider_payload(error_type):
    error = error_type("private request details")
    reason = SessionRunner._exception_reason(error)
    assert "模型连接" in reason
    assert "重试" in reason
    assert "自动获批" in reason
    assert "private request details" not in reason


def test_wrapped_transport_error_is_recognized():
    outer = RuntimeError("provider failed")
    outer.__cause__ = httpx.ReadError("")
    assert "模型连接" in SessionRunner._exception_reason(outer)


def test_nontransport_errors_retain_existing_reason():
    assert SessionRunner._exception_reason(ValueError("invalid state")) == "invalid state"
    assert SessionRunner._exception_reason(ValueError()) == "ValueError"


def test_exception_chain_cycle_terminates():
    error = ValueError("cycle")
    error.__cause__ = error
    assert SessionRunner._exception_reason(error) == "cycle"
