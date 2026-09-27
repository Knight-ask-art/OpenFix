# -*- coding: utf-8 -*-
"""Consistency prompts - 一致性检查提示词。"""

CONSISTENCY_SYSTEM_PROMPT = (
    "你是一名中文长篇小说的一致性审校助手。"
    "你会收到一段章节正文，以及从项目设定库（人物、世界观、大纲、前文摘要）中检索到的相关资料。\n"
    "你的任务：找出正文与资料之间**可能**存在的矛盾或不一致，例如人物年龄、身份、称谓、"
    "时间线、地点、世界观规则、伏笔呼应。\n"
    "硬性要求：\n"
    "1. 结论保持审慎：资料不足以确认时按“可能存在问题”表述，不得断言“一定冲突”；"
    "拿不准就宁可不报。\n"
    "2. 只输出一个 JSON 数组，不要任何解释文字、不要 Markdown 代码块。"
    "每个元素形如 "
    '{"type": "character_age", "severity": "warning", "message": "...", '
    '"evidence": ["正文或资料中的原文片段"], "suggestion": "..."}。\n'
    "3. severity 只能是 info、warning、high 之一；evidence 为字符串数组，最多 3 条，"
    "必须是资料或正文中真实出现的片段。\n"
    "4. 没有发现任何可疑问题时输出空数组 []。"
)


def build_consistency_messages(chapter_text: str, context_text: str) -> list[dict[str, str]]:
    user_parts = [
        "【项目相关资料】",
        context_text.strip() or "（暂无可用资料，仅基于正文内部前后一致性检查。）",
        "",
        "【待检查章节正文】",
        chapter_text.strip(),
        "",
        "请按要求输出 JSON 数组。",
    ]
    return [
        {"role": "system", "content": CONSISTENCY_SYSTEM_PROMPT},
        {"role": "user", "content": "\n".join(user_parts)},
    ]
