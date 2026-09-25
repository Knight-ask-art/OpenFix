"""章节导出 API 数据模型。"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


class ChapterExportCreate(BaseModel):
    """创建章节导出任务。"""

    selected_volume_ids: list[str] = Field(default_factory=list)
    included_chapter_ids: list[str] = Field(default_factory=list)
    excluded_chapter_ids: list[str] = Field(default_factory=list)
    local_date: date
    format: Literal["txt", "docx"] = "txt"


class ChapterExportResponse(BaseModel):
    """章节导出任务状态。"""

    id: str
    status: str
    filename: str
    mode: str
    format: str = "txt"
    volume_count: int
    chapter_count: int
    word_count: int
    chapter_ids: list[str]
    current: int = 0
    total: int = 0
    stage: str | None = None
    chapter_title: str | None = None
    expires_at: datetime | None = None
    download_url: str | None = None
    error_message: str | None = None
