"""Markdown 导出中生成标题的格式化；正文由现有文本写入循环保留。"""

import re
from string import punctuation
from typing import Literal


MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8"


def format_heading(title: str, *, level: Literal[1, 2]) -> str:
    """将标题作为单行字面文本写入 ATX 标题，并与正文留出空行。"""
    single_line = re.sub(r"[\r\n]+", " ", title)
    escaped = "".join(f"\\{character}" if character in punctuation else character for character in single_line)
    return f"{'#' * level} {escaped}\n\n"
