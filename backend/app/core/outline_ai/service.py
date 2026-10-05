# -*- coding: utf-8 -*-
"""Outline AI service - 大纲 AI 四个动作。

完善大纲 / 检查节奏 / 拆分章节 / 根据正文更新大纲。

全部只读取项目已有数据并返回候选内容，不写入任何大纲节点；
用户在前端确认后才通过既有大纲 API 落库（PRD §14、AGENTS 第 10 条）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

import json_repair
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.outline_ai import (
    MAX_OUTLINE_AI_BOOK_OUTLINE_CHARS,
    MAX_OUTLINE_AI_CONTENT_CHARS,
    MAX_OUTLINE_AI_EVIDENCE_CHARS,
    MAX_OUTLINE_AI_EVIDENCE_PER_ISSUE,
    MAX_OUTLINE_AI_ISSUE_MESSAGE_CHARS,
    MAX_OUTLINE_AI_ISSUE_SUGGESTION_CHARS,
    MAX_OUTLINE_AI_ISSUES,
    MAX_OUTLINE_AI_NOTE_CHARS,
    MAX_OUTLINE_AI_SPLIT_ITEMS,
    MAX_OUTLINE_AI_SUMMARY_CHARS,
    MAX_OUTLINE_AI_TITLE_CHARS,
)
from app.background.llm.resolver import resolve_background_llm
from app.core.errors import NotFoundError, ValidationError
from app.core.outline_ai.prompts import (
    build_outline_from_chapter_messages,
    build_outline_improve_messages,
    build_outline_pacing_messages,
    build_outline_split_messages,
    outline_level_label,
)
from app.storage.models.outline import OUTLINE_LEVELS
from app.storage.repos import chapter_repo, outline_repo

MAX_CHAPTER_EXCERPT_CHARS = 12_000
OutlineAiSeverity = Literal["info", "warning", "high"]


def _normalize_severity(value: Any) -> OutlineAiSeverity:
    severity = str(value or "").strip().lower()
    if severity == "info":
        return "info"
    if severity == "high":
        return "high"
    return "warning"


_FENCE_PATTERN = re.compile(r"^```[a-zA-Z0-9_-]*\n?([\s\S]*?)\n?```$")


@dataclass(frozen=True)
class OutlineAiDraft:
    title: str
    content: str
    notes: str | None
    model: str
    usage: dict[str, Any] | None


@dataclass(frozen=True)
class OutlineAiIssue:
    severity: OutlineAiSeverity
    message: str
    evidence: list[str] = field(default_factory=list)
    suggestion: str = ""


@dataclass(frozen=True)
class OutlineAiPacing:
    summary: str
    issues: list[OutlineAiIssue]
    model: str
    usage: dict[str, Any] | None


@dataclass(frozen=True)
class OutlineAiSplitItem:
    title: str
    content: str


@dataclass(frozen=True)
class OutlineAiSplitResult:
    items: list[OutlineAiSplitItem]
    model: str
    usage: dict[str, Any] | None


def _strip_fences(content: str, opener: str, closer: str) -> str:
    text = content.strip()
    match = _FENCE_PATTERN.match(text)
    if match:
        text = match.group(1).strip()
    start = text.find(opener)
    end = text.rfind(closer)
    if start >= 0 and end > start:
        text = text[start : end + 1]
    return text


def _parse_json_object(content: str) -> dict[str, Any]:
    raw = _strip_fences(content, "{", "}")
    if not raw:
        raise ValidationError("模型未返回内容，请重试")
    try:
        parsed = json_repair.loads(raw)
    except Exception as exc:  # noqa: BLE001
        raise ValidationError("模型返回的内容无法解析，请重试") from exc
    if not isinstance(parsed, dict):
        raise ValidationError("模型返回的内容无法解析，请重试")
    return parsed


def _text(value: Any, limit: int) -> str | None:
    """归一化为受长度限制的非空文本；类型不符或为空时返回 None。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:limit]


