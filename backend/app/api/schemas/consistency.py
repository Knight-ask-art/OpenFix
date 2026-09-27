# -*- coding: utf-8 -*-
"""Consistency schemas - 一致性检查 API 数据模型。"""

from typing import Literal

from pydantic import BaseModel, Field


class ConsistencyCheckRequest(BaseModel):
    """发起一致性检查。"""

    chapter_id: str = Field(min_length=1)
    model_id: str | None = None


class ConsistencyIssueResponse(BaseModel):
    type: str
    severity: Literal["info", "warning", "high"]
    message: str
    evidence: list[str] = Field(default_factory=list)
    suggestion: str = ""


class ConsistencyCheckResponse(BaseModel):
    chapter_id: str
    model: str
    context_source: Literal["story_memory", "inventory"]
    issues: list[ConsistencyIssueResponse]
