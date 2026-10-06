"""子Agent已真实保存的章节写入状态。

主Agent收到 dispatch 结果时，必须能区分两种交付状态：

- 子Agent只是把文本交回来（未落库）
- 子Agent已经通过 write_chapter 真实写入并持久化

判定只读取持久化的工具结果（chapter_diff 元数据），不解析子Agent自述文本。
审批预览、被拒绝和失败的写入都不算已保存，判定口径与 session change 投影一致。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.persistence import repo as message_repo
from app.agent_runtime.persistence.child_runs import (
    get_child_run_agent_number,
    list_child_runs_for_parent,
)
from app.agent_runtime.persistence.model import AgentChildRun
from app.storage.repos import chapter_repo


WRITE_TOOL_NAMES = ("write_chapter",)

# 与 session change 投影一致：出现这些标记说明写入没有落库。
NON_PERSISTED_REASONS = frozenset({"approval_preview", "ask_user_pending", "cancelled"})

SAVED_CHAPTER_OWNERSHIP_NOTE = (
    "saved_chapters 中的章节已由该子Agent通过 write_chapter 真实写入并持久化，"
    "归该子Agent所有。不要再次调用 write_chapter 新建这些章节；"
    "需要修改时使用 edit_chapter 并传 chapter_ref（type=title 传精确标题，"
    "或 type=order 传卷内序号）；只有确实要新增后续章节时才新建。"
)


@dataclass(frozen=True)
class SavedChapterWrite:
    """一个已落库的新建章节，带有真实的 chapter_id。"""

    chapter_id: str
    title: str
    order: int | None
    volume_title: str | None = None
    agent_key: str | None = None
    agent_number: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "chapter_id": self.chapter_id,
            "title": self.title,
            "order": self.order,
            "status": "saved",
        }
        if self.volume_title:
            payload["volume"] = self.volume_title
        if self.agent_key:
            payload["agent"] = self.agent_key
        if self.agent_number:
            payload["agent_number"] = self.agent_number
        return payload


def _parse_result(content: object) -> dict[str, Any] | None:
    if not isinstance(content, str):
        return None
    try:
        parsed = json.loads(content)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _result_containers(result: dict[str, Any]) -> list[dict[str, Any]]:
    containers = [result]
    data = result.get("data")
    if isinstance(data, dict):
        containers.append(data)
    return containers


def _chapter_diff(result: dict[str, Any]) -> dict[str, Any] | None:
    """从已落库的写入结果里读回真实章节标识；未落库的结果返回 None。"""
    for container in _result_containers(result):
        if container.get("success") is False or container.get("error"):
            return None
        if container.get("type") == "preview":
            return None
        if container.get("reason") in NON_PERSISTED_REASONS:
            return None
    for container in _result_containers(result):
        metadata = container.get("metadata")
        if not isinstance(metadata, dict):
            continue
        diff = metadata.get("chapter_diff")
        if isinstance(diff, dict) and diff.get("chapter_id"):
            return diff
    return None


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _volume_title(diff: dict[str, Any]) -> str | None:
    path = diff.get("path")
    if isinstance(path, list) and path and isinstance(path[0], str):
        return path[0]
    return None


def saved_write_from_message(
    row: object, run: AgentChildRun
) -> SavedChapterWrite | None:
    """把一个持久化的子Agent工具消息还原成已保存章节；不是落库写入则返回 None。"""
    if getattr(row, "role", None) != "tool":
        return None
    if getattr(row, "tool_name", None) not in WRITE_TOOL_NAMES:
        return None
    result = _parse_result(getattr(row, "content", None))
    if result is None:
        return None
    diff = _chapter_diff(result)
    if diff is None:
        return None
    chapter_id = diff.get("chapter_id")
    if not isinstance(chapter_id, str) or not chapter_id:
        return None
    title = diff.get("chapter_title")
    return SavedChapterWrite(
        chapter_id=chapter_id,
        title=title if isinstance(title, str) else "",
        order=_int_or_none(diff.get("order")),
        volume_title=_volume_title(diff),
        agent_key=run.agent_key,
        agent_number=get_child_run_agent_number(run.metadata_json),
    )


async def collect_saved_chapter_writes(
    session: AsyncSession,
    child_runs: Sequence[AgentChildRun],
) -> list[SavedChapterWrite]:
    """按子运行读取已持久化的新建章节；同一 chapter_id 只保留第一条。"""
    if not child_runs:
        return []
    messages_by_session = await message_repo.list_by_sessions(
        session,
        [run.child_thread_id for run in child_runs],
        tool_names=WRITE_TOOL_NAMES,
    )
    writes: list[SavedChapterWrite] = []
    seen: set[str] = set()
    for run in child_runs:
        for row in messages_by_session.get(run.child_thread_id, []):
            write = saved_write_from_message(row, run)
            if write is None or write.chapter_id in seen:
                continue
            seen.add(write.chapter_id)
            writes.append(write)
    return writes


async def list_task_child_runs(
    session: AsyncSession,
    *,
    parent_session_id: str,
    parent_task_id: str,
) -> list[AgentChildRun]:
    if not parent_session_id or not parent_task_id:
        return []
    runs = await list_child_runs_for_parent(session, parent_session_id)
    return [run for run in runs if run.parent_task_id == parent_task_id]


async def collect_task_saved_chapter_writes(
    session: AsyncSession,
    *,
    parent_session_id: str,
    parent_task_id: str,
) -> list[SavedChapterWrite]:
    return await collect_saved_chapter_writes(
        session,
        await list_task_child_runs(
            session,
            parent_session_id=parent_session_id,
            parent_task_id=parent_task_id,
        ),
    )


def normalize_text(value: str) -> str:
    """只归一化换行与行尾空白，不做内容改写。"""
    unified = value.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in unified.strip().split("\n"))


async def find_duplicate_saved_chapter(
    session: AsyncSession,
    *,
    parent_session_id: str,
    parent_task_id: str,
    project_id: str,
    volume_id: str,
    title: str,
    content: str,
) -> SavedChapterWrite | None:
    """找出与本任务子Agent已保存章节真正重合的那一条写入。

    只有同一卷内标题与正文都重合才算重复：标题相同不算，正文不同不算。
    这里既不按标题全局禁止同名章节，也不把写入静默改挂到已存在的章节上。
    """
    writes = await collect_task_saved_chapter_writes(
        session,
        parent_session_id=parent_session_id,
        parent_task_id=parent_task_id,
    )
    if not writes:
        return None
    normalized_title = normalize_text(title)
    normalized_content = normalize_text(content)
    for write in writes:
        if normalize_text(write.title) != normalized_title:
            continue
        chapter = await chapter_repo.get_by_id(session, write.chapter_id)
        if chapter is None:
            continue
        if chapter.project_id != project_id or chapter.volume_id != volume_id:
            continue
        if normalize_text(str(chapter.title)) != normalized_title:
            continue
        if normalize_text(str(chapter.content)) != normalized_content:
            continue
        return write
    return None
