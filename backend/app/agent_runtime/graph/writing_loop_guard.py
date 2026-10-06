"""Bound repetitive automatic writing corrections without mutating history."""

import json
from collections.abc import Sequence

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.messages.tool import ToolCall


def writing_loop_stop_reason(
    messages: Sequence[BaseMessage], *, limit: int = 6
) -> str | None:
    """Count completed work since the latest human instruction only.

    Successful measurements or changed ranges reset the failure streak. Plain
    measurements (no target range) remain unrestricted, including batch audits.
    Tool-call/result pairs are never removed or reinterpreted as manuscript edits.
    """
    calls: dict[str, ToolCall] = {}
    failures = 0
    previous_range: object = None
    notifications: dict[str, int] = {}
    for message in messages:
        if isinstance(message, HumanMessage):
            calls.clear()
            failures = 0
            previous_range = None
            notifications.clear()
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
                target_range = result.get("range")
                if result.get("within_range") is not False or not isinstance(
                    target_range, dict
                ):
                    failures = 0
                    previous_range = None
                    continue
                failures = failures + 1 if target_range == previous_range else 1
                previous_range = target_range
            elif call["name"] in {"notify_subagent", "send_message_to_subagent"}:
                dispatch_id = call.get("args", {}).get("dispatch_id")
                if isinstance(dispatch_id, str) and dispatch_id:
                    notifications[dispatch_id] = notifications.get(dispatch_id, 0) + 1
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
