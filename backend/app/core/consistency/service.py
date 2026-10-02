# -*- coding: utf-8 -*-
"""Consistency service - 章节一致性检查。

流程：读取章节正文 → 优先用 story memory 检索相关设定/前文（不可用时退回
人物与大纲清单）→ LLM 审慎分析 → 解析为结构化 Issue 列表。
仅返回建议，不修改任何正文；结果不做持久化（v1）。
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field, replace
from typing import Any

import json_repair
from sqlalchemy.ext.asyncio import AsyncSession

from app.background.llm.resolver import resolve_background_llm
from app.core.consistency.prompts import (
    build_consistency_analysis_messages,
    build_consistency_messages,
)
from app.core.errors import NotFoundError, ValidationError
from app.retrieval.chapter_index import (
    get_index_settings,
    resolve_index_embedding_model,
)
from app.retrieval.service import IndexNotReadyError, OpenFicRetrievalService
from app.retrieval.story_memory import (
    story_memory_index_is_fresh,
    story_memory_index_key,
)
from app.storage.repos import (
    character_repo,
    chapter_repo,
    outline_repo,
    retrieval_index_repo,
    volume_repo,
)

VALID_SEVERITIES = ("info", "warning", "high")
VALID_SCOPES = ("chapter", "volume", "book")
MAX_CHAPTER_EXCERPT = 12_000
MAX_SCOPE_EXCERPT = 48_000
MAX_CONTEXT_CHARS = 6_000
MAX_CONCURRENT_SCOPE_REQUESTS = 3
DEFAULT_ISSUE_TYPE = "general"
MAX_ISSUE_MESSAGE_CHARS = 500
MAX_ISSUE_SUGGESTION_CHARS = 1_000
MAX_EVIDENCE_PER_ISSUE = 3
MAX_EVIDENCE_CHARS = 300
MAX_ISSUE_SOURCES = 6
SOURCE_CONTEXT_CHARS = 100
MAX_ANALYSIS_CHARS = 6_000

_FENCE_PATTERN = re.compile(r"^```[a-zA-Z0-9_-]*\n?([\s\S]*?)\n?```$")


@dataclass(frozen=True)
class ConsistencySource:
    chapter_id: str
    chapter_order: int
    chapter_title: str
    excerpt: str
    quote: str


@dataclass(frozen=True)
class ConsistencyIssue:
    type: str
    severity: str
    message: str
    evidence: list[str] = field(default_factory=list)
    suggestion: str = ""
    sources: list[ConsistencySource] = field(default_factory=list)


@dataclass(frozen=True)
class ConsistencyResult:
    scope: str
    label: str
    chapter_id: str | None
    volume_id: str | None
    chapter_count: int
    model: str
    context_source: str
    issues: list[ConsistencyIssue]
    failed_segments: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class ConsistencyIssueAnalysis:
    model: str
    analysis: str


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
    for item in parsed:
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


def _resolve_issue_sources(
    issue: ConsistencyIssue, chapters: list[Any]
) -> list[ConsistencySource]:
    """Bind only verbatim issue evidence to text in the selected project chapters."""
    sources: list[ConsistencySource] = []
    seen: set[tuple[str, int]] = set()
    for evidence in issue.evidence:
        quote = evidence.strip()
        if not quote:
            continue
        for chapter in chapters:
            content = chapter.content or ""
            start = content.find(quote)
            if start < 0 or (chapter.id, start) in seen:
                continue
            seen.add((chapter.id, start))
            excerpt_start = max(0, start - SOURCE_CONTEXT_CHARS)
            excerpt_end = min(len(content), start + len(quote) + SOURCE_CONTEXT_CHARS)
            sources.append(
                ConsistencySource(
                    chapter_id=chapter.id,
                    chapter_order=chapter.order,
                    chapter_title=chapter.title or "",
                    excerpt=content[excerpt_start:excerpt_end],
                    quote=quote,
                )
            )
            if len(sources) >= MAX_ISSUE_SOURCES:
                return sources
    return sources


async def _story_memory_context(
    session: AsyncSession, project_id: str, query_text: str
) -> str | None:
    """story memory 索引就绪且与当前源数据一致时返回检索片段；否则 None（走清单回退）。

    索引构建之后人物、世界设定、大纲或笔记发生变化（含 AI 可见性切换）时，
    索引内容已不能代表项目现状，此时必须退回清单资料，不能把旧片段喂给模型。
    """
    config = await get_index_settings(session)
    model = await resolve_index_embedding_model(session, config)
    if model is None:
        return None
    index_row = await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    if index_row is None or index_row.status != "ready":
        return None
    if not await story_memory_index_is_fresh(
        session, project_id=project_id, index_row=index_row
    ):
        return None

    from app.background.jobs.definitions.retrieval_chapter_index_batch import (
        _build_embedding_client,
    )

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
    if not await story_memory_index_is_fresh(
        session, project_id=project_id, index_row=index_row
    ):
        # 源数据可能在检索途中变化（人物、世界设定、大纲、笔记增删或可见性切换）。
        # 复查发现索引已 stale 时，本次检索到的旧片段不能代表项目现状，
        # 直接丢弃并退回清单资料，绝不把旧文本喂给模型。
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


def _split_chapter_block(header: str, content: str, limit: int) -> list[str]:
    """把单章切成不超过 limit 的块；正文按顺序完整保留，不丢弃字符。"""
    pieces: list[str] = []
    head = header
    remain = content
    while remain or not pieces:
        capacity = limit - len(head) - 1
        if capacity <= 0:
            # 标题本身过长时放弃标题前缀，退化为纯正文切分，仍保证不超限。
            head = ""
            capacity = limit
        body = remain[:capacity]
        pieces.append(f"{head}\n{body}" if head else body)
        remain = remain[capacity:]
        head = f"{header}（续）"
    return pieces


def _iter_chapter_blocks(chapters: list[Any], limit: int) -> list[str]:
    """按章节顺序拍平为非空正文块，保留章节标题标记，超长章节再切分。"""
    blocks: list[str] = []
    for chapter in chapters:
        content = (chapter.content or "").strip()
        if not content:
            continue
        header = f"第{chapter.order}章 {chapter.title}"
        blocks.extend(_split_chapter_block(header, content, limit))
    return blocks


def _build_scope_chunks(chapters: list[Any], limit: int) -> list[str]:
    """把选中范围正文切成有序片段，每段不超过 limit，且不丢弃任何正文字符。"""
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for block in _iter_chapter_blocks(chapters, limit):
        separator = 2 if current else 0
        if current and current_len + separator + len(block) > limit:
            chunks.append("\n\n".join(current))
            current = [block]
            current_len = len(block)
        else:
            current.append(block)
            current_len += separator + len(block)
    if current:
        chunks.append("\n\n".join(current))
    return chunks


async def _collect_scope_chapters(
    session: AsyncSession,
    *,
    project_id: str,
    scope: str,
    chapter_id: str | None,
    volume_id: str | None,
) -> tuple[list[Any], str, Any | None, str | None]:
    """按范围收集待检查章节，返回（章节列表、范围标签、锚点章节、范围卷 ID）。"""
    if scope == "chapter":
        if not chapter_id:
            raise ValidationError("请选择要检查的章节")
        chapter = await chapter_repo.get_by_id(session, chapter_id)
        if chapter is None or chapter.project_id != project_id:
            raise NotFoundError(f"章节不存在: {chapter_id}")
        return [chapter], f"第{chapter.order}章 {chapter.title}", chapter, chapter.volume_id

    if scope == "volume":
        resolved_volume_id = volume_id
        anchor: Any | None = None
        if chapter_id:
            anchor = await chapter_repo.get_by_id(session, chapter_id)
            if anchor is None or anchor.project_id != project_id:
                raise NotFoundError(f"章节不存在: {chapter_id}")
            resolved_volume_id = resolved_volume_id or anchor.volume_id
        if not resolved_volume_id:
            raise ValidationError("请选择要检查的卷")
        volume = await volume_repo.get_by_id(session, resolved_volume_id)
        if volume is None or volume.project_id != project_id:
            raise NotFoundError(f"卷不存在: {resolved_volume_id}")
        chapters = await chapter_repo.list_by_volume(session, resolved_volume_id)
        if not chapters:
            raise ValidationError("该卷暂无章节内容，无法检查")
        return chapters, f"卷：{volume.title}", anchor or chapters[0], resolved_volume_id

    chapters = await chapter_repo.list_by_project(session, project_id)
    if not chapters:
        raise ValidationError("项目暂无章节内容，无法检查")
    return chapters, "全书", chapters[0], None


async def run_consistency_check(
    session: AsyncSession,
    *,
    project_id: str,
    scope: str = "chapter",
    chapter_id: str | None = None,
    volume_id: str | None = None,
    model_id: str | None = None,
) -> ConsistencyResult:
    if scope not in VALID_SCOPES:
        raise ValidationError(f"不支持的一致性检查范围: {scope}")

    chapters, label, anchor, resolved_volume_id = await _collect_scope_chapters(
        session,
        project_id=project_id,
        scope=scope,
        chapter_id=chapter_id,
        volume_id=volume_id,
    )
    excerpt_limit = MAX_CHAPTER_EXCERPT if scope == "chapter" else MAX_SCOPE_EXCERPT
    chunks = _build_scope_chunks(chapters, excerpt_limit)
    if not chunks:
        raise ValidationError("所选范围正文为空，无法检查")

    anchor_for_query = anchor or chapters[0]
    query_text = f"{anchor_for_query.title}\n{(anchor_for_query.content or '')[:500]}"
    context = await _story_memory_context(session, project_id, query_text)
    context_source = "story_memory"
    if context is None:
        context = await _inventory_context(session, project_id)
        context_source = "inventory"

    resolved = await resolve_background_llm(
        session,
        model_policy="light_model",
        model_id=model_id,
    )
    segment_total = len(chunks)
    issues: list[ConsistencyIssue] = []

    async def analyze_segment(index: int, chunk: str) -> list[ConsistencyIssue] | None:
        messages = build_consistency_messages(
            chunk,
            context,
            scope_label=label,
            segment_index=index,
            segment_total=segment_total,
        )
        async with segment_semaphore:
            response = await resolved.client.generate(messages)
        try:
            return parse_consistency_issues(response.content)
        except ValidationError:
            return None

    segment_semaphore = asyncio.Semaphore(MAX_CONCURRENT_SCOPE_REQUESTS)
    segment_results = await asyncio.gather(
        *(
            analyze_segment(index, chunk)
            for index, chunk in enumerate(chunks, start=1)
        )
    )
    failed_segments = [
        index
        for index, segment_issues in enumerate(segment_results, start=1)
        if segment_issues is None
    ]
    if len(failed_segments) == segment_total:
        raise ValidationError("所有分段的检查结果都无法解析，请重试")
    for segment_issues in segment_results:
        if segment_issues is not None:
            issues.extend(segment_issues)
    issues = [
        replace(issue, sources=_resolve_issue_sources(issue, chapters))
        for issue in issues
    ]

    if scope == "chapter" and anchor_for_query is not None and not failed_segments:
        from app.storage.services import chapter_meta_service

        await chapter_meta_service.record_ai_check(session, anchor_for_query.id)

    return ConsistencyResult(
        scope=scope,
        label=label,
        chapter_id=anchor_for_query.id if scope == "chapter" else chapter_id,
        volume_id=resolved_volume_id,
        chapter_count=len(chapters),
        model=resolved.model.name or resolved.model.model_id,
        context_source=context_source,
        issues=issues,
        failed_segments=failed_segments,
    )


async def analyze_consistency_issue(
    session: AsyncSession,
    *,
    project_id: str,
    scope: str,
    chapter_id: str | None,
    volume_id: str | None,
    issue_type: str,
    severity: str,
    message: str,
    evidence: list[str],
    suggestion: str,
) -> ConsistencyIssueAnalysis:
    if scope not in VALID_SCOPES:
        raise ValidationError(f"不支持的一致性检查范围: {scope}")
    if not message.strip():
        raise ValidationError("待分析的问题描述为空")

    chapters, label, anchor, _resolved_volume_id = await _collect_scope_chapters(
        session,
        project_id=project_id,
        scope=scope,
        chapter_id=chapter_id,
        volume_id=volume_id,
    )
    issue = ConsistencyIssue(
        type=issue_type,
        severity=severity,
        message=message.strip()[:MAX_ISSUE_MESSAGE_CHARS],
        evidence=[item.strip()[:MAX_EVIDENCE_CHARS] for item in evidence if item.strip()][
            :MAX_EVIDENCE_PER_ISSUE
        ],
        suggestion=suggestion.strip()[:MAX_ISSUE_SUGGESTION_CHARS],
    )
    sources = _resolve_issue_sources(issue, chapters)
    source_text = "\n".join(
        f"- 第{source.chapter_order}章 {source.chapter_title}：{source.excerpt}"
        for source in sources
    )

    anchor_for_query = anchor or chapters[0]
    query_text = f"{anchor_for_query.title}\n{(anchor_for_query.content or '')[:500]}"
    context = await _story_memory_context(session, project_id, query_text)
    if context is None:
        context = await _inventory_context(session, project_id)

    resolved = await resolve_background_llm(session, model_policy="light_model")
    response = await resolved.client.generate(
        build_consistency_analysis_messages(
            scope_label=label,
            issue_type=issue.type,
            severity=issue.severity,
            message=issue.message,
            evidence=issue.evidence,
            suggestion=issue.suggestion,
            source_text=source_text,
            context_text=context,
        )
    )
    analysis = response.content.strip()[:MAX_ANALYSIS_CHARS]
    if not analysis:
        raise ValidationError("模型未返回分析内容，请重试")
    return ConsistencyIssueAnalysis(
        model=resolved.model.name or resolved.model.model_id,
        analysis=analysis,
    )
