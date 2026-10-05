# -*- coding: utf-8 -*-
"""Outline AI schemas - 大纲 AI 动作的请求与响应。

所有接口只返回候选内容，不写入任何项目 / 大纲数据；
用户确认后才由前端调用既有大纲 API 落库（PRD §14、AGENTS 第 10 条）。
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

OutlineAiLevel = Literal["book", "arc", "volume", "chapter"]
OutlineAiSeverity = Literal["info", "warning", "high"]

MAX_OUTLINE_AI_TITLE_CHARS = 200
MAX_OUTLINE_AI_CONTENT_CHARS = 48_000
MAX_OUTLINE_AI_INSTRUCTION_CHARS = 2_000
MAX_OUTLINE_AI_NOTE_CHARS = 600
MAX_OUTLINE_AI_SUMMARY_CHARS = 1_200
MAX_OUTLINE_AI_SPLIT_ITEMS = 20
MAX_OUTLINE_AI_ISSUES = 12
MAX_OUTLINE_AI_ISSUE_MESSAGE_CHARS = 500
MAX_OUTLINE_AI_ISSUE_SUGGESTION_CHARS = 800
MAX_OUTLINE_AI_EVIDENCE_PER_ISSUE = 3
MAX_OUTLINE_AI_EVIDENCE_CHARS = 200
MAX_OUTLINE_AI_BOOK_OUTLINE_NODES = 200
MAX_OUTLINE_AI_BOOK_OUTLINE_CHARS = 24_000


class OutlineAiDraftRequest(BaseModel):
    """完善大纲：对已有节点或尚未保存的草稿生成候选标题与内容。"""

    outline_id: str | None = Field(
        default=None, description="要完善的大纲节点 ID；为空时使用请求里的 level/title/content 草稿。"
    )
    level: OutlineAiLevel = Field(default="book", description="草稿节点层级，仅在 outline_id 为空时使用。")
    title: str = Field(default="", max_length=MAX_OUTLINE_AI_TITLE_CHARS)
    content: str = Field(default="", max_length=MAX_OUTLINE_AI_CONTENT_CHARS)
    instruction: str | None = Field(
        default=None, max_length=MAX_OUTLINE_AI_INSTRUCTION_CHARS, description="可选：额外创作要求。"
    )
    model_id: str | None = Field(default=None, description="可选：指定模型 ID。")


class OutlineAiPacingRequest(BaseModel):
    """检查节奏：对单个节点或整本书大纲给出节奏风险提示。"""

    outline_id: str | None = Field(default=None, description="scope=node 时要检查的大纲节点。")
    scope: Literal["node", "book"] = Field(default="book", description="检查范围。")
    model_id: str | None = Field(default=None, description="可选：指定模型 ID。")


class OutlineAiSplitRequest(BaseModel):
    """拆分章节：把一个大纲节点拆成候选章节大纲。"""

    outline_id: str = Field(description="要拆分的大纲节点 ID。")
    max_chapters: int = Field(
        default=8, ge=1, le=MAX_OUTLINE_AI_SPLIT_ITEMS, description="候选章节数量上限。"
    )
    instruction: str | None = Field(
        default=None, max_length=MAX_OUTLINE_AI_INSTRUCTION_CHARS, description="可选：额外拆分要求。"
    )
    model_id: str | None = Field(default=None, description="可选：指定模型 ID。")


class OutlineAiUpdateFromChapterRequest(BaseModel):
    """根据正文更新大纲：用章节正文推出候选大纲内容。"""

    outline_id: str = Field(description="要更新的大纲节点 ID。")
    chapter_id: str | None = Field(
        default=None, description="参考章节 ID；为空时使用大纲节点已关联的章节。"
    )
    instruction: str | None = Field(
        default=None, max_length=MAX_OUTLINE_AI_INSTRUCTION_CHARS, description="可选：额外要求。"
    )
    model_id: str | None = Field(default=None, description="可选：指定模型 ID。")


class OutlineAiDraftResponse(BaseModel):
    """候选大纲内容。仅返回建议，不写入任何数据。"""

    title: str = Field(default="", max_length=MAX_OUTLINE_AI_TITLE_CHARS)
    content: str = Field(default="", max_length=MAX_OUTLINE_AI_CONTENT_CHARS)
    notes: str | None = Field(default=None, max_length=MAX_OUTLINE_AI_NOTE_CHARS)
    model: str
    usage: dict[str, Any] | None = None


class OutlineAiIssue(BaseModel):
    """节奏问题提示。措辞保持审慎，不代表确定结论。"""

    severity: OutlineAiSeverity = "warning"
    message: str = Field(max_length=MAX_OUTLINE_AI_ISSUE_MESSAGE_CHARS)
    evidence: list[str] = Field(default_factory=list)
    suggestion: str = Field(default="", max_length=MAX_OUTLINE_AI_ISSUE_SUGGESTION_CHARS)


class OutlineAiPacingResponse(BaseModel):
    """节奏检查结果。仅返回建议，不写入任何数据。"""

    summary: str = Field(default="", max_length=MAX_OUTLINE_AI_SUMMARY_CHARS)
    issues: list[OutlineAiIssue] = Field(default_factory=list)
    model: str
    usage: dict[str, Any] | None = None


class OutlineAiSplitItem(BaseModel):
    """候选章节大纲条目。"""

    title: str = Field(default="", max_length=MAX_OUTLINE_AI_TITLE_CHARS)
    content: str = Field(default="", max_length=MAX_OUTLINE_AI_CONTENT_CHARS)


class OutlineAiSplitResponse(BaseModel):
    """章节拆分候选结果。仅返回建议，不写入任何数据。"""

    items: list[OutlineAiSplitItem] = Field(default_factory=list)
    model: str
    usage: dict[str, Any] | None = None
