"""Opt-in constraints for one complete writing deliverable per child request.

Uses persisted request JSON and existing tool history, never natural-language
budget parsing, manuscript mutation, or a second candidate store.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Self

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.word_count import count_words

CONTRACT_AGENT_KEYS = frozenset({"writer", "actor"})


class WritingContract(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: str = Field(
        min_length=1, max_length=200, description="本轮唯一完整候选的写作目标"
    )
    min_words: int | None = Field(
        default=None,
        strict=True,
        ge=0,
        description="作者指定的完整候选字数下限；未指定时省略",
    )
    max_words: int | None = Field(
        default=None,
        strict=True,
        ge=0,
        description="作者指定的完整候选字数上限；未指定时省略",
    )
    max_revisions: int = Field(
        default=2,
        strict=True,
        ge=0,
        le=10,
        description="首测之后允许的修订测量次数；0表示仅一次首测，不按达标或系列重置",
    )

    @model_validator(mode="after")
    def validate_range(self) -> Self:
        if not self.goal.strip():
            raise ValueError("goal must not be blank")
        if self.min_words is not None and self.max_words is not None:
            if self.min_words > self.max_words:
                raise ValueError("max_words must not be smaller than min_words")
        return self

    @property
    def measurement_limit(self) -> int:
        return 1 + self.max_revisions

    def in_range(self, value: int) -> bool:
        return (self.min_words is None or value >= self.min_words) and (
            self.max_words is None or value <= self.max_words
        )


def contract_from_request_json(value: object) -> WritingContract | None:
    if not isinstance(value, Mapping):
        raise ValueError("child request must be a JSON object")
    if "writing_contract" not in value:
        return None
    # A present but corrupt contract must never silently become an unbounded run.
    return WritingContract.model_validate(value.get("writing_contract"))


def current_turn(messages: Sequence[BaseMessage]) -> Sequence[BaseMessage]:
    for index in range(len(messages) - 1, -1, -1):
        if isinstance(messages[index], HumanMessage):
            return messages[index + 1 :]
    return messages


def measurement_ordinals(messages: Sequence[BaseMessage]) -> dict[str, int]:
    """Count every attempt in declaration order, including errors and parallel calls."""
    result: dict[str, int] = {}
    ordinal = 0
    for message in current_turn(messages):
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                if call["name"] == "measure_text":
                    ordinal += 1
                    result[str(call.get("id") or f"missing-id-{ordinal}")] = ordinal
    return result


def contract_budget_exceeded(
    messages: Sequence[BaseMessage], contract: WritingContract
) -> bool:
    return (
        max(measurement_ordinals(messages).values(), default=0)
        > contract.measurement_limit
    )


def verified_measurement_text(call: Mapping[str, object], result: object) -> str | None:
    args = call.get("args")
    text = args.get("text") if isinstance(args, Mapping) else None
    if not isinstance(text, str):
        return None
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (ValueError, RecursionError):
            return None
    if (
        not isinstance(result, Mapping)
        or result.get("success") is False
        or result.get("type") == "fail"
    ):
        return None
    word_count = result.get("word_count")
    char_count = result.get("character_count")
    digest = result.get("content_sha256")
    if type(word_count) is not int or type(char_count) is not int:
        return None
    if char_count != len(text) or word_count != count_words(text):
        return None
    expected = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return text if isinstance(digest, str) and digest.lower() == expected else None


def delivery_violation(
    content: str, messages: Sequence[BaseMessage], contract: WritingContract
) -> str | None:
    """Validate exact bytes of the final candidate, independently of model claims."""
    if contract_budget_exceeded(messages, contract):
        return "measurement_budget_exhausted"
    ordinals = measurement_ordinals(messages)
    if not ordinals:
        return "unmeasured"
    last_id = max(ordinals, key=lambda key: ordinals[key])
    call: Mapping[str, object] | None = None
    result: object = None
    for message in current_turn(messages):
        if isinstance(message, AIMessage):
            for candidate in message.tool_calls:
                if candidate["id"] == last_id:
                    call = candidate
        elif isinstance(message, ToolMessage) and message.tool_call_id == last_id:
            result = message.content if message.status != "error" else None
    measured = verified_measurement_text(call, result) if call is not None else None
    if measured is None:
        return "unverified_measurement"
    if measured != content:
        return "delivery_text_mismatch"
    if not contract.in_range(count_words(content)):
        return "outside_contract_range"
    return None


def contract_system_prompt(contract: WritingContract) -> str:
    target = (
        (contract.min_words + contract.max_words) // 2
        if contract.min_words is not None and contract.max_words is not None
        else contract.max_words or contract.min_words
    )
    planning = (
        f"动笔前在内部把已有beat分配到总计约{target}字的篇幅，标题也计入；"
        "不增加场景来填预算，不先写成两倍长稿再压缩。"
        if target is not None else ""
    )
    return (
        "本轮完整候选的可执行写作约束："
        + contract.model_dump_json()
        + f"。最多测量 {contract.measurement_limit} 次（首测加修订），达标或更换系列不重置。"
        "只测完整候选；最终回复须与最后一次 measure_text 的 text 逐字一致，"
        "包括标题、空白和标点，不另加说明或统计报告。字数门槛以本合同为准。"
        "失败会保留草稿并停止有效交付，不自动保存、截断或修改正文。"
        + planning
    )


def contract_measurement_args(
    args: Mapping[str, object], contract: WritingContract
) -> dict[str, object]:
    """The trusted contract owns feedback bounds as well as final validation."""
    return {
        **args,
        "min_words": contract.min_words,
        "max_words": contract.max_words,
    }


def contract_measurement_feedback(
    result: str, args: Mapping[str, object], contract: WritingContract, ordinal: int
) -> str:
    """Attach remaining attempts only to a verified, paired measurement."""
    if verified_measurement_text({"args": args}, result) is None:
        return result
    payload = json.loads(result)
    remaining = max(0, contract.measurement_limit - ordinal)
    payload["writing_budget"] = {
        "attempt": ordinal,
        "measurement_limit": contract.measurement_limit,
        "remaining_measurements": remaining,
        "next_action": (
            "deliver_exact_measured_text" if contract.in_range(payload["word_count"])
            else "stop_and_retain_candidate" if remaining == 0
            else "revise_complete_candidate"
        ),
    }
    return json.dumps(payload, ensure_ascii=False)


def contract_failure_notice(code: str, contract: WritingContract) -> str:
    return (
        f"写作约束未完成交付（{code}；本轮测量上限 {contract.measurement_limit} 次）。"
        "原始草稿和工具记录仍保留；本次停止不自动保存、截断或删除正文，"
        "失败提示不作为正文交付物。请核对要求与现有候选后再决定是否继续。"
    )
