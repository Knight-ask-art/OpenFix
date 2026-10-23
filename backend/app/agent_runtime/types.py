from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from langchain_core.tools import BaseTool

if TYPE_CHECKING:
    from app.agent_runtime.writing_contract import WritingContract

DEFAULT_AGENT_MAX_ITERATIONS = 1000
DEFAULT_AGENT_RECURSION_LIMIT = 1000

# Structured reason reported when the ReAct loop stops because its iteration
# budget was consumed instead of the model finishing on its own.
TERMINATION_REASON_MAX_ITERATIONS = "max_iterations"


def normalize_max_iterations(value: object) -> int | None:
    """Return a usable iteration cap, or None for legacy/unknown values.

    Request validation bounds the field to 1..DEFAULT_AGENT_MAX_ITERATIONS.
    Checkpoints written before this field existed have no value; those keep
    the legacy default and must not be rewritten to an arbitrary cap.
    """

    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 1 or value > DEFAULT_AGENT_MAX_ITERATIONS:
        return None
    return value


@dataclass
class TerminationCondition:
    mode: Literal["tool_success", "no_tool_call"]
    tool_name: str | None = None


@dataclass
class ReactAgentConfig:
    name: str
    tools: list[BaseTool]
    termination: TerminationCondition
    max_iterations: int = DEFAULT_AGENT_MAX_ITERATIONS
    # Zero disables this narrow safeguard for a deliberately extended workflow.
    max_writing_repetitions: int = 6
    # dispatch 传入的可选写作合同；None 时与本字段引入前的行为完全一致。
    writing_contract: WritingContract | None = None
