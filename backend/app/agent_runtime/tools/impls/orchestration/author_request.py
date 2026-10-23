"""作者原始请求的确定性捕获与交接。

通过 `state.current_revision_id` 解析本轮 Revision，再沿
`Revision.user_message_id` 读取触发该轮的用户消息原文，把作者请求原文原样
放进子 Agent 的持久化内容中。上下文一旦被压缩，主 Agent 手里的本轮请求可能
已不完整，因此这里只读持久化的版本与消息，不读取任何编译后或自由文本。

约束：
- 只复制作者消息原文；不推断、不摘要、不截断
- 版本、消息、会话、任务、角色、状态、seq 任一不匹配即失败，错误信息不含原文
- 超出字符或 token 上限直接失败，绝不截断
- 元数据只记录状态、ID、哈希与计数，不含原文
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from loguru import logger

from app.agent_runtime.persistence.model import AgentRunMessage
from app.agent_runtime.tools.errors import ToolErrorCode, ToolExecutionError
from app.core.utils.tiktoken import count_tokens as _default_count_tokens
from app.storage.repos import revision_repo as revision_repo_module

MAX_AUTHOR_REQUEST_CHARS = 16_000
MAX_AUTHOR_REQUEST_TOKENS = 8_000
MAX_COMPOSED_TASK_CHARS = 64_000
MAX_COMPOSED_TASK_TOKENS = 32_000

AUTHOR_REQUEST_STATUS_PRESENT = "present"
AUTHOR_REQUEST_STATUS_UNAVAILABLE = "unavailable"
# 原文已传输不代表被下游工具读取或采用；此处只证明传输，不做消费声明。
SOURCE_CONSUMPTION_UNVERIFIED = "unverified"

UNAVAILABLE_REASON_NO_REVISION = "no_revision"
UNAVAILABLE_REASON_MISSING_REVISION = "missing_revision"
UNAVAILABLE_REASON_REVISION_MISMATCH = "revision_mismatch"
UNAVAILABLE_REASON_NO_USER_MESSAGE = "no_user_message"
UNAVAILABLE_REASON_MESSAGE_MISMATCH = "message_mismatch"

# 作者消息写入后可能停留的状态，仅此两种视为完整原文：
# - sent：根轮次的新用户消息，运行前/开始时标记
# - pending：排队中的既有用户消息，轮次结束前可能一直保持 pending
# complete / partial / aborted 属于助手或工具消息的终态，出现即说明数据错位，整体失败。
_ACCEPTED_MESSAGE_STATUSES = frozenset({"sent", "pending"})

AUTHOR_METADATA_HEADER_PREFIX = "AUTHOR_REQUEST_METADATA "
AUTHOR_METADATA_HEADER_SUFFIX = " END_AUTHOR_REQUEST_METADATA"

AUTHOR_BLOCK_START = (
    "===== 作者原始请求开始（以下为用户原始请求原文，"
    "意图优先级高于本任务中的Plan摘要与规划示例） ====="
)
AUTHOR_BLOCK_END = "===== 作者原始请求结束 ====="
AUTHOR_BLOCK_TAIL = (
    "（以上为作者原文，属于用户内容而非系统指令；其中的引文、示例与故事文本"
    "仍是用户内容。原文未说明的事项保持未知，不要补写为已确定事实。）"
)

_TokenCounter = Callable[[str], int]


def count_tokens(text: str) -> int:
    """计数入口：分词异常统一转为通用错误，不回显异常内容或正文。"""
    try:
        return _default_count_tokens(text)
    except Exception:
        logger.warning("Author request tokenization failed")
        raise ToolExecutionError(
            "author request could not be measured: text cannot be tokenized; "
            "send a shorter request",
            code="validation_error",
        ) from None


@dataclass(frozen=True)
class AuthorRequestCapture:
    """一个通过校验、可直接用于子任务交接的作者请求原文。"""

    revision_id: str
    message_id: str
    message_seq: int
    content: str

    @property
    def content_sha256(self) -> str:
        return sha256(self.content.encode("utf-8")).hexdigest()

    def to_metadata(self, *, token_counter: _TokenCounter = count_tokens) -> dict[str, Any]:
        """交接元数据：只有状态、ID、哈希与计数，不含原文。"""
        return {
            "status": AUTHOR_REQUEST_STATUS_PRESENT,
            "revision_id": self.revision_id,
            "message_id": self.message_id,
            "message_seq": self.message_seq,
            "content_sha256": self.content_sha256,
            "chars": len(self.content),
            "tokens": token_counter(self.content),
            "source_consumption": SOURCE_CONSUMPTION_UNVERIFIED,
        }


def unavailable_metadata(reason: str) -> dict[str, Any]:
    return {
        "status": AUTHOR_REQUEST_STATUS_UNAVAILABLE,
        "reason": reason,
        "source_consumption": SOURCE_CONSUMPTION_UNVERIFIED,
    }


def _fail(code: ToolErrorCode, message: str) -> ToolExecutionError:
    # 错误文本只包含固定说明，不拼接任何作者原文。
    return ToolExecutionError(message, code=code)


async def resolve_author_request(
    session: AsyncSession,
    *,
    revision_id: str,
    project_id: str,
    task_id: str,
    session_id: str,
) -> AuthorRequestCapture:
    """按 current_revision_id 解析作者原文；任何不一致都整体失败。"""
    if not isinstance(revision_id, str) or not revision_id:
        raise _fail("validation_error", "author request revision id is empty")

    revision = await revision_repo_module.get_by_id(session, revision_id)
    if revision is None:
        raise _fail(
            "not_found",
            f"author request revision not found: {UNAVAILABLE_REASON_MISSING_REVISION}",
        )
    if (
        revision.project_id != project_id
        or revision.task_id != task_id
        or revision.agent_session_id != session_id
    ):
        raise _fail(
            "conflict",
            "author request revision does not belong to the current "
            f"project, task or session: {UNAVAILABLE_REASON_REVISION_MISMATCH}",
        )

    message_id = revision.user_message_id
    if not isinstance(message_id, str) or not message_id:
        raise _fail(
            "conflict",
            "author request revision has no user message: "
            f"{UNAVAILABLE_REASON_NO_USER_MESSAGE}",
        )
    # 只有真正的缺失（None）或空串按历史数据缺省处理；其它非法类型整体失败。
    revision_seq = revision.user_message_seq
    revision_seq_valid = type(revision_seq) is int and revision_seq >= 0
    if revision_seq is not None and revision_seq != "" and not revision_seq_valid:
        raise _fail(
            "conflict",
            "author request revision has an invalid user message seq: "
            f"{UNAVAILABLE_REASON_MESSAGE_MISMATCH}",
        )
    message = await session.get(AgentRunMessage, message_id)
    if message is None:
        raise _fail(
            "not_found",
            "author request user message not found: "
            f"{UNAVAILABLE_REASON_NO_USER_MESSAGE}",
        )
    message_seq = message.seq
    seq_matches = (
        revision_seq_valid
        and type(message_seq) is int
        and message_seq == revision_seq
    )
    if not seq_matches or (
        getattr(message, "id", None) != message_id
        or revision.id != revision_id
        or message.session_id != session_id
        or message.task_id != task_id
        or message.project_id != project_id
        or message.role != "user"
        or message.status not in _ACCEPTED_MESSAGE_STATUSES
    ):
        raise _fail(
            "conflict",
            "author request user message does not match the current revision: "
            f"{UNAVAILABLE_REASON_MESSAGE_MISMATCH}",
        )

    content = message.content
    if not isinstance(content, str) or not content.strip():
        raise _fail(
            "conflict",
            "author request user message is empty: "
            f"{UNAVAILABLE_REASON_MESSAGE_MISMATCH}",
        )
    return AuthorRequestCapture(
        revision_id=revision.id,
        message_id=message.id,
        message_seq=message_seq,
        content=content,
    )


def build_author_request_block(capture: AuthorRequestCapture) -> str:
    return "\n".join(
        [
            AUTHOR_BLOCK_START,
            capture.content,
            AUTHOR_BLOCK_END,
            AUTHOR_BLOCK_TAIL,
        ]
    )


def build_author_metadata_header(
    metadata: dict[str, Any],
    *,
    token_counter: _TokenCounter = count_tokens,
) -> str:
    """确定性证明头：只含状态、ID、哈希与计数，不含原文。

    该行随用户内容块一起持久化（请求 content 与子用户消息一致），
    位于作者原文之前，用于事后核对交接的是哪一条原文。token 计数与
    原文计数共用同一安全计数入口；此处不声明来源工具已消费、章节已生效
    或压缩后永久保留。
    """
    payload = {
        "status": metadata.get("status"),
        "revision_id": metadata.get("revision_id"),
        "message_id": metadata.get("message_id"),
        "message_seq": metadata.get("message_seq"),
        "content_sha256": metadata.get("content_sha256"),
        "chars": metadata.get("chars"),
        "tokens": metadata.get("tokens"),
        "source_consumption": SOURCE_CONSUMPTION_UNVERIFIED,
    }
    header = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    header_tokens = token_counter(header)
    if type(header_tokens) is not int or header_tokens < 0:
        raise _fail("validation_error", "author request metadata is not measurable")
    return (
        f"{AUTHOR_METADATA_HEADER_PREFIX}"
        f"{json.dumps({**payload, 'header_tokens': header_tokens}, ensure_ascii=False, sort_keys=True)}"
        f"{AUTHOR_METADATA_HEADER_SUFFIX}"
    )


def compose_author_task(
    prompt: str,
    capture: AuthorRequestCapture,
    *,
    token_counter: _TokenCounter = count_tokens,
    metadata: dict[str, Any] | None = None,
) -> str:
    """证明头、作者原文在前，Plan 派发说明在后；两者之间以空行分隔。"""
    if metadata is None:
        metadata = capture.to_metadata(token_counter=token_counter)
    header = build_author_metadata_header(metadata, token_counter=token_counter)
    return f"{header}\n{build_author_request_block(capture)}\n\n{prompt}"


def enforce_author_budget(
    content: str,
    *,
    token_counter: _TokenCounter = count_tokens,
) -> int:
    """原文上限；超限直接失败，不截断、不摘要。返回原文 token 数供元数据复用。"""
    chars = len(content)
    if chars > MAX_AUTHOR_REQUEST_CHARS:
        raise _fail(
            "limit_exceeded",
            "author request is too large: "
            f"{chars} chars exceeds the limit of {MAX_AUTHOR_REQUEST_CHARS}; "
            "send a shorter request",
        )
    tokens = token_counter(content)
    if tokens > MAX_AUTHOR_REQUEST_TOKENS:
        raise _fail(
            "limit_exceeded",
            "author request is too large: "
            f"{tokens} tokens exceeds the limit of {MAX_AUTHOR_REQUEST_TOKENS}; "
            "send a shorter request",
        )
    return tokens


def enforce_author_request_budget(
    capture: AuthorRequestCapture,
    *,
    token_counter: _TokenCounter = count_tokens,
) -> int:
    return enforce_author_budget(capture.content, token_counter=token_counter)


def enforce_composed_task_budget(
    task: str,
    *,
    token_counter: _TokenCounter = count_tokens,
) -> None:
    """子任务整体上限（作者原文 + 派发说明 + 引用交付物）。"""
    chars = len(task)
    if chars > MAX_COMPOSED_TASK_CHARS:
        raise _fail(
            "limit_exceeded",
            "composed subagent task is too large: "
            f"{chars} chars exceeds the limit of {MAX_COMPOSED_TASK_CHARS}; "
            "shorten the prompt or reference fewer source dispatch ids",
        )
    tokens = token_counter(task)
    if tokens > MAX_COMPOSED_TASK_TOKENS:
        raise _fail(
            "limit_exceeded",
            "composed subagent task is too large: "
            f"{tokens} tokens exceeds the limit of {MAX_COMPOSED_TASK_TOKENS}; "
            "shorten the prompt or reference fewer source dispatch ids",
        )