async def _require_project_outline(
    session: AsyncSession, project_id: str, outline_id: str
):
    outline = await outline_repo.get_by_id(session, outline_id)
    if outline is None or outline.project_id != project_id:
        raise NotFoundError(f"大纲节点不存在: {outline_id}")
    return outline


def _sorted_children(nodes: Iterable[Any]) -> dict[str | None, list[Any]]:
    children: dict[str | None, list[Any]] = {}
    for node in nodes:
        children.setdefault(node.parent_id, []).append(node)
    for items in children.values():
        items.sort(key=lambda node: (node.sort_order, node.created_at))
    return children


def _outline_tree_text(nodes: list[Any], *, root_id: str | None = None) -> str:
    """把大纲树拍平成带缩进的文本；root_id 非空时只输出该子树。"""
    by_id = {node.id: node for node in nodes}
    children = _sorted_children(nodes)
    lines: list[str] = []
    visited: set[str] = set()

    def emit(node: Any, depth: int) -> None:
        if node.id in visited:
            return
        visited.add(node.id)
        indent = "  " * depth
        title = (node.title or "").strip() or "（未命名）"
        lines.append(f"{indent}- [{outline_level_label(node.level)}] {title}")
        for raw_line in (node.content or "").splitlines():
            if raw_line.strip():
                lines.append(f"{indent}  {raw_line.strip()}")
        for child in children.get(node.id, []):
            emit(child, depth + 1)

    if root_id is not None:
        root = by_id.get(root_id)
        if root is not None:
            emit(root, 0)
    else:
        for node in children.get(None, []):
            emit(node, 0)
        # 兜底：父节点缺失或成环的孤儿节点也要出现在文本里。
        for node in nodes:
            if node.id not in visited:
                emit(node, 0)

    return "\n".join(lines)[:MAX_OUTLINE_AI_BOOK_OUTLINE_CHARS]


def parse_outline_draft(content: str) -> tuple[str | None, str | None, str | None]:
    """解析候选大纲内容，返回（标题、内容、说明）。"""
    parsed = _parse_json_object(content)
    draft_content = parsed.get("content")
    if (
        isinstance(draft_content, str)
        and len(draft_content.strip()) > MAX_OUTLINE_AI_CONTENT_CHARS
    ):
        raise ValidationError(
            "模型返回的大纲过长，请按卷或章节分批完善；候选未被截断或保存"
        )
    return (
        _text(parsed.get("title"), MAX_OUTLINE_AI_TITLE_CHARS),
        _text(parsed.get("content"), MAX_OUTLINE_AI_CONTENT_CHARS),
        _text(parsed.get("notes"), MAX_OUTLINE_AI_NOTE_CHARS),
    )


def parse_outline_pacing(content: str) -> tuple[str, list[OutlineAiIssue]]:
    """解析节奏检查结果；完全没有可用内容时抛 ValidationError。"""
    parsed = _parse_json_object(content)
    summary = _text(parsed.get("summary"), MAX_OUTLINE_AI_SUMMARY_CHARS) or ""

    raw_issues = parsed.get("issues")
    if isinstance(raw_issues, dict):
        raw_issues = [raw_issues]
    if not isinstance(raw_issues, list):
        raw_issues = []

    issues: list[OutlineAiIssue] = []
    for raw in raw_issues[:MAX_OUTLINE_AI_ISSUES]:
        if not isinstance(raw, dict):
            continue
        message = _text(raw.get("message"), MAX_OUTLINE_AI_ISSUE_MESSAGE_CHARS)
        if message is None:
            continue
        severity = _normalize_severity(raw.get("severity"))
        evidence_raw = raw.get("evidence")
        evidence_list = (
            evidence_raw if isinstance(evidence_raw, list) else [evidence_raw]
        )
        evidence = [
            entry[:MAX_OUTLINE_AI_EVIDENCE_CHARS]
            for entry in (
                _text(item, MAX_OUTLINE_AI_EVIDENCE_CHARS) for item in evidence_list
            )
            if entry is not None
        ][:MAX_OUTLINE_AI_EVIDENCE_PER_ISSUE]
        issues.append(
            OutlineAiIssue(
                severity=severity,
                message=message,
                evidence=evidence,
                suggestion=_text(
                    raw.get("suggestion"), MAX_OUTLINE_AI_ISSUE_SUGGESTION_CHARS
                )
                or "",
            )
        )

    if not summary and not issues:
        raise ValidationError("模型未返回有效内容，请重试")
    return summary, issues


