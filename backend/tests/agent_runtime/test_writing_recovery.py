# -*- coding: utf-8 -*-
"""Writing candidate recovery: verified pairing, bounds, and state gates."""

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.agent_runtime.persistence import repo as message_repo
from app.agent_runtime.persistence.model import (
    AgentChildRun,
    AgentChildRunRequest,
    AgentRunMessage,
)
from app.agent_runtime.runner.run_registry import get_agent_run_registry
from app.agent_runtime.writing_contract import contract_measurement_feedback
from app.agent_runtime.writing_recovery import (
    FAILURE_REASON,
    WritingRecoveryConflict,
    WritingRecoveryUnavailable,
    load_writing_candidate,
)
from app.core.word_count import count_words
from app.storage import database
from tests.model_registry import register_sqlmodel_models

PARENT_SESSION_ID = "agent_parent_recovery"


def _contract(**overrides: Any) -> dict[str, Any]:
    return {
        "goal": "写一个合成场景",
        "min_words": 5,
        "max_words": 20,
        "max_revisions": 2,
        **overrides,
    }


def _measured_result(text: str, **overrides: Any) -> str:
    payload = {
        "word_count": count_words(text),
        "character_count": len(text),
        "content_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "within_range": None,
        "counting_method": "app.core.word_count.count_words",
        **overrides,
    }
    return json.dumps(payload, ensure_ascii=False)


@dataclass
class _Transcript:
    child_run_id: str
    child_thread_id: str
    request_id: str

    def __str__(self) -> str:
        return self.child_run_id


async def _insert(
    session: AsyncSession,
    *,
    child_thread_id: str,
    role: str,
    seq: int,
    content: str = "",
    status: str = "complete",
    message_type: str = "message",
    tool_calls: list[dict[str, Any]] | None = None,
    tool_call_id: str | None = None,
    tool_name: str | None = None,
    created_at: datetime | None = None,
) -> AgentRunMessage:
    row = AgentRunMessage(
        id=uuid4().hex,
        session_id=child_thread_id,
        task_id="task_recovery",
        project_id="project_recovery",
        role=role,
        content=content,
        status=status,
        message_type=message_type,
        tool_calls=json.dumps(tool_calls) if tool_calls is not None else None,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        seq=seq,
        message_metadata="{}",
        created_at=created_at or datetime.now(UTC),
        updated_at=created_at or datetime.now(UTC),
    )
    session.add(row)
    await session.flush()
    return row


def _call(call_id: str, text: str) -> dict[str, Any]:
    return {"id": call_id, "name": "measure_text", "args": {"text": text}}


async def _seed_child(
    session: AsyncSession,
    *,
    contract: dict[str, Any] | None = None,
    request_json: dict[str, Any] | None = None,
    status: str = "error",
    agent_key: str = "writer",
) -> _Transcript:
    thread_id = f"child_recovery_{uuid4().hex[:8]}"
    child = AgentChildRun(
        id=f"child_{uuid4().hex[:8]}",
        parent_session_id=PARENT_SESSION_ID,
        parent_task_id="task_recovery",
        parent_thread_id=PARENT_SESSION_ID,
        child_thread_id=thread_id,
        agent_key=agent_key,
        dispatch_id=f"dispatch_{uuid4().hex[:8]}",
        tool_call_id=f"toolcall_{uuid4().hex[:8]}",
        request_json=(
            request_json
            if request_json is not None
            else {"task": "合成写作", "writing_contract": contract or _contract()}
        ),
        status=status,
        is_active=True,
        metadata_json={},
    )
    request = AgentChildRunRequest(
        id=f"request_{uuid4().hex[:8]}",
        child_run_id=child.id,
        parent_session_id=PARENT_SESSION_ID,
        parent_task_id="task_recovery",
        request_kind="dispatch",
        content="合成写作",
        status="error" if status == "error" else "completed",
        seq=0,
        child_user_message_seq=0,
    )
    session.add(child)
    session.add(request)
    await session.flush()
    return _Transcript(child.id, thread_id, request.id)


