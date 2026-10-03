# -*- coding: utf-8 -*-
"""AI 模型错误详情 schema - 供 HTTP 边界返回结构化错误码。"""

from typing import Literal

from pydantic import BaseModel, Field


class AiModelUnavailableDetail(BaseModel):
    """后台模型不可用的结构化错误详情。

    前端应依据 code 判断模型配置缺失、模型或提供商已删除，
    而不是解析中文 message 文本。
    """

    code: Literal["background_model_unavailable"] = Field(
        default="background_model_unavailable",
        description="稳定的机器可读错误码。",
    )
    message: str = Field(description="面向用户的错误说明。")