def parse_outline_split_items(content: str, *, limit: int) -> list[OutlineAiSplitItem]:
    """解析章节拆分候选；没有可用条目时抛 ValidationError。"""
    parsed = _parse_json_object(content)
    raw_items = parsed.get("items")
    if isinstance(raw_items, dict):
        raw_items = [raw_items]
    if not isinstance(raw_items, list):
        raise ValidationError("模型返回的内容无法解析，请重试")

    items: list[OutlineAiSplitItem] = []
    for raw in raw_items[: min(limit, MAX_OUTLINE_AI_SPLIT_ITEMS)]:
        if isinstance(raw, str):
            title = _text(raw, MAX_OUTLINE_AI_TITLE_CHARS)
            if title:
                items.append(OutlineAiSplitItem(title=title, content=""))
            continue
        if not isinstance(raw, dict):
            continue
        title = _text(raw.get("title"), MAX_OUTLINE_AI_TITLE_CHARS) or ""
        item_content = _text(raw.get("content"), MAX_OUTLINE_AI_CONTENT_CHARS) or ""
        if title or item_content:
            items.append(OutlineAiSplitItem(title=title, content=item_content))

    if not items:
        raise ValidationError("模型未返回可用的章节拆分结果，请重试")
    return items


async def improve_outline(
    session: AsyncSession,
    *,
    project_id: str,
    outline_id: str | None,
    level: str,
    title: str,
    content: str,
    instruction: str | None = None,
    model_id: str | None = None,
) -> OutlineAiDraft:
    """AI 完善大纲。返回候选标题与内容，不写入任何数据。"""
    if outline_id:
        outline = await _require_project_outline(session, project_id, outline_id)
        effective_level = outline.level
        effective_title = outline.title or ""
        effective_content = outline.content or ""
    else:
        effective_level = level if level in OUTLINE_LEVELS else "book"
        effective_title = title
        effective_content = content

    if not (effective_title.strip() or effective_content.strip()):
        raise ValidationError("请先填写大纲标题或内容")
    if len(effective_content) > MAX_OUTLINE_AI_CONTENT_CHARS:
        raise ValidationError(
            f"大纲内容过长：最多 {MAX_OUTLINE_AI_CONTENT_CHARS} 字符，"
            f"当前 {len(effective_content)} 字符"
        )

    resolved = await resolve_background_llm(
        session, model_policy="light_model", model_id=model_id
    )
    response = await resolved.client.generate(
        build_outline_improve_messages(
            level=effective_level,
            title=effective_title,
            content=effective_content,
            instruction=instruction,
        )
    )
    result_title, result_content, notes = parse_outline_draft(response.content)
    if result_content is None:
        raise ValidationError("模型未返回有效的大纲内容，请重试")

    return OutlineAiDraft(
        title=result_title or effective_title.strip()[:MAX_OUTLINE_AI_TITLE_CHARS],
        content=result_content,
        notes=notes,
        model=resolved.model.name or resolved.model.model_id,
        usage=getattr(response, "usage", None),
    )


