"""从模型请求中退役已过期的重复测量输入。

``measure_text`` 是 agent 证明字数的唯一手段，因此每一版草稿都要整章传入工具参数。
这些参数进入 history 后会在之后每次模型调用中被重复发送，N 版 3000 字草稿就等于
在请求里携带 N 份整章正文。

本处理器只重写**即将发给提供商的那份消息列表**：把较早的、已被更新测量取代的
measurement 工具调用参数换成一条简短的实测事实标记。它不触碰持久化历史、工具结果、
tool_call_id、审批、source snapshot 或章节正文；工具调用本身（id / name / 参数结构）
保持提供商可接受的形状，配对的 tool 结果也原样保留。

安全性优先于节省：只有当「该调用已被同字数范围的更新测量取代」可以被证明时才会替换，
否则保持原样。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace

from app.agent_runtime.context.compaction.tokens import count_context_tokens
from app.agent_runtime.context.types import ContextMessage

# 目前只有 measure_text 会把整章正文当作参数传入。新增同类工具时在此登记。
MEASUREMENT_TOOL_NAMES = frozenset({"measure_text"})

# 同一字数范围内至少保留这么多份「最新整章测量」，保证仍可对比最近两版。
RETAIN_LATEST_FULL_DRAFTS = 2

# 低于该实测字数的调用视为片段探测，永不被替换，也不占用保留名额。
MIN_FULL_DRAFT_WORDS = 800

# 单条消息省下的 token 低于该值时不值得改写历史形状。
MIN_ELIDED_TOKENS = 256

# 单次请求最多处理这么多字符的待退役草稿。收益递减，而精确计数要为每份草稿
# 编码两次，所以设一个上界，避免病态长历史拖慢每一轮对话。
MAX_ELIDED_DRAFT_CHARS_PER_PASS = 120_000

# 用户消息与该草稿逐字重合达到该长度，视为用户在引用这版草稿。
REFERENCE_PROBE_CHARS = 48
MAX_REFERENCE_PROBES = 256

# 当前请求出现这些表述时，用户明确要对比/恢复历史版本，直接关闭本次清理。
_COMPARE_RESTORE_MARKERS = (
    "对比",
    "比较",
    "比对",
    "对照",
    "回滚",
    "还原",
    "恢复",
    "用回",
    "上一版",
    "前一版",
    "刚才那版",
    "刚才那一版",
    "刚才的版本",
    "之前的版本",
    "之前的草稿",
    "原来的版本",
    "merge",
    "compare",
    "restore",
    "revert",
    "rollback",
    "roll back",
    "previous draft",
    "earlier draft",
    "previous version",
    "earlier version",
)


@dataclass(frozen=True)
class MeasurementGcResult:
    messages: list[ContextMessage]
    tokens_pruned: int
    drafts_elided: int


@dataclass(frozen=True)
class _Call:
    message_index: int
    call_index: int
    tool_call_id: str
    text: str
    range_key: tuple[int | None, int | None]
    word_count: int | None


@dataclass
class _Pending:
    """一个消息内待替换的调用下标与实测字数。"""

    call_indexes: dict[int, tuple[int, int | None, int | None]] = field(
        default_factory=dict
    )


def _int_or_none(value: object) -> int | None:
    return value if type(value) is int else None


def _range_key(args: dict) -> tuple[int | None, int | None]:
    return (_int_or_none(args.get("min_words")), _int_or_none(args.get("max_words")))


def _measured_word_count(content: object) -> int | None:
    """从配对的 tool 结果里读出实测字数；失败、待审批或预览一律返回 None。"""
    if not isinstance(content, str):
        return None
    try:
        payload = json.loads(content)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    if (
        payload.get("success") is False
        or payload.get("type") == "fail"
        or payload.get("error")
    ):
        return None
    word_count = payload.get("word_count")
    if isinstance(word_count, bool) or not isinstance(word_count, int):
        return None
    return word_count


def _measurement_calls(messages: list[ContextMessage]) -> list[_Call]:
    """收集所有带正文参数的 measurement 调用及其配对实测字数。"""
    found: list[tuple[int, int, str, str, dict]] = []
    call_ids: set[str] = set()
    for index, message in enumerate(messages):
        if message.role != "assistant" or not message.tool_calls:
            continue
        for call_index, tool_call in enumerate(message.tool_calls):
            if not isinstance(tool_call, dict):
                continue
            if tool_call.get("name") not in MEASUREMENT_TOOL_NAMES:
                continue
            tool_call_id = tool_call.get("id")
            args = tool_call.get("args")
            if not isinstance(tool_call_id, str) or not isinstance(args, dict):
                continue
            text = args.get("text")
            if not isinstance(text, str) or not text:
                continue
            found.append((index, call_index, tool_call_id, text, args))
            call_ids.add(tool_call_id)
    if not found:
        return []

    # 只解析 measurement 自己的结果，避免为无关工具结果付 json.loads 成本。
    measured: dict[str, tuple[int, int]] = {}
    for index, message in enumerate(messages):
        if message.role != "tool" or message.tool_call_id not in call_ids:
            continue
        word_count = _measured_word_count(message.content)
        if word_count is not None:
            measured[message.tool_call_id] = (index, word_count)

    calls: list[_Call] = []
    for index, call_index, tool_call_id, text, args in found:
        paired = measured.get(tool_call_id)
        # 只有结果出现在调用之后的配对才算已解决。
        calls.append(
            _Call(
                message_index=index,
                call_index=call_index,
                tool_call_id=tool_call_id,
                text=text,
                range_key=_range_key(args),
                word_count=paired[1] if paired and paired[0] > index else None,
            )
        )
    return calls


def _obsolete_calls(calls: list[_Call]) -> list[_Call]:
    """按字数范围分组，只把被更新的整章测量取代的调用判为过期。"""
    by_range: dict[tuple[int | None, int | None], list[_Call]] = {}
    for call in calls:
        if call.word_count is None or call.word_count < MIN_FULL_DRAFT_WORDS:
            # 未解决、失败、待审批与片段探测都不参与淘汰。
            continue
        by_range.setdefault(call.range_key, []).append(call)

    obsolete: list[_Call] = []
    for group in by_range.values():
        if len(group) <= RETAIN_LATEST_FULL_DRAFTS:
            continue
        obsolete.extend(group[:-RETAIN_LATEST_FULL_DRAFTS])
    return obsolete


def _last_user_text(messages: list[ContextMessage]) -> str:
    for message in reversed(messages):
        if message.role == "user" and isinstance(message.content, str):
            return message.content
    return ""


def _requests_history_review(messages: list[ContextMessage]) -> bool:
    """当前请求明确要对比/恢复历史版本时，本次请求不清理。"""
    text = _last_user_text(messages).lower()
    if not text:
        return False
    return any(marker in text for marker in _COMPARE_RESTORE_MARKERS)


def _user_reference_probes(messages: list[ContextMessage]) -> tuple[str, ...]:
    """从用户消息末尾取定长切片，用于逐字引用探测。

    用全部用户消息而不是「该调用之后的用户消息」，一来更保守，二来能顺带保护
    「用户粘贴正文后由 agent 测量」的场景：那段正文本来就属于用户输入。
    从末尾往前取，优先覆盖最近的输入。"""
    text = "\n".join(
        message.content
        for message in messages
        if message.role == "user" and isinstance(message.content, str)
    )
    stride = REFERENCE_PROBE_CHARS // 2
    probes: list[str] = []
    end = len(text)
    while end - REFERENCE_PROBE_CHARS >= 0 and len(probes) < MAX_REFERENCE_PROBES:
        probes.append(text[end - REFERENCE_PROBE_CHARS : end])
        end -= stride
    return tuple(probes)


def _is_referenced(probes: tuple[str, ...], draft: str) -> bool:
    """用户输入里逐字出现过这段草稿时返回 True。

    这是保守的逐字重合探测，不是语义判断：命中就放弃清理，未命中不代表用户
    一定没有提及这版草稿。"""
    if not probes or len(draft) < REFERENCE_PROBE_CHARS:
        return False
    return any(probe in draft for probe in probes)


def _elided_marker(
    word_count: int, min_words: int | None, max_words: int | None
) -> str:
    if min_words is None and max_words is None:
        range_text = "未指定字数范围"
    elif max_words is None:
        range_text = f"下限 {min_words} 字"
    elif min_words is None:
        range_text = f"上限 {max_words} 字"
    else:
        range_text = f"{min_words}-{max_words} 字"
    return (
        "（上下文清理：本次测量的正文输入已从当前模型请求中省略，"
        f"实测 {word_count} 字，{range_text}。正文内容未被修改，"
        "完整输入仍保存在会话历史中。此标记不是正文，不得作为写入内容。）"
    )


def _message_tokens(message: ContextMessage) -> int:
    """与 context metrics 使用同一个计数器，保证 tokens_pruned 与之一致。"""
    return count_context_tokens([message])


def prune_obsolete_measurement_inputs(
    messages: list[ContextMessage],
) -> MeasurementGcResult:
    """把已被更新测量取代的 measurement 正文换成实测事实标记。

    只返回新的消息列表副本；输入消息、工具结果、tool_call_id 与正文均不被修改。"""
    calls = _measurement_calls(messages)
    if not calls:
        return MeasurementGcResult(messages, 0, 0)
    if _requests_history_review(messages):
        return MeasurementGcResult(messages, 0, 0)

    pending: dict[int, _Pending] = {}
    probes = _user_reference_probes(messages)
    budget = MAX_ELIDED_DRAFT_CHARS_PER_PASS
    for call in _obsolete_calls(calls):
        if len(call.text) > budget:
            continue
        if _is_referenced(probes, call.text):
            continue
        budget -= len(call.text)
        entry = pending.setdefault(call.message_index, _Pending())
        entry.call_indexes[call.call_index] = (
            call.word_count or 0,
            call.range_key[0],
            call.range_key[1],
        )
    if not pending:
        return MeasurementGcResult(messages, 0, 0)

    output: list[ContextMessage] = []
    tokens_pruned = 0
    drafts_elided = 0
    for index, message in enumerate(messages):
        entry = pending.get(index)
        if entry is None or not message.tool_calls:
            output.append(message)
            continue

        rewritten: list[dict] = []
        for call_index, tool_call in enumerate(message.tool_calls):
            replacement = entry.call_indexes.get(call_index)
            if replacement is None or not isinstance(tool_call, dict):
                rewritten.append(tool_call)
                continue
            word_count, min_words, max_words = replacement
            args = dict(tool_call.get("args") or {})
            args["text"] = _elided_marker(word_count, min_words, max_words)
            rewritten.append({**tool_call, "args": args})

        candidate = replace(message, tool_calls=rewritten)
        saved = _message_tokens(message) - _message_tokens(candidate)
        if saved < MIN_ELIDED_TOKENS:
            output.append(message)
            continue

        metrics = dict(message.metrics or {})
        metrics["tokens_pruned"] = int(metrics.get("tokens_pruned", 0) or 0) + saved
        output.append(replace(candidate, metrics=metrics))
        tokens_pruned += saved
        drafts_elided += len(entry.call_indexes)

    if not drafts_elided:
        return MeasurementGcResult(messages, 0, 0)
    return MeasurementGcResult(output, tokens_pruned, drafts_elided)