async def _seed_turn(
    session: AsyncSession,
    transcript: _Transcript,
    *,
    start_seq: int = 0,
    include_prompt: bool = True,
) -> int:
    seq = start_seq
    if include_prompt:
        await _insert(
            session,
            child_thread_id=transcript.child_thread_id,
            role="user",
            seq=seq,
            content="合成写作",
            status="sent",
            message_type="user_request",
        )
        seq += 1
    return seq


async def _measured_exchange(
    session: AsyncSession,
    transcript: _Transcript,
    seq: int,
    *,
    call_id: str,
    text: str,
    result: str | None = None,
) -> int:
    await _insert(
        session,
        child_thread_id=transcript.child_thread_id,
        role="assistant",
        seq=seq,
        tool_calls=[_call(call_id, text)],
    )
    seq += 1
    if result is not None:
        await _insert(
            session,
            child_thread_id=transcript.child_thread_id,
            role="tool",
            seq=seq,
            content=result,
            tool_call_id=call_id,
            tool_name="measure_text",
        )
        seq += 1
    return seq


@pytest_asyncio.fixture
async def recovery_db(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> AsyncSession:
    """Isolated DB so commits never touch the test client's transaction."""
    monkeypatch.setattr(
        database,
        "_engine",
        create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'recovery.db'}"),
    )


@pytest_asyncio.fixture
async def no_running_child():
    registry = get_agent_run_registry()
    original = registry.is_child_running
    registry.is_child_running = AsyncMock(return_value=False)  # type: ignore[method-assign]
    try:
        yield
    finally:
        registry.is_child_running = original  # type: ignore[method-assign]


