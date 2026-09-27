# -*- coding: utf-8 -*-
"""Consistency service - 章节一致性检查。

流程：读取章节正文 → 优先用 story memory 检索相关设定/前文（不可用时退回
人物与大纲清单）→ LLM 审慎分析 → 解析为结构化 Issue 列表。
仅返回建议，不修改任何正文；结果不做持久化（v1）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import json_repair
from sqlalchemy.ext.asyncio import AsyncSession

from app.background.llm.resolver import resolve_background_llm
from app.core.consistency.prompts import build_consistency_messages
from app.core.errors import NotFoundError, ValidationError
from app.retrieval.chapter_index import (
    get_index_settings,
    resolve_index_embedding_model,
)
from app.retrieval.service import IndexNotReadyError, OpenFicRetrievalService
from app.retrieval.story_memory import story_memory_index_key
from app.storage.repos import (
    character_repo,
    chapter_repo,
    outline_repo,
    retrieval_index_repo,
)

VALID_SEVERITIES = ("info", "warning", "high")
MAX_CHAPTER_EXCERPT = 12_000
MAX_CONTEXT_CHARS = 6_000
MAX_ISSUES = 20
DEFAULT_ISSUE_TYPE = "general"
MAX_ISSUE_MESSAGE_CHARS = 500
MAX_ISSUE_SUGGESTION_CHARS = 1_000
MAX_EVIDENCE_PER_ISSUE = 3
MAX_EVIDENCE_CHARS = 300

_FENCE_PATTERN = re.compile(r"^```[a-zA-Z0-9_-]*\n?([\s\S]*?)\n?```$")


@dataclass(frozen=True)
class ConsistencyIssue:
    type: str
    severity: str
    message: str
    evidence: list[str] = field(default_factory=list)
    suggestion: str = ""


@dataclass(frozen=True)
class ConsistencyResult:
    chapter_id: str
    model: str
    context_source: str
    issues: list[ConsistencyIssue]


def _strip_fences(content: str) -> str:
    text = content.strip()
    match = _FENCE_PATTERN.match(text)
    if match:
        text = match.group(1).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    return text


def parse_consistency_issues(content: str) -> list[ConsistencyIssue]:
    """把模型输出解析为受约束的 Issue 列表；解析失败抛 ValidationError。"""
    raw = _strip_fences(content)
    if not raw:
        raise ValidationError("模型未返回内容，请重试")
    try:
        parsed = json_repair.loads(raw)
    except Exception as exc:  # noqa: BLE001
        raise ValidationError("模型返回的内容无法解析，请重试") from exc
    if isinstance(parsed, dict):
        parsed = parsed.get("issues")
    if not isinstance(parsed, list):
        raise ValidationError("模型返回的内容无法解析，请重试")

    issues: list[ConsistencyIssue] = []
    for item in parsed[:MAX_ISSUES]:
        if not isinstance(item, dict):
            continue
        message = str(item.get("message") or "").strip()
        if not message:
            continue
        severity = str(item.get("severity") or "").strip().lower()
        if severity not in VALID_SEVERITIES:
            severity = "warning"
        evidence_raw = item.get("evidence")
        evidence_list = evidence_raw if isinstance(evidence_raw, list) else [evidence_raw]
        evidence = [
            str(entry).strip()[:MAX_EVIDENCE_CHARS]
            for entry in evidence_list
            if entry is not None and str(entry).strip()
        ][:MAX_EVIDENCE_PER_ISSUE]
        issues.append(
            ConsistencyIssue(
                type=str(item.get("type") or DEFAULT_ISSUE_TYPE).strip()[:50]
                or DEFAULT_ISSUE_TYPE,
                severity=severity,
                message=message[:MAX_ISSUE_MESSAGE_CHARS],
                evidence=evidence,
                suggestion=str(item.get("suggestion") or "").strip()[
                    :MAX_ISSUE_SUGGESTION_CHARS
                ],
            )
        )
    return issues


async def _story_memory_context(
    session: AsyncSession, project_id: str, chapter: Any
) -> str | None:
    """story memory 索引就绪时返回检索片段；否则 None（走清单回退）。"""
    config = await get_index_settings(session)
    model = await resolve_index_embedding_model(session, config)
    if model is None:
        return None
    index_row = await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    if index_row is None or index_row.status != "ready":
        return None

    from app.background.jobs.definitions.retrieval_chapter_index_batch import (
        _build_embedding_client,
    )

    query_text = f"{chapter.title}\n{(chapter.content or '')[:500]}"
    embedding_client = await _build_embedding_client(session, model.id)
    try:
        builder = await OpenFicRetrievalService().query(
            session,
            story_memory_index_key(project_id),
            query_text,
            embedding_client,
        )
        results = (
            await builder.hybrid()
            .vector_top_k(10)
            .bm25_top_k(10)
            .ef(200)
            .filter_eq("project_id", project_id)
            .limit(8)
            .run()
        )
    except IndexNotReadyError:
        return None
    if not results:
        return None
    lines = [f"- {item.text.strip()[:600]}" for item in results if item.text.strip()]
    return "\n".join(lines)[:MAX_CONTEXT_CHARS] if lines else None


async def _inventory_context(session: AsyncSession, project_id: str) -> str:
    """回退资料：人物清单 + 大纲标题树（小体量直接注入）。"""
    parts: list[str] = []
    characters = await character_repo.list_all_by_project(session, project_id)
    if characters:
        parts.append("人物：")
        for character in characters[:30]:
            description = (character.description or "").strip()[:200]
            parts.append(f"- {character.name}：{description}" if description else f"- {character.name}")
    outlines = await outline_repo.list_by_project(session, project_id)
    if outlines:
        parts.append("大纲：")
        for outline in outlines[:50]:
            content = (outline.content or "").strip()[:200]
            parts.append(f"- [{outline.level}] {outline.title}：{content}" if content else f"- [{outline.level}] {outline.title}")
    text = "\n".join(parts)
    return text[:MAX_CONTEXT_CHARS] if text else ""


async def run_consistency_check(
    session: AsyncSession,
    *,
    project_id: str,
    chapter_id: str,
    model_id: str | None = None,
) -> ConsistencyResult:
    chapter = await chapter_repo.get_by_id(session, chapter_id)
    if chapter is None or chapter.project_id != project_id:
        raise NotFoundError(f"章节不存在: {chapter_id}")
    excerpt = (chapter.content or "").strip()
    if not excerpt:
        raise ValidationError("章节内容为空，无法检查")

    context = await _story_memory_context(session, project_id, chapter)
    context_source = "story_memory"
    if context is None:
        context = await _inventory_context(session, project_id)
        context_source = "inventory"

    resolved = await resolve_background_llm(
        session,
        model_policy="light_model",
        model_id=model_id,
    )
    messages = build_consistency_messages(excerpt[:MAX_CHAPTER_EXCERPT], context)
    response = await resolved.client.generate(messages)
    issues = parse_consistency_issues(response.content)
    return ConsistencyResult(
        chapter_id=chapter.id,
        model=resolved.model.name or resolved.model.model_id,
        context_source=context_source,
        issues=issues,
    )
