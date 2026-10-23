"""Deterministic writing-contract regressions with synthetic text only."""

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import ValidationError

from app.agent_runtime.tools.impls.chapter.measure_text import MeasureTextTool
from app.agent_runtime.writing_contract import (
    WritingContract,
    contract_budget_exceeded,
    contract_from_request_json,
    current_turn,
    delivery_violation,
    measurement_ordinals,
)

TEXT = "山风起。"


def call(call_id, text=TEXT, **extra):
    return {"id": call_id, "name": "measure_text", "args": {"text": text, **extra}}


async def measured(text=TEXT, *, call_id="m1", **extra):
    # Exercise the real producer rather than recreating its payload in the test.
    result = await MeasureTextTool(_state={})._execute(text=text, **extra)
    return [
        AIMessage(content="", tool_calls=[call(call_id, text, **extra)]),
        ToolMessage(content=result, tool_call_id=call_id, name="measure_text"),
    ]


@pytest.mark.parametrize("field", ["min_words", "max_words", "max_revisions"])
@pytest.mark.parametrize("value", [True, False, "3", 3.0, -1])
def test_integer_fields_are_strict_and_nonnegative(field, value):
    with pytest.raises(ValidationError):
        WritingContract.model_validate({"goal": "g", field: value})


@pytest.mark.parametrize(
    "data",
    [
        {"goal": ""},
        {"goal": " \t "},
        {"goal": "x" * 201},
        {"goal": "g", "min_words": 5, "max_words": 4},
        {"goal": "g", "max_revisions": 11},
        {"goal": "g", "unknown": 1},
    ],
)
def test_invalid_contract_is_rejected(data):
    with pytest.raises(ValidationError):
        WritingContract.model_validate(data)


def test_range_boundaries_and_zero_revision_contract():
    contract = WritingContract(goal="g", min_words=2, max_words=2, max_revisions=0)
    assert contract.measurement_limit == 1
    assert not contract.in_range(1)
    assert contract.in_range(2)
    assert not contract.in_range(3)
    assert WritingContract(goal="g").in_range(0)
    assert WritingContract(goal="g", min_words=2).in_range(100)
    assert WritingContract(goal="g", max_words=2).in_range(0)


def test_persisted_roundtrip_and_legacy_absence():
    contract = WritingContract(goal="g", min_words=0, max_words=9, max_revisions=0)
    request = json.loads(json.dumps({"writing_contract": contract.model_dump()}))
    assert contract_from_request_json(request) == contract
    assert WritingContract.model_validate_json(contract.model_dump_json()) == contract
    assert contract_from_request_json({"task": "legacy"}) is None


@pytest.mark.parametrize("request_value", [None, [], "{}", 3])
def test_invalid_request_fails_closed(request_value):
    with pytest.raises(ValueError):
        contract_from_request_json(request_value)


@pytest.mark.parametrize(
    "value", [None, {}, "{}", [], {"goal": "g", "max_revisions": True}]
)
def test_present_but_corrupt_contract_fails_closed(value):
    with pytest.raises(ValueError):
        contract_from_request_json({"writing_contract": value})


async def test_exact_real_measurement_preserves_title_and_whitespace():
    text = "第1节\n\n山风起。 A word.\n"
    messages = [HumanMessage(content="write"), *await measured(text)]
    assert delivery_violation(text, messages, WritingContract(goal="g")) is None


@pytest.mark.parametrize("delivered", [TEXT + "上", TEXT + "\n", " " + TEXT, TEXT[:-1]])
async def test_unmeasured_changes_and_fragments_are_rejected(delivered):
    messages = await measured()
    assert delivery_violation(delivered, messages, WritingContract(goal="g")) == (
        "delivery_text_mismatch"
    )


async def test_measured_fragment_cannot_certify_full_candidate():
    assert (
        delivery_violation(
            TEXT + "夜雨落。", await measured(TEXT), WritingContract(goal="g")
        )
        == "delivery_text_mismatch"
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("content_sha256", "0" * 64),
        ("word_count", 999),
        ("character_count", 999),
        ("word_count", True),
        ("character_count", True),
        ("word_count", "1"),
        ("success", False),
    ],
)
async def test_forged_or_failed_payload_is_not_delivery_evidence(field, value):
    messages = await measured("A")
    payload = json.loads(messages[-1].content)
    payload[field] = value
    messages[-1].content = json.dumps(payload)
    assert delivery_violation("A", messages, WritingContract(goal="g")) == (
        "unverified_measurement"
    )


