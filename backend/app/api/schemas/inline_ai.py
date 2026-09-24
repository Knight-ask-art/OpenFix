# -*- coding: utf-8 -*-
"""Inline AI schemas - 编辑器内联 AI 改写请求与响应。"""

from typing import Any, Literal

from pydantic import BaseModel, Field

InlineAiAction = Literal[
    "polish",
    "rewrite",
    "expand",
    "shorten",
    "dialogue",
    "description",
    "emotion",
    "pacing",
    "grammar",
    "custom",
]

MAX_INLINE_AI_SELECTION_CHARACTERS = 8_000


class InlineAiTransformRequest(BaseModel):
    """内联 AI 改写请求。"""

    project_id: str = Field(min_length=1)
    chapter_id: str = Field(min_length=1)
    action: InlineAiAction
    selected_text: str = Field(min_length=1, max_length=MAX_INLINE_AI_SELECTION_CHARACTERS)
    instruction: str | None = Field(default=None, max_length=2_000)
    model_id: str | None = None


class InlineAiTransformResponse(BaseModel):
    """内联 AI 改写结果。仅返回建议，不修改章节正文。"""

    original: str
    result: str
    model: str
    usage: dict[str, Any] | None = None
