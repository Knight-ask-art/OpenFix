import hashlib
import json

import pytest

from app.agent_runtime.tools.impls.chapter.compare_revision import CompareRevisionInput, CompareRevisionTool
from app.agent_runtime.tools.errors import log_tool_failure, tool_failure_from_exception
from pydantic import ValidationError
from loguru import logger


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


async def compare(before, after, **extra):
    return json.loads(await CompareRevisionTool(_state={}).ainvoke({
        "before": before, "after": after,
        "expected_before_sha256": sha(before), "expected_after_sha256": sha(after),
        **extra,
    }))


async def test_revision_binds_both_versions_and_preserves_literal_only():
    before = "灯还亮着。\n她的右肩旧伤未愈。"
    after = "灯熄了。\n她的右肩已经痊愈。"
    data = await compare(before, after, preserve_exact=["右肩", "旧伤未愈", "从未出现"])
    assert data["before_sha256"] == sha(before)
    assert data["after_sha256"] == sha(after)
    assert data["semantic_review_required"] is True
    assert data["approved"] is False
    assert [x["status"] for x in data["preserve_checks"]] == ["present", "missing", "not_in_base"]
    assert any("痊愈" in line["text"] for line in data["changes"])


@pytest.mark.parametrize("field", ["expected_before_sha256", "expected_after_sha256"])
async def test_revision_rejects_stale_versions(field):
    data = await compare("甲", "乙", **{field: "0" * 64})
    assert data.get("success") is False or data.get("type") == "fail"


async def test_revision_output_is_bounded_and_explicitly_partial():
    data = await compare("甲" * 12000, "乙" * 12000)
    assert data["partial"] is True
    assert len(json.dumps(data, ensure_ascii=False)) < 4000


async def test_unchanged_revision_is_not_automatically_approved():
    data = await compare("雨。\n\n", "雨。\n\n")
    assert data["changed_lines"] == 0
    assert not data["partial"]
    assert data["approved"] is False


async def test_revision_limits_whole_book_input():
    data = await compare("甲" * 24001, "乙")
    assert data.get("success") is False or data.get("type") == "fail"


@pytest.mark.parametrize("missing_hash", [True, False])
async def test_schema_failure_never_exposes_input_in_message_or_log(missing_hash):
    sentinel = "PRIVATE_SYNTHETIC_CONTENT_SHOULD_NOT_APPEAR"
    args = {"before": sentinel, "after": sentinel, "expected_before_sha256": sha(sentinel),
            "expected_after_sha256": sha(sentinel), "preserve_exact": [sentinel] * 13}
    if missing_hash:
        del args["expected_before_sha256"]
    captured = []
    sink = logger.add(lambda message: captured.append(str(message)), diagnose=False)
    try:
        with pytest.raises(ValidationError) as caught:
            CompareRevisionInput.model_validate(args)
        error = caught.value
        assert sentinel not in str(error)
        failure = tool_failure_from_exception(error, source="tool_execution")
        assert failure.code == "validation_error"
        assert sentinel not in json.dumps(failure.to_result())
        log_tool_failure(failure, tool_name="compare_revision", tool_call_id="synthetic", exception=error)
        result = await CompareRevisionTool(_state={}).ainvoke(args)
        assert sentinel not in str(result)
        assert json.loads(result)["success"] is False
        assert sentinel not in "".join(captured)
    finally:
        logger.remove(sink)