@pytest.mark.parametrize("content", ["not json", "null", "[]", "{}"])
async def test_malformed_result_is_rejected(content):
    messages = await measured()
    messages[-1].content = content
    assert delivery_violation(TEXT, messages, WritingContract(goal="g")) == (
        "unverified_measurement"
    )


async def test_missing_or_wrongly_paired_result_is_rejected():
    messages = await measured()
    assert delivery_violation(TEXT, messages[:-1], WritingContract(goal="g")) == (
        "unverified_measurement"
    )
    messages[-1].tool_call_id = "other"
    assert delivery_violation(TEXT, messages, WritingContract(goal="g")) == (
        "unverified_measurement"
    )


async def test_error_tool_message_is_not_successful_measurement():
    messages = await measured()
    messages[-1].status = "error"
    assert delivery_violation(TEXT, messages, WritingContract(goal="g")) == (
        "unverified_measurement"
    )


async def test_contract_range_overrules_tools_claimed_range():
    messages = await measured(min_words=1, max_words=100)
    assert json.loads(messages[-1].content)["within_range"] is True
    assert delivery_violation(
        TEXT, messages, WritingContract(goal="g", min_words=9)
    ) == ("outside_contract_range")


async def test_latest_human_discards_old_measurements_and_resets_budget():
    messages = [
        HumanMessage(content="old"),
        *await measured(),
        HumanMessage(content="new"),
    ]
    contract = WritingContract(goal="g", max_revisions=0)
    assert list(current_turn(messages)) == []
    assert not contract_budget_exceeded(messages, contract)
    assert delivery_violation(TEXT, messages, contract) == "unmeasured"
    messages.extend(await measured(call_id="new"))
    assert measurement_ordinals(messages) == {"new": 1}
    assert delivery_violation(TEXT, messages, contract) is None


async def test_success_range_series_and_system_messages_do_not_reset_budget():
    messages = [HumanMessage(content="write")]
    contract = WritingContract(goal="g", max_revisions=1)
    messages.extend(await measured(call_id="first", min_words=1, revision_series="a"))
    messages.append(SystemMessage(content="resume after approval"))
    messages.extend(
        await measured(call_id="second", max_words=100, revision_series="b")
    )
    assert measurement_ordinals(messages) == {"first": 1, "second": 2}
    assert not contract_budget_exceeded(messages, contract)
    assert delivery_violation(TEXT, messages, contract) is None
    messages.extend(await measured(call_id="third", revision_series="c"))
    assert contract_budget_exceeded(messages, contract)
    assert (
        delivery_violation(TEXT, messages, contract) == "measurement_budget_exhausted"
    )


async def test_parallel_results_use_declaration_order_not_completion_order():
    first = await measured(TEXT, call_id="first")
    last = await measured("夜雨落。", call_id="last")
    messages = [
        AIMessage(content="", tool_calls=[call("first"), call("last", "夜雨落。")]),
        last[-1],
        first[-1],
    ]
    contract = WritingContract(goal="g", max_revisions=1)
    assert measurement_ordinals(messages) == {"first": 1, "last": 2}
    assert delivery_violation("夜雨落。", messages, contract) is None
    assert delivery_violation(TEXT, messages, contract) == "delivery_text_mismatch"
    assert contract_budget_exceeded(
        messages, WritingContract(goal="g", max_revisions=0)
    )


def test_failed_and_unfinished_attempts_count_but_other_tools_do_not():
    messages = [
        AIMessage(content="", tool_calls=[call("failed"), call("pending")]),
        ToolMessage(content='{"success": false}', tool_call_id="failed"),
        AIMessage(
            content="", tool_calls=[{"id": "read", "name": "read_chapter", "args": {}}]
        ),
    ]
    assert measurement_ordinals(messages) == {"failed": 1, "pending": 2}
    assert contract_budget_exceeded(
        messages, WritingContract(goal="g", max_revisions=0)
    )
