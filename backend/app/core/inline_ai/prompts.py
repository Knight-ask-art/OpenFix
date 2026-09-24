# -*- coding: utf-8 -*-
"""Inline AI prompts - 内联 AI 各动作的提示词构建。"""

from app.api.schemas.inline_ai import InlineAiAction

BASE_SYSTEM_PROMPT = (
    "你是一名中文长篇小说写作助手，服务于编辑器内的选中文本改写。"
    "规则：\n"
    "1. 只输出改写后的文本本身，不要解释、不要前后缀、不要使用代码块包裹。\n"
    "2. 保持原文的叙述视角、时态与人称，不引入原文没有的新情节。\n"
    "3. 保持与原文相同的语言（中文原文输出中文，英文原文输出英文）。"
)

ACTION_SYSTEM_PROMPTS: dict[InlineAiAction, str] = {
    "polish": "动作：润色。在不改变含义的前提下提升表达质量，修正生硬措辞。",
    "rewrite": "动作：改写。用不同的表达方式重写选中文本，保留原意。",
    "expand": "动作：扩写。在保留核心情节的前提下丰富细节、描写或心理活动。",
    "shorten": "动作：精简。压缩选中文本，去掉冗余，保留关键信息。",
    "dialogue": "动作：增强对话。让对话更自然、更有角色个性，必要时补充少量动作描写。",
    "description": "动作：增强画面。加强场景、动作或外貌描写的画面感。",
    "emotion": "动作：增强情绪。强化选中文本中的情绪张力，但避免夸张失真。",
    "pacing": "动作：调整节奏。让叙述张弛更合理，紧张处更紧凑，舒缓处更从容。",
    "grammar": "动作：修复语病。修正语法、错别字与标点问题，尽量不改动风格。",
    "custom": "动作：按用户给出的额外要求改写选中文本。",
}


def build_inline_ai_messages(
    *,
    action: InlineAiAction,
    selected_text: str,
    instruction: str | None = None,
) -> list[dict[str, str]]:
    """构建内联 AI 改写的聊天消息。"""
    system_parts = [BASE_SYSTEM_PROMPT, ACTION_SYSTEM_PROMPTS[action]]
    if action == "custom" and instruction:
        system_parts.append(f"额外要求：{instruction.strip()}")

    user_parts = ["请改写以下选中文本：", "", selected_text]
    if action != "custom" and instruction:
        user_parts.extend(["", f"额外要求：{instruction.strip()}"])

    return [
        {"role": "system", "content": "\n".join(system_parts)},
        {"role": "user", "content": "\n".join(user_parts)},
    ]