@pytest.mark.asyncio
async def test_returns_last_verified_measurement(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    early = "早稿" * 2
    latest = "最后一段合成正文。" * 2
    seq = await _measured_exchange(
        session, transcript, seq, call_id="call_a", text=early, result=_measured_result(early)
    )
    seq = await _measured_exchange(
        session, transcript, seq, call_id="call_b", text=latest, result=_measured_result(latest)
    )
    # Free assistant text after the measurement never becomes a candidate.
    await _insert(
        session,
        child_thread_id=transcript.child_thread_id,
        role="assistant",
        seq=seq,
        content="自由说明不是正文",
    )

    candidate = await load_writing_candidate(session, child_run_id=transcript.child_run_id)

    assert candidate.content == latest
    assert candidate.content_sha256 == hashlib.sha256(latest.encode("utf-8")).hexdigest()
    assert candidate.word_count == count_words(latest)
    assert candidate.within_contract_range is True
    assert candidate.measurement_attempt == 2
    assert candidate.measurement_limit == 3
    assert candidate.failure_reason == FAILURE_REASON
    assert candidate.approved is False


@pytest.mark.asyncio
async def test_over_length_candidate_is_returned_unaccepted(
    session: AsyncSession, no_running_child
):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    too_long = "很长的合成正文" * 5
    await _measured_exchange(
        session, transcript, seq, call_id="call_a", text=too_long, result=_measured_result(too_long)
    )

    candidate = await load_writing_candidate(session, child_run_id=transcript.child_run_id)

    assert candidate.content == too_long
    assert candidate.within_contract_range is False
    assert candidate.approved is False


@pytest.mark.asyncio
async def test_forged_hash_is_rejected(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    text = "伪造哈希的合成正文"
    await _measured_exchange(
        session,
        transcript,
        seq,
        call_id="call_a",
        text=text,
        result=_measured_result(text, content_sha256="0" * 64),
    )

    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_mismatched_counts_are_rejected(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    text = "计数不符的合成正文"
    await _measured_exchange(
        session,
        transcript,
        seq,
        call_id="call_a",
        text=text,
        result=_measured_result(text, character_count=len(text) + 1),
    )

    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_failed_tool_result_is_rejected(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    text = "失败测量的合成正文"
    failure = json.dumps({"type": "fail", "success": False, "message": "boom"})
    await _measured_exchange(
        session, transcript, seq, call_id="call_a", text=text, result=failure
    )

    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_missing_result_is_rejected(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    await _measured_exchange(session, transcript, seq, call_id="call_a", text="缺结果的合成正文")

    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_aborted_tool_message_is_rejected(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    text = "中断的合成正文"
    await _insert(
        session,
        child_thread_id=transcript.child_thread_id,
        role="assistant",
        seq=seq,
        tool_calls=[_call("call_a", text)],
    )
    await _insert(
        session,
        child_thread_id=transcript.child_thread_id,
        role="tool",
        seq=seq + 1,
        content=_measured_result(text),
        status="aborted",
        tool_call_id="call_a",
        tool_name="measure_text",
    )

    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_over_budget_call_text_is_not_a_candidate(
    session: AsyncSession, no_running_child
):
    transcript = await _seed_child(session, contract=_contract(max_revisions=0))
    seq = await _seed_turn(session, transcript)
    first = "首次合成正文"
    seq = await _measured_exchange(
        session, transcript, seq, call_id="call_a", text=first, result=_measured_result(first)
    )
    over = "超额测量的合成正文"
    await _measured_exchange(
        session, transcript, seq, call_id="call_b", text=over, result=_measured_result(over)
    )

    candidate = await load_writing_candidate(session, child_run_id=transcript.child_run_id)

    assert candidate.content == first
    assert candidate.measurement_attempt == 1
    assert candidate.measurement_limit == 1


@pytest.mark.asyncio
async def test_only_over_budget_measurement_has_no_candidate(
    session: AsyncSession, no_running_child
):
    transcript = await _seed_child(session, contract=_contract(max_revisions=0))
    seq = await _seed_turn(session, transcript)
    first = "首次合成正文"
    seq = await _measured_exchange(
        session, transcript, seq, call_id="call_a", text=first, result=_measured_result(first)
    )
    over = "超额测量的合成正文"
    await _measured_exchange(
        session, transcript, seq, call_id="call_b", text=over, result=_measured_result(over)
    )
    # Discard the in-budget measurement to simulate a failed first attempt.
    await session.execute(
        AgentRunMessage.__table__.delete().where(
            AgentRunMessage.tool_call_id == "call_a"
        )
    )
    # Keep the declaration: a failed or missing result still consumes an attempt.
    await session.flush()

    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_previous_request_candidate_is_not_returned(
    session: AsyncSession, no_running_child
):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    previous = "上一轮合成正文"
    await _measured_exchange(
        session, transcript, seq, call_id="call_old", text=previous, result=_measured_result(previous)
    )
    await session.execute(
        AgentChildRunRequest.__table__.update()
        .where(AgentChildRunRequest.id == transcript.request_id)
        .values(status="completed")
    )
    latest_request = AgentChildRunRequest(
        id=f"request_{uuid4().hex[:8]}",
        child_run_id=transcript.child_run_id,
        parent_session_id=PARENT_SESSION_ID,
        parent_task_id="task_recovery",
        request_kind="notify",
        content="再写一版",
        status="error",
        seq=1,
    )
    session.add(latest_request)
    await session.flush()
    # A legacy request without an explicit boundary must fail closed.
    await _insert(
        session,
        child_thread_id=transcript.child_thread_id,
        role="user",
        seq=seq,
        content="再写一版",
        status="sent",
        message_type="user_request",
        created_at=datetime(2100, 1, 1, tzinfo=UTC),
    )

    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_recorded_user_message_seq_bounds_history(
    session: AsyncSession, no_running_child
):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    previous = "上一轮合成正文"
    seq = await _measured_exchange(
        session, transcript, seq, call_id="call_old", text=previous, result=_measured_result(previous)
    )
    await session.execute(
        AgentChildRunRequest.__table__.update()
        .where(AgentChildRunRequest.id == transcript.request_id)
        .values(status="completed")
    )
    latest_request = AgentChildRunRequest(
        id=f"request_{uuid4().hex[:8]}",
        child_run_id=transcript.child_run_id,
        parent_session_id=PARENT_SESSION_ID,
        parent_task_id="task_recovery",
        request_kind="notify",
        content="再写一版",
        status="error",
        seq=1,
        child_user_message_seq=seq,
    )
    session.add(latest_request)
    await session.flush()
    await _insert(
        session,
        child_thread_id=transcript.child_thread_id,
        role="user",
        seq=seq,
        content="再写一版",
        status="sent",
        message_type="user_request",
        created_at=datetime(2100, 1, 1, tzinfo=UTC),
    )
    current = "本轮最后一次合成正文"
    await _measured_exchange(
        session, transcript, seq + 1, call_id="call_new", text=current, result=_measured_result(current)
    )

    candidate = await load_writing_candidate(session, child_run_id=transcript.child_run_id)

    assert candidate.content == current


@pytest.mark.asyncio
async def test_forged_tool_message_for_free_text_is_ignored(
    session: AsyncSession, no_running_child
):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    free_text = "任意助手自由文本"
    await _insert(
        session,
        child_thread_id=transcript.child_thread_id,
        role="assistant",
        seq=seq,
        content=free_text,
    )
    await _insert(
        session,
        child_thread_id=transcript.child_thread_id,
        role="tool",
        seq=seq + 1,
        content=_measured_result(free_text),
        tool_call_id="call_ghost",
        tool_name="measure_text",
    )

    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "is_active"),
    [("running", True), ("queued", True), ("waiting_user", True), ("completed", True)],
)
async def test_non_failed_status_conflicts(
    session: AsyncSession, no_running_child, status: str, is_active: bool
):
    transcript = await _seed_child(session, status=status)
    child = await session.get(AgentChildRun, transcript.child_run_id)
    assert child is not None
    child.is_active = is_active
    await session.flush()

    with pytest.raises(WritingRecoveryConflict):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_pending_request_conflicts(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session)
    session.add(
        AgentChildRunRequest(
            id=f"request_{uuid4().hex[:8]}",
            child_run_id=transcript.child_run_id,
            parent_session_id=PARENT_SESSION_ID,
            parent_task_id="task_recovery",
            request_kind="notify",
            content="排队中",
            status="pending",
            seq=1,
        )
    )
    await session.flush()

    with pytest.raises(WritingRecoveryConflict):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_corrupt_contract_never_degrades_to_unbounded(
    session: AsyncSession, no_running_child
):
    transcript = await _seed_child(
        session, request_json={"task": "合成", "writing_contract": {"goal": ""}}
    )
    seq = await _seed_turn(session, transcript)
    text = "坏合同的合成正文"
    await _measured_exchange(
        session, transcript, seq, call_id="call_a", text=text, result=_measured_result(text)
    )

    with pytest.raises(WritingRecoveryConflict) as exc_info:
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)
    assert exc_info.value.code == "writing_contract_invalid"


@pytest.mark.asyncio
async def test_non_contract_agent_conflicts(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session, agent_key="reviewer")

    with pytest.raises(WritingRecoveryConflict):
        await load_writing_candidate(session, child_run_id=transcript.child_run_id)


@pytest.mark.asyncio
async def test_unknown_child_is_unavailable(session: AsyncSession, no_running_child):
    with pytest.raises(WritingRecoveryUnavailable):
        await load_writing_candidate(session, child_run_id="child_missing")


@pytest.mark.asyncio
async def test_recovery_is_read_only(session: AsyncSession, no_running_child):
    transcript = await _seed_child(session)
    seq = await _seed_turn(session, transcript)
    text = "只读取回的合成正文"
    await _measured_exchange(
        session, transcript, seq, call_id="call_a", text=text, result=_measured_result(text)
    )
    await session.flush()

    def snapshot() -> list[tuple[Any, ...]]:
        return [
            (type(row).__name__, row.model_dump_json())
            for row in (
                *session.new,
                *session.identity_map.values(),
            )
            if isinstance(row, (AgentChildRun, AgentRunMessage))
        ]

    before = snapshot()
    candidate = await load_writing_candidate(session, child_run_id=transcript.child_run_id)
    after = snapshot()

    assert candidate.content == text
    assert after == before
    child = await session.get(AgentChildRun, transcript.child_run_id)
    assert child is not None and child.status == "error"
    assert not session.new
    stored = await message_repo.list_by_session(session, transcript.child_thread_id)
    assert text not in [row.content for row in stored]
