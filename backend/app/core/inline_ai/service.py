# -*- coding: utf-8 -*-
"""Inline AI service - 内联 AI 改写服务。仅返回建议，不写入章节。"""

import re
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas.inline_ai import (
    MAX_INLINE_AI_SELECTION_CHARACTERS,
    InlineAiAction,
)
from app.audit.context import AuditContext
from app.background.llm.resolver import resolve_background_llm
from app.core.errors import NotFoundError, ValidationError
from app.core.inline_ai.prompts import build_inline_ai_messages
from app.storage.repos import chapter_repo

_CODE_FENCE_PATTERN = re.compile(r"^```[a-zA-Z0-9_-]*\n?([\s\S]*?)\n?```$", re.MULTILINE)
_QUOTE_PAIRS = (("“", "”"), ("‘", "’"), ("\"", "\""), ("'", "'"))


@dataclass(frozen=True)
class InlineAiResult:
    original: str
    result: str
    model: str
    usage: dict[str, Any] | None


def normalize_inline_ai_output(content: str) -> str:
    """去掉模型输出中常见的代码块与成对引号包装。"""
    text = content.strip()
    fence_match = _CODE_FENCE_PATTERN.match(text)
    if fence_match:
        text = fence_match.group(1).strip()
    for left, right in _QUOTE_PAIRS:
        if text.startswith(left) and text.endswith(right) and len(text) >= len(left) + len(right):
            text = text[len(left) : len(text) - len(right)].strip()
    return text


async def transform(
    session: AsyncSession,
    *,
    project_id: str,
    chapter_id: str,
    action: InlineAiAction,
    selected_text: str,
    instruction: str | None = None,
    model_id: str | None = None,
) -> InlineAiResult:
    """执行一次内联 AI 改写，返回建议文本。"""
    if not selected_text.strip():
        raise ValidationError("选中文本不能为空")
    if len(selected_text) > MAX_INLINE_AI_SELECTION_CHARACTERS:
        raise ValidationError(
            f"选中文本过长：最多 {MAX_INLINE_AI_SELECTION_CHARACTERS} 字符，"
            f"当前 {len(selected_text)} 字符"
        )
    effective_instruction = instruction.strip() if instruction else None
    if action == "custom" and not effective_instruction:
        raise ValidationError("自定义改写需要提供指令")

    chapter = await chapter_repo.get_by_id(session, chapter_id)
    if chapter is None or chapter.project_id != project_id:
        raise NotFoundError(f"章节不存在: {chapter_id}")

    resolved = await resolve_background_llm(
        session,
        model_policy="light_model",
        model_id=model_id,
    )
    messages = build_inline_ai_messages(
        action=action,
        selected_text=selected_text,
        instruction=effective_instruction,
    )
    audit_context = AuditContext(
        project_id=project_id,
        category="editor",
        chapter_id=chapter_id,
        metadata={"inline_ai_action": action},
    )
    async with audit_context.llm_call(
        operation=f"inline_ai_{action}",
        model_id=resolved.model.model_id,
        model_provider=resolved.provider.provider_type,
        model_name=resolved.model.name,
        request_messages=messages,
    ) as audit:
        response = await resolved.client.generate(messages)
        audit.record_response(content=response.content, usage=response.usage)
    result_text = normalize_inline_ai_output(response.content)
    if not result_text:
        raise ValidationError("模型未返回有效内容，请重试")

    return InlineAiResult(
        original=selected_text,
        result=result_text,
        model=resolved.model.name or resolved.model.model_id,
        usage=response.usage,
    )
