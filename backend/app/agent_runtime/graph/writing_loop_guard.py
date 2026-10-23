"""Bound repetitive automatic writing corrections without mutating history."""

import hashlib
import json
from collections.abc import Sequence
from typing import TypeGuard

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.messages.tool import ToolCall

from app.core.word_count import count_words

# 同一目标范围内，固定或不再接近目标的测量达到该次数即提前停止自动修订。
NO_PROGRESS_MEASUREMENT_LIMIT = 3

# 可选的修订系列标识上限；超过该长度的配对数据视为不可信。
MAX_REVISION_SERIES_CHARACTERS = 80

_HASH_METADATA_KEYS = ("content_sha256", "character_count", "revision_series")


def _valid_count(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _bounded_range(value: object) -> tuple[int | None, int | None] | None:
    """Return a valid bounded target range, or None when it is not a bounded target."""
    if not isinstance(value, dict):
        return None
    low = value.get("min_words")
    high = value.get("max_words")
    if low is not None and not _valid_count(low):
        return None
    if high is not None and not _valid_count(high):
        return None
    if low is None and high is None:
        return None
    if low is not None and high is not None and low > high:
        return None
    return low, high


def _paired_range(call: ToolCall) -> tuple[int | None, int | None] | None:
    """Target range declared by the paired call args, if any."""
    args = call.get("args")
    if not isinstance(args, dict):
        return None
    return _bounded_range(
        {"min_words": args.get("min_words"), "max_words": args.get("max_words")}
    )


def _is_outside_range(
    target: tuple[int | None, int | None], word_count: int
) -> bool:
    low, high = target
    return (low is not None and word_count < low) or (
        high is not None and word_count > high
    )


def _distance_to_range(
    target: tuple[int | None, int | None], word_count: int
) -> int:
    low, high = target
    if low is not None and word_count < low:
        return low - word_count
    if high is not None and word_count > high:
        return word_count - high
    return 0


def _normalized_series(value: object) -> tuple[bool, str | None]:
    """Normalize an optional revision series; ``(ok, series)``."""
    if value is None or value == "":
        return True, None
    if not isinstance(value, str) or len(value) > MAX_REVISION_SERIES_CHARACTERS:
        return False, None
    return True, value


def _measurement_identity(
    result: dict, call: ToolCall
) -> tuple[str, int, str | None] | None:
    """Validate that result hash/count/series really describe the paired call's text."""
    args = call.get("args")
    text = args.get("text") if isinstance(args, dict) else None
    if not isinstance(text, str):
        return None
    digest = result.get("content_sha256")
    character_count = result.get("character_count")
    word_count = result.get("word_count")
    if (
        not isinstance(digest, str)
        or not _valid_count(character_count)
        or not _valid_count(word_count)
    ):
        return None
    expected = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if character_count != len(text) or digest.lower() != expected:
        return None
    # 字数必须与确定性计数器一致，不能由调用方或结果自报。
    if word_count != count_words(text):
        return None
    result_ok, result_series = _normalized_series(result.get("revision_series"))
    call_ok, call_series = _normalized_series(args.get("revision_series"))
    if not result_ok or not call_ok or result_series != call_series:
        return None
    return expected, word_count, result_series


def writing_loop_stop_reason(
    messages: Sequence[BaseMessage], *, limit: int = 6
) -> str | None:
    """Count completed work since the latest human instruction only.

    Successful measurements or changed ranges reset the failure streak. Plain
    measurements (no target range) remain unrestricted, including batch audits.
    Tool-call/result pairs are never removed or reinterpreted as manuscript edits.

    Bounded measurements whose result hash/count/range match the paired call args
    also stop earlier (``NO_PROGRESS_MEASUREMENT_LIMIT``). Repeated identical text
    for the same target range stops without a series identifier. Non-improving
    measurements across different text versions only count when the call and the
    result carry the same explicit ``revision_series`` and target range; changing
    the series or range resets that streak. Distinct chapters measured with the same
    target but no series are not treated as one revision series. The six-attempt
    same-target ceiling still applies even while the draft gets closer to the target.
    Legacy results without hash metadata keep the old behavior.
    """
    calls: dict[str, ToolCall] = {}
    failures = 0
    previous_range: object = None
    notifications: dict[str, int] = {}
    no_progress_streak = 0
    best_distance: int | None = None
    last_hash: str | None = None
    current_target: tuple[int | None, int | None] | None = None
    current_series: str | None = None

    def reset_no_progress() -> None:
        nonlocal no_progress_streak, best_distance, last_hash, current_target
        nonlocal current_series
        no_progress_streak = 0
        best_distance = None
        last_hash = None
        current_target = None
        current_series = None

    for message in messages:
        if isinstance(message, HumanMessage):
            calls.clear()
            failures = 0
            previous_range = None
            notifications.clear()
            reset_no_progress()
        elif isinstance(message, AIMessage):
            for call in message.tool_calls:
                call_id = call.get("id")
                if isinstance(call_id, str) and call_id:
                    calls[call_id] = call
        elif isinstance(message, ToolMessage):
            call = calls.pop(message.tool_call_id, None)
            if call is None:
                continue
            if call["name"] == "measure_text":
                if not isinstance(message.content, str):
                    continue
                try:
                    result = json.loads(message.content)
                except (ValueError, RecursionError):
                    continue
                if not isinstance(result, dict):
                    continue
                identity = _measurement_identity(result, call)
                has_metadata = any(key in result for key in _HASH_METADATA_KEYS)
                if has_metadata and identity is None:
                    # Mismatched or malformed hash/count/series cannot prove
                    # progress either way; never let it end the task.
                    continue
                target_range = result.get("range")
                if result.get("within_range") is not False or not isinstance(
                    target_range, dict
                ):
                    failures = 0
                    previous_range = None
                    reset_no_progress()
                    continue
                target = _bounded_range(target_range)
                if target is None:
                    # Reversed or unbounded data cannot prove a failure.
                    continue
                if identity is None:
                    # Legacy result: keep only the existing failure ceiling.
                    failures = failures + 1 if target_range == previous_range else 1
                    previous_range = target_range
                    reset_no_progress()
                    continue
                paired_target = _paired_range(call)
                word_count = identity[1]
                if (
                    paired_target is None
                    or paired_target != target
                    or not _is_outside_range(target, word_count)
                ):
                    # Result metadata must match the paired call args exactly and
                    # ``within_range=False`` must really be outside the range.
                    continue
                failures = failures + 1 if target_range == previous_range else 1
                previous_range = target_range
                digest, word_count, series = identity
                if target != current_target:
                    no_progress_streak = 0
                    best_distance = None
                    last_hash = None
                    current_target = target
                    current_series = series
                elif series != current_series:
                    no_progress_streak = 0
                    best_distance = None
                    last_hash = None
                    current_series = series
                distance = _distance_to_range(target, word_count)
                if series is not None:
                    # Explicit series: non-improving distances across versions count.
                    if best_distance is None or distance < best_distance:
                        no_progress_streak = 1
                    else:
                        no_progress_streak += 1
                else:
                    # No series: only repeated identical text can prove no progress.
                    no_progress_streak = (
                        no_progress_streak + 1
                        if last_hash is not None and digest == last_hash
                        else 1
                    )
                last_hash = digest
                best_distance = (
                    distance
                    if best_distance is None
                    else min(best_distance, distance)
                )
            elif call["name"] in {"notify_subagent", "send_message_to_subagent"}:
                dispatch_id = call.get("args", {}).get("dispatch_id")
                if isinstance(dispatch_id, str) and dispatch_id:
                    notifications[dispatch_id] = notifications.get(dispatch_id, 0) + 1
    if no_progress_streak >= NO_PROGRESS_MEASUREMENT_LIMIT:
        return (
            f"本轮连续 {NO_PROGRESS_MEASUREMENT_LIMIT} 次对同一目标范围的测量文本没有变化，"
            "或字数始终没有更接近目标范围，已停止自动修订，等待你的意见。"
            "测量文本仍保留在工具记录中；本次停止不会自动保存、截断或删除正文，"
            "此前是否已保存过正文以实际工具与版本记录为准；可给出新的指令继续。"
        )
    if failures >= limit:
        return (
            f"本轮连续 {limit} 次相同目标范围测量仍未达标，已停止自动修订，等待你的意见。"
            "最近测量结果与输入文本保留在工具记录中，文本可能仍是片段；"
            "没有因停止而自动保存、截断或删除正文。可给出新的指令继续。"
        )
    if any(count >= limit for count in notifications.values()):
        return (
            f"本轮已向同一子智能体续派 {limit} 次，已停止继续自动往返，等待你的意见。"
            "现有交付物与子任务历史保留；没有因停止而自动保存或删除正文。"
            "可查看当前交付物后给出新的指令继续。"
        )
    return None
