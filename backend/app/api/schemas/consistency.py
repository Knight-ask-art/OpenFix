# -*- coding: utf-8 -*-
"""Consistency schemas - 一致性检查 API 数据模型。"""

from typing import Literal

from pydantic import BaseModel, Field


class ConsistencyCheckRequest(BaseModel):
    """发起一致性检查。"""

    scope: Literal["chapter", "volume", "book"] = Field(
        default="chapter", description="检查范围：当前章节 / 当前卷 / 全书"
    )
    chapter_id: str | None = Field(
        default=None, description="章节范围必填；卷范围可作为定位锚点"
    )
    volume_id: str | None = Field(default=None, description="卷范围可显式指定卷")
    model_id: str | None = None


class ConsistencySourceResponse(BaseModel):
    chapter_id: str
    chapter_order: int
    chapter_title: str
    excerpt: str
    quote: str


class ConsistencyIssueResponse(BaseModel):
    type: str
    severity: Literal["info", "warning", "high"]
    message: str
    evidence: list[str] = Field(default_factory=list)
    suggestion: str = ""
    sources: list[ConsistencySourceResponse] = Field(default_factory=list)


class ConsistencyIssueAnalysisInput(BaseModel):
    type: str = Field(max_length=50)
    severity: Literal["info", "warning", "high"]
    message: str = Field(min_length=1, max_length=500)
    evidence: list[str] = Field(default_factory=list, max_length=3)
    suggestion: str = Field(default="", max_length=1_000)


class ConsistencyIssueAnalysisRequest(BaseModel):
    scope: Literal["chapter", "volume", "book"]
    chapter_id: str | None = None
    volume_id: str | None = None
    issue: ConsistencyIssueAnalysisInput


class ConsistencyIssueAnalysisResponse(BaseModel):
    model: str
    analysis: str


class ConsistencyCheckResponse(BaseModel):
    scope: Literal["chapter", "volume", "book"]
    label: str
    chapter_id: str | None = None
    volume_id: str | None = None
    chapter_count: int
    model: str
    context_source: Literal["story_memory", "inventory"]
    issues: list[ConsistencyIssueResponse]
    failed_segments: list[int] = Field(default_factory=list)
