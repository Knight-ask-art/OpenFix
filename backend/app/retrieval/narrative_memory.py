# -*- coding: utf-8 -*-
"""Narrative Engine 叙事来源在 Story Memory 中的序列化与可用性判定。

世界事实 / 人物信念 / 情节线 / 场景计划四类叙事行，和人物、世界设定、大纲、
笔记一样，最终由 `app.retrieval.story_memory` 索引进同一个 Story Memory 索引，
查询仍然走既有 `OpenFicRetrievalService` 与同一套 contract，不新建第二套 RAG。

本模块只有两项纯函数职责，不接触数据库、不接触检索引擎：

1. 判定一行叙事记录在**默认检索**下是否可用；
2. 把一行叙事记录渲染成带显式语义标注的检索文本。

两条硬约束：

* **世界事实与人物信念必须显式区分。** 已确认的信念依然是信念：
  `belief_state="mistaken"` 与 `confirmation="confirmed"` 是合法组合，
  这条记录绝不能在序列化时被写成世界事实。
* **场景的隐藏信息只属于作者。** 它必须带明确的作者可见标注，不得与
  「本场已知信息」混排，也不得被当成视角人物的已知信息。

默认检索排除规则（未确认 / 已作废的记录不进入模型上下文）：

* `confirmation` 为 `candidate` / `inferred` / `rejected` 的一律排除；
* 世界事实 `status="retired"` 或已被取代（`superseded_by_id`）的排除；
* 人物信念已被取代（`superseded_by_id`）或已失效（`invalidated_at`）的排除；
* 情节线已 `resolved` / `abandoned` 的排除（本来源即「未兑现的情节线」）。
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

NARRATIVE_SOURCES: tuple[str, ...] = (
    "world_fact",
    "character_belief",
    "open_plotline",
    "scene_state",
)

NARRATIVE_SOURCE_LABELS: dict[str, str] = {
    "world_fact": "世界事实",
    "character_belief": "人物信念",
    "open_plotline": "情节线",
    "scene_state": "场景计划",
}

# 未经过人工确认的确认状态：默认检索必须排除。
UNCONFIRMED_STATES: tuple[str, ...] = ("candidate", "inferred", "rejected")

CONFIRMED_STATE = "confirmed"

# 情节线中「义务已了结」的状态，不再作为未兑现情节线进入检索。
CLOSED_PLOTLINE_STATES: tuple[str, ...] = ("resolved", "abandoned")

WORLD_FACT_STATUS_LABELS: dict[str, str] = {
    "confirmed": "成立",
    "uncertain": "不确定",
    "contradicted": "存在矛盾",
    "retired": "已作废",
}

BELIEF_STATE_LABELS: dict[str, str] = {
    "known": "确信",
    "believed": "相信",
    "suspected": "怀疑",
    "unknown": "并不知情",
    "mistaken": "误解（所信与事实不符）",
}

PLOTLINE_STATE_LABELS: dict[str, str] = {
    "open": "未展开",
    "progressing": "推进中",
    "resolved": "已了结",
    "abandoned": "已放弃",
    "uncertain": "走向未定",
}

SOURCE_TYPE_LABELS: dict[str, str] = {
    "user": "作者录入",
    "chapter": "章节正文",
    "agent": "Agent 提议",
    "inference": "系统推断",
    "outline": "大纲",
    "world_info": "世界设定",
    "character_profile": "人物档案",
}

# 单条叙事文本与溯源信息的长度上限：避免把整段正文或长引文塞进上下文。
MAX_FIELD_CHARS = 600
MAX_ANCHOR_CHARS = 120

# 标注语气必须明确，后面会被拼进模型上下文。
WORLD_TRUTH_MARKER = "世界事实（故事世界成立的断言，不是人物主观看法）"
BELIEF_MARKER = "人物信念（人物主观认知，未必为真，不得当作世界事实）"
SCENE_AUTHOR_ONLY_MARKER = "仅作者可见信息（不得当作视角人物已知，不得写入人物认知）"


def _clip(value: Any, limit: int = MAX_FIELD_CHARS) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def _string_list(raw: Any) -> list[str]:
    """读取字符串列表：兼容已解析的列表与数据库里的 JSON 文本列。"""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, ValueError):
            return []
    if not isinstance(raw, list):
        return []
    return [_clip(item) for item in raw if isinstance(item, str) and item.strip()]


def _string_list_field(row: Any, name: str) -> list[str]:
    """读取场景计划里的字符串列表字段。

    ORM 行暴露的是 `*_json` 文本列，接口视图对象暴露的是已解析的列表，
    两种形态都要能渲染，避免序列化逻辑分叉。
    """
    if hasattr(row, name):
        return _string_list(getattr(row, name))
    return _string_list(getattr(row, f"{name}_json", None))


def format_source_token(updated_at: datetime | None, *flags: Any) -> str:
    """构造一条便宜的内容变更令牌。

    令牌只依赖 `updated_at` 与**影响可用性**的少量标志位，因此既能精确捕捉
    正文改动（写入路径都会推进 `updated_at`），也能捕捉可见性 / 确认状态切换，
    又不需要读取正文本身。字符串形式保证同一行在不同进程、不同查询里一致。
    """
    stamp = updated_at.isoformat() if isinstance(updated_at, datetime) else ""
    return "|".join([stamp, *(str(flag) for flag in flags)])


# --- 默认可用性判定 ---------------------------------------------------------
#
# 参数一律用原始字段值，既可以被 ORM 行调用，也可以被只取少量列的投影查询调用，
# 避免「文档构建」与「指纹计算」两条路径对同一行给出不同结论。


def world_fact_is_retrievable(
    *, confirmation: Any, status: Any, superseded_by_id: Any
) -> bool:
    """世界事实在本来源下的默认可检索性。"""
    if confirmation != CONFIRMED_STATE:
        return False
    if status == "retired":
        return False
    return not superseded_by_id


def character_belief_is_retrievable(
    *, confirmation: Any, superseded_by_id: Any, invalidated_at: Any
) -> bool:
    """人物信念在本来源下的默认可检索性。

    注意：`belief_state="mistaken"` 不影响可用性。已确认的误解依然是
    一条有效的人物信念，只是序列化时必须标注为「人物所信」。
    """
    if confirmation != CONFIRMED_STATE:
        return False
    if superseded_by_id or invalidated_at:
        return False
    return True


def plotline_is_retrievable(*, confirmation: Any, state: Any) -> bool:
    """未兑现情节线在本来源下的默认可检索性。"""
    if confirmation != CONFIRMED_STATE:
        return False
    return state not in CLOSED_PLOTLINE_STATES


def scene_plan_is_retrievable(*, confirmation: Any) -> bool:
    """场景计划的默认可检索性。"""
    return confirmation == CONFIRMED_STATE


# --- 序列化 -----------------------------------------------------------------


def _provenance_line(row: Any) -> str:
    """有界溯源信息：来源类型、置信度与截断后的定位锚点。"""
    parts: list[str] = []
    source_type = str(getattr(row, "source_type", "") or "")
    if source_type:
        parts.append(f"来源={SOURCE_TYPE_LABELS.get(source_type, source_type)}")
    confidence = getattr(row, "confidence", None)
    if isinstance(confidence, (int, float)):
        parts.append(f"置信度={float(confidence):.2f}")
    anchor = _clip(getattr(row, "quote_anchor", ""), MAX_ANCHOR_CHARS)
    if anchor:
        parts.append(f'锚点="{anchor}"')
    if not parts:
        return ""
    return "溯源：" + "；".join(parts)


def _append(lines: list[str], label: str, value: Any) -> None:
    text = _clip(value)
    if text:
        lines.append(f"{label}：{text}")


def _append_block(lines: list[str], label: str, values: list[str]) -> None:
    if not values:
        return
    lines.append(f"{label}：")
    lines.extend(f"- {item}" for item in values)


def render_world_fact(row: Any) -> str:
    """渲染一条世界事实，语义标注为「故事世界成立的断言」。"""
    lines = [WORLD_TRUTH_MARKER]
    _append(lines, "陈述", row.statement)
    _append(lines, "主体", row.subject_ref)
    status = str(getattr(row, "status", "") or "")
    if status:
        lines.append(f"成立状态：{WORLD_FACT_STATUS_LABELS.get(status, status)}")
    provenance = _provenance_line(row)
    if provenance:
        lines.append(provenance)
    return "\n".join(lines)


def render_character_belief(row: Any, character_name: str | None = None) -> str:
    """渲染一条人物信念，语义标注为「人物主观认知」。"""
    lines = [BELIEF_MARKER]
    holder = _clip(character_name, 200) or "某个人物"
    _append(lines, "人物", holder)
    _append(lines, "信念", row.proposition)
    belief_state = str(getattr(row, "belief_state", "") or "")
    if belief_state:
        lines.append(f"把握程度：{BELIEF_STATE_LABELS.get(belief_state, belief_state)}")
    if getattr(row, "learned_at_chapter_id", None):
        lines.append("得知于：该人物在某一章中获知（见来源章节）")
    provenance = _provenance_line(row)
    if provenance:
        lines.append(provenance)
    return "\n".join(lines)


def render_plotline(row: Any) -> str:
    """渲染一条未兑现的情节线。"""
    lines = ["情节线（尚未兑现的叙事义务）"]
    _append(lines, "标题", row.title)
    _append(lines, "当前悬念", row.current_question)
    _append(lines, "预期兑现", row.payoff)
    _append(lines, "说明", row.description)
    state = str(getattr(row, "state", "") or "")
    if state:
        lines.append(f"状态：{PLOTLINE_STATE_LABELS.get(state, state)}")
    provenance = _provenance_line(row)
    if provenance:
        lines.append(provenance)
    return "\n".join(lines)


def render_scene_plan(
    row: Any,
    *,
    chapter_title: str | None = None,
    pov_character_name: str | None = None,
) -> str:
    """渲染一个场景计划。

    「本场已知信息」与「仅作者可见信息」分成两个互不重叠的区块：隐藏信息
    永远带作者可见标注，不会被混进已知信息，也就不会被当成视角人物的认知。
    """
    lines = ["场景计划（作者视角的场景准备，含仅作者可见信息）"]
    chapter_label = _clip(chapter_title, 200)
    scene_index = getattr(row, "scene_index", None)
    if chapter_label or isinstance(scene_index, int):
        lines.append(
            "章节/场次："
            + " ".join(
                part
                for part in (
                    chapter_label,
                    f"第{scene_index + 1}场" if isinstance(scene_index, int) else "",
                )
                if part
            )
        )
    pov = _clip(pov_character_name, 200)
    if pov:
        lines.append(f"视角人物：{pov}")
    _append(lines, "地点", row.location)
    _append(lines, "基调", row.tone)
    _append(lines, "场景目标", row.goal)
    _append_block(
        lines,
        "本场已知信息（视角人物与读者已知）",
        _string_list_field(row, "known_information"),
    )
    _append_block(
        lines,
        SCENE_AUTHOR_ONLY_MARKER,
        _string_list_field(row, "hidden_information"),
    )
    _append_block(
        lines, "场面约束", _string_list_field(row, "world_constraints")
    )
    provenance = _provenance_line(row)
    if provenance:
        lines.append(provenance)
    return "\n".join(lines)


def narrative_document_title(source: str, row: Any) -> str:
    """检索结果里的短标题；只用于展示，不承载语义标注。"""
    if source == "world_fact":
        return _clip(row.statement, 80)
    if source == "character_belief":
        return _clip(row.proposition, 80)
    if source == "open_plotline":
        return _clip(row.title, 80)
    if source == "scene_state":
        return _clip(getattr(row, "goal", ""), 80) or "场景计划"
    return ""


__all__ = [
    "BELIEF_MARKER",
    "BELIEF_STATE_LABELS",
    "CLOSED_PLOTLINE_STATES",
    "CONFIRMED_STATE",
    "MAX_ANCHOR_CHARS",
    "MAX_FIELD_CHARS",
    "NARRATIVE_SOURCES",
    "NARRATIVE_SOURCE_LABELS",
    "PLOTLINE_STATE_LABELS",
    "SCENE_AUTHOR_ONLY_MARKER",
    "SOURCE_TYPE_LABELS",
    "UNCONFIRMED_STATES",
    "WORLD_FACT_STATUS_LABELS",
    "WORLD_TRUTH_MARKER",
    "character_belief_is_retrievable",
    "format_source_token",
    "narrative_document_title",
    "plotline_is_retrievable",
    "render_character_belief",
    "render_plotline",
    "render_scene_plan",
    "render_world_fact",
    "scene_plan_is_retrievable",
    "world_fact_is_retrievable",
]