async def check_pacing(
    session: AsyncSession,
    *,
    project_id: str,
    outline_id: str | None,
    scope: str,
    model_id: str | None = None,
) -> OutlineAiPacing:
    """AI 检查节奏。仅返回审慎表述的节奏提示，不写入任何数据。"""
    nodes = await outline_repo.list_by_project(session, project_id)

    if scope == "node":
        if not outline_id:
            raise ValidationError("请选择要检查节奏的大纲节点")
        node = await _require_project_outline(session, project_id, outline_id)
        scope_label = f"{outline_level_label(node.level)}：{(node.title or '').strip() or '（未命名）'}"
        outline_text = _outline_tree_text(nodes, root_id=node.id)
    else:
        if not nodes:
            raise ValidationError("项目暂无大纲，无法检查节奏")
        scope_label = "全书大纲"
        outline_text = _outline_tree_text(nodes)

    if not outline_text.strip():
        raise ValidationError("所选大纲为空，无法检查节奏")

    resolved = await resolve_background_llm(
        session, model_policy="light_model", model_id=model_id
    )
    response = await resolved.client.generate(
        build_outline_pacing_messages(
            scope_label=scope_label, outline_text=outline_text
        )
    )
    summary, issues = parse_outline_pacing(response.content)
    return OutlineAiPacing(
        summary=summary,
        issues=issues,
        model=resolved.model.name or resolved.model.model_id,
        usage=getattr(response, "usage", None),
    )


async def split_into_chapters(
    session: AsyncSession,
    *,
    project_id: str,
    outline_id: str,
    max_chapters: int,
    instruction: str | None = None,
    model_id: str | None = None,
) -> OutlineAiSplitResult:
    """AI 拆分章节。返回候选章节大纲，不写入任何数据。"""
    node = await _require_project_outline(session, project_id, outline_id)
    title = (node.title or "").strip()
    content = (node.content or "").strip()
    if not title and not content:
        raise ValidationError("大纲节点为空，无法拆分章节")
    if node.level != "volume":
        raise ValidationError("请选择卷级大纲节点后再拆分章节")
    if len(content) > MAX_OUTLINE_AI_CONTENT_CHARS:
        raise ValidationError(
            f"大纲内容过长：最多 {MAX_OUTLINE_AI_CONTENT_CHARS} 字符，"
            f"当前 {len(content)} 字符"
        )
    limit = max(1, min(max_chapters, MAX_OUTLINE_AI_SPLIT_ITEMS))

    resolved = await resolve_background_llm(
        session, model_policy="light_model", model_id=model_id
    )
    response = await resolved.client.generate(
        build_outline_split_messages(
            title=title,
            content=content,
            max_chapters=limit,
            instruction=instruction,
        )
    )
    items = parse_outline_split_items(response.content, limit=limit)
    return OutlineAiSplitResult(
        items=items,
        model=resolved.model.name or resolved.model.model_id,
        usage=getattr(response, "usage", None),
    )


async def update_from_chapter(
    session: AsyncSession,
    *,
    project_id: str,
    outline_id: str,
    chapter_id: str | None = None,
    instruction: str | None = None,
    model_id: str | None = None,
) -> OutlineAiDraft:
    """AI 根据正文更新大纲。返回候选大纲内容，不写入任何数据。"""
    node = await _require_project_outline(session, project_id, outline_id)
    effective_chapter_id = chapter_id or node.chapter_id
    if not effective_chapter_id:
        raise ValidationError("请选择要参考的章节")

    chapter = await chapter_repo.get_by_id(session, effective_chapter_id)
    if chapter is None or chapter.project_id != project_id:
        raise NotFoundError(f"章节不存在: {effective_chapter_id}")

    chapter_text = (chapter.content or "").strip()
    if not chapter_text:
        raise ValidationError("所选章节暂无正文，无法更新大纲")
    chapter_label = f"第{chapter.order}章 {chapter.title}"

    resolved = await resolve_background_llm(
        session, model_policy="light_model", model_id=model_id
    )
    response = await resolved.client.generate(
        build_outline_from_chapter_messages(
            outline_title=node.title or "",
            outline_content=node.content or "",
            chapter_label=chapter_label,
            chapter_text=chapter_text[:MAX_CHAPTER_EXCERPT_CHARS],
            instruction=instruction,
        )
    )
    result_title, result_content, notes = parse_outline_draft(response.content)
    if result_content is None:
        raise ValidationError("模型未返回有效的大纲内容，请重试")

    return OutlineAiDraft(
        title=result_title or (node.title or "").strip()[:MAX_OUTLINE_AI_TITLE_CHARS],
        content=result_content,
        notes=notes,
        model=resolved.model.name or resolved.model.model_id,
        usage=getattr(response, "usage", None),
    )
