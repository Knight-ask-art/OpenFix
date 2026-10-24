"""On-demand read of a retained, verified writing candidate for a failed child run.

The candidate is never stored: it is rebuilt from the persisted measure_text
tool call of the latest child request and the tool result paired to it.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Literal

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.agent_runtime.persistence import repo as message_repo
from app.agent_runtime.persistence.child_runs import count_pending_child_run_requests
from app.agent_runtime.persistence.model import (
    AgentChildRun,
    AgentChildRunRequest,
)
from app.agent_runtime.persistence.types import PersistedMessage
from app.agent_runtime.runner.run_registry import get_agent_run_registry
from app.agent_runtime.writing_contract import (
    CONTRACT_AGENT_KEYS,
    WritingContract,
    contract_from_request_json,
    current_turn,
    measurement_ordinals,
    verified_measurement_text,
)
from app.core.word_count import count_words

FAILURE_REASON = "writing_request_failed"
# Message statuses that cannot carry an executed, successful tool result.
_UNEXECUTED_MESSAGE_STATUSES = frozenset({"aborted", "pending"})


class WritingRecoveryUnavailable(Exception):
    """The child run has no retrievable verified candidate (mapped to 404)."""


class WritingRecoveryConflict(Exception):
    """The child run is not a finished failed contract run (mapped to 409)."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class WritingCandidate:
    child_run_id: str
    content: str
    content_sha256: str
    word_count: int
    within_contract_range: bool
    measurement_attempt: int
    measurement_limit: int
    failure_reason: str = FAILURE_REASON
    approved: Literal[False] = False


def _to_base_message(row: PersistedMessage) -> BaseMessage:
    tool_calls = [
        call
        for call in (row.tool_calls or [])
        if isinstance(call, dict) and isinstance(call.get("name"), str)
    ]
    if row.role == "user":
        return HumanMessage(content=row.content)
    if row.role == "assistant":
        return AIMessage(content=row.content, tool_calls=tool_calls)
    if row.role == "tool":
        return ToolMessage(
            content=row.content,
            tool_call_id=row.tool_call_id or "",
            name=row.tool_name or "",
            status="error" if row.status == "aborted" else "success",
        )
    return SystemMessage(content=row.content)


def _is_tool_result_row(row: PersistedMessage) -> bool:
    return (
        row.role == "tool"
        and row.message_type == "message"
        and row.status not in _UNEXECUTED_MESSAGE_STATUSES
    )


def _latest_verified_candidate(
    messages: list[BaseMessage],
    contract: WritingContract,
) -> tuple[str, int] | None:
    """Last in-budget measure_text call whose result proves the exact text.

    Attempts are counted in tool-call declaration order; only calls at or below
    the contract limit can contribute, and each needs its own successful
    measure_text result after the call.
    """
    ids = [call.get("id") for m in current_turn(messages) if isinstance(m, AIMessage)
           for call in m.tool_calls if call["name"] == "measure_text"]
    if any(not value for value in ids) or len(ids) != len(set(ids)):
        return None
    ordinals = measurement_ordinals(messages)
    turn = current_turn(messages)
    candidate: tuple[str, int] | None = None
    for index, message in enumerate(turn):
        if not isinstance(message, AIMessage):
            continue
        for call in message.tool_calls:
            call_id = str(call.get("id") or "")
            ordinal = ordinals.get(call_id)
            if call["name"] != "measure_text" or ordinal is None:
                continue
            if ordinal > contract.measurement_limit:
                continue
            result: ToolMessage | None = None
            for later in turn[index + 1 :]:
                if isinstance(later, HumanMessage):
                    break
                if isinstance(later, ToolMessage) and later.tool_call_id == call_id:
                    if later.name not in ("", "measure_text"):
                        continue
                    result = later
                    break
            if result is None or result.status == "error":
                continue
            text = verified_measurement_text(call, result.content)
            if text is not None:
                candidate = (text, ordinal)
    return candidate


async def load_writing_candidate(
    session: AsyncSession,
    *,
    child_run_id: str,
) -> WritingCandidate:
    row = await session.get(AgentChildRun, child_run_id)
    if row is None:
        raise WritingRecoveryUnavailable("子运行不存在")
    try:
        contract = contract_from_request_json(row.request_json)
    except ValueError:
        raise WritingRecoveryConflict(
            "writing_contract_invalid", "子代理写作合同无效，拒绝取回候选",
        ) from None
    if contract is None or row.agent_key not in CONTRACT_AGENT_KEYS:
        raise WritingRecoveryConflict(
            "writing_recovery_unsupported", "该子代理运行没有写作合同",
        )

    registry = get_agent_run_registry()
    if await registry.is_child_running(
        row.parent_session_id, row.id
    ):
        raise WritingRecoveryConflict("child_run_running", "子代理仍在运行")
    latest_result = await session.execute(
        select(AgentChildRunRequest)
        .where(col(AgentChildRunRequest.child_run_id) == row.id)
        .order_by(col(AgentChildRunRequest.seq).desc())
        .limit(1)
    )
    latest_request = latest_result.scalar_one_or_none()
    if (
        row.status != "error"
        or row.pending_approval_id is not None
        or await count_pending_child_run_requests(session, row.id) > 0
        or latest_request is None
        or latest_request.status != "error"
    ):
        raise WritingRecoveryConflict(
            "child_run_not_recoverable",
            "子代理未以失败的写作合同请求结束",
        )

    rows = await message_repo.list_by_session(session, row.child_thread_id)
    boundary = latest_request.child_user_message_seq
    if boundary is None or not any(r.seq == boundary and r.role == "user" for r in rows):
        raise WritingRecoveryUnavailable("缺少当前请求的明确边界")
    try:
        messages = [
            _to_base_message(message)
            for message in rows
            if (message.message_type == "message" or message.role == "user")
            and message.seq >= boundary
            and (message.role != "tool" or _is_tool_result_row(message))
        ]
        found = _latest_verified_candidate(messages, contract)
    except (ValueError, TypeError):
        raise WritingRecoveryUnavailable("测量历史无法验证") from None
    if found is None:
        raise WritingRecoveryUnavailable("没有可验证的保留测量稿")
    content, ordinal = found
    word_count = count_words(content)
    return WritingCandidate(
        child_run_id=row.id,
        content=content,
        content_sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
        word_count=word_count,
        within_contract_range=contract.in_range(word_count),
        measurement_attempt=ordinal,
        measurement_limit=contract.measurement_limit,
    )
