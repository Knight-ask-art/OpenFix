# -*- coding: utf-8 -*-
"""有界、只读的人物状态 opt-in 输出。

只输出人物名、静态档案、请求锚点及锚点前最近一条已保存的章级状态；章节之后
的状态、项目级常设状态、人物信念与世界事实都不读取。字段与描述只做「整项
输出 / 整项省略」，空字段进 unknown_fields，预算省略进 omitted_fields。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.core.utils.tiktoken import count_tokens

MAX_CONTEXT_CHARS = 6_000
MAX_CONTEXT_TOKENS = 2_500
MAX_NAME_CHARS = 80
MAX_TITLE_CHARS = 60

PRIOR_SOURCE_NOTE = "最近记录，非本章新确认"
PROJECT_STATE_NOTE = "项目级常设状态没有章节来源，不作为历史证据。"
DESCRIPTION_OMITTED_NOTE = "描述超出读取预算未列出；不是历史状态证据。"
SEPARATE_TOOLS: dict[str, str] = {
    "character_beliefs": "read_narrative_state",
    "world_facts": "read_narrative_state",
}
STATE_FIELD_ORDER: tuple[str, ...] = (
    "physical_state", "location", "mental_state", "goal", "relationship_note", "notes",
)
REF_KEYS = ("chapter_id", "chapter_label", "chapter_order", "volume_id", "volume_order", "chapter_title")


@dataclass(frozen=True)
class ChapterAnchor:
    """请求的章节锚点；由工具层用现有 chapter ref 解析后传入。"""

    chapter_id: str
    chapter_title: str
    chapter_order: int
    volume_id: str
    volume_title: str
    volume_order: int

    @property
    def label(self) -> str:
        return _label(self)


@dataclass(frozen=True)
class StateAtAnchor(ChapterAnchor):
    """锚点及之前最近一条已保存状态；来源章节 / 卷复用锚点字段。"""

    state: Any


def _label(item: ChapterAnchor) -> str:
    title, _ = _safe_title(item.chapter_title)
    label = f"第{item.volume_order}卷第{item.chapter_order}章"
    return f"{label} {title}" if title else label


def _safe_title(value: Any) -> tuple[str | None, bool]:
    """标题过长时整项省略并标记，不做半截截断。"""
    text = " ".join(str(value or "").split())
    if not text:
        return None, False
    if len(text) <= MAX_TITLE_CHARS:
        return text, False
    return None, True


def _scope(item: ChapterAnchor) -> dict[str, Any]:
    """完整定位；超长标题整项省略并标记，其余 ID / 卷序 / 章序始终保留。"""
    chapter_title, chapter_omitted = _safe_title(item.chapter_title)
    volume_title, volume_omitted = _safe_title(item.volume_title)
    scope: dict[str, Any] = {
        "chapter_id": str(item.chapter_id or ""),
        "chapter_label": _label(item),
        "chapter_order": int(item.chapter_order),
        "volume_id": str(item.volume_id or ""),
        "volume_order": int(item.volume_order),
    }
    if chapter_title:
        scope["chapter_title"] = chapter_title
    if volume_title:
        scope["volume_title"] = volume_title
    if chapter_omitted or volume_omitted:
        scope["title_omitted"] = True
    return scope


def _measure(payload: dict[str, Any], token_counter: Callable[[str], int]) -> tuple[str, int, int]:
    """把最终序列化长度回写 budget；数字宽度稳定后返回精确文本与计数。"""
    budget = payload["state_context"]["budget"]
    for _ in range(6):
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        chars, tokens = len(text), token_counter(text)
        if budget["chars"] == chars and budget["tokens"] == tokens:
            return text, chars, tokens
        budget["chars"], budget["tokens"] = chars, tokens
    return text, chars, tokens


def render_character_state_context(
    *,
    character_id: str,
    character_name: str,
    description: str = "",
    chapter_source: StateAtAnchor | None,
    anchor: ChapterAnchor | None,
    state_requested: bool = False,
    token_counter: Callable[[str], int] | None = None,
) -> str:
    """渲染整份 opt-in JSON，并保证字符数与 token 数都不超过固定上限。

    ``chapter_source`` 必须是 repo 按锚点查出的「锚点及之前最近一条」。元数据
    先完整装入，再按整项大小从大到小移除描述 / 状态字段，直到最终序列化结果
    真正装入上限；每次测量都包含完整元数据，因此不会因事后追加而越界。
    """
    count = token_counter or count_tokens

    name_text = str(character_name or "")
    name_omitted = len(name_text) > MAX_NAME_CHARS
    if name_omitted:
        name_text = ""

    state = chapter_source.state if chapter_source is not None and anchor is not None else None
    texts = {
        field: str(getattr(state, field, "") or "").strip() for field in STATE_FIELD_ORDER
    } if state is not None else {}
    admitted = {field: text for field, text in texts.items() if text}
    unknown_fields = (
        [field for field in STATE_FIELD_ORDER if not texts.get(field)]
        if state is not None
        else []
    )

    profile = str(description or "").strip()
    include_profile = bool(profile)
    profile_omitted = False

    anchor_scope = _scope(anchor) if anchor is not None else None
    source_scope = _scope(chapter_source) if chapter_source is not None else None
    title_omitted = bool((anchor_scope or {}).get("title_omitted"))
    notes = [PROJECT_STATE_NOTE]
    chapter_state: dict[str, Any] | None = None
    if anchor is not None and chapter_source is not None:
        assert source_scope is not None and anchor_scope is not None
        title_omitted = title_omitted or bool(source_scope.get("title_omitted"))
        exact = chapter_source.chapter_id == anchor.chapter_id
        chapter_state = {
            "source": "character_state",
            "time_applicability": "chapter",
            "state_id": str(getattr(chapter_source.state, "id", "") or ""),
            "is_exact_anchor": exact,
            **source_scope,
            "requested_anchor": {key: anchor_scope[key] for key in REF_KEYS if key in anchor_scope},
            "provenance_note": (
                "本章已保存记录。"
                if exact
                else f"{PRIOR_SOURCE_NOTE}：该状态来自 {chapter_source.label}，"
                f"不是 {anchor.label} 新确认的内容。"
            ),
            "fields": admitted,
            "unknown_fields": unknown_fields,
            "omitted_fields": [],
        }
        if not exact:
            notes.append(
                f"{anchor.label} 无本章状态；显示 {chapter_source.label} 的{PRIOR_SOURCE_NOTE}。"
            )
    elif anchor is not None:
        notes.append(
            f"{anchor.label} 的章级状态：未记录；锚点及之前没有已保存记录，"
            "后续章节与项目级状态不会代替。"
        )
    else:
        notes.append("未提供章节锚点，章级状态未知，不会用其他章节的状态代替。")

    while True:
        omitted = chapter_state["omitted_fields"] if chapter_state is not None else []
        truncated = bool(omitted) or profile_omitted or name_omitted or title_omitted
        if chapter_source is None and (anchor is not None or state_requested):
            status = "no_records"
        else:
            status = "truncated" if truncated else "ok"
        payload: dict[str, Any] = {
            "name": None if name_omitted else name_text,
            "description": profile if include_profile else None,
            "description_kind": "static_profile",
            "state_context": {
                "character_id": str(character_id or ""),
                "status": status,
                "scope": anchor_scope,
                "chapter_state": chapter_state,
                "unknowns": [*notes, *([DESCRIPTION_OMITTED_NOTE] if profile_omitted else [])],
                "separate_tools": dict(SEPARATE_TOOLS),
                "budget": {
                    "max_chars": MAX_CONTEXT_CHARS,
                    "max_tokens": MAX_CONTEXT_TOKENS,
                    "chars": 0,
                    "tokens": 0,
                    "truncated": truncated,
                },
            },
        }
        if name_omitted:
            payload["name_omitted"] = True
        if profile_omitted:
            payload["description_omitted"] = True
        text, chars, tokens = _measure(payload, count)
        if chars <= MAX_CONTEXT_CHARS and tokens <= MAX_CONTEXT_TOKENS:
            return text
        candidates = [(len(profile), "description")] if include_profile else []
        candidates.extend((len(value), field) for field, value in admitted.items())
        if not candidates:
            raise ValueError("character state metadata exceeds read budget")
        _, victim = max(candidates)
        if victim == "description":
            include_profile = False
            profile_omitted = True
        else:
            del admitted[victim]
            if chapter_state is not None:
                chapter_state["omitted_fields"].append(victim)


async def build_character_state_context(
    session: Any,
    *,
    project_id: str,
    character: Any,
    description: str = "",
    anchor: ChapterAnchor | None = None,
    state_requested: bool = False,
    token_counter: Callable[[str], int] | None = None,
) -> str:
    """按项目 / 角色 / 锚点读取最近一条章级状态并渲染为有界 opt-in JSON。"""
    from app.storage.repos import character_extension_repo

    if str(getattr(character, "project_id", "")) != project_id:
        raise ValueError("人物不属于当前项目，拒绝读取状态")

    character_id = str(character.id)
    chapter_source = None
    if anchor is not None:
        chapter_source = await character_extension_repo.get_latest_state_at_anchor(
            session, project_id=project_id, character_id=character_id,
            volume_order=anchor.volume_order, chapter_order=anchor.chapter_order,
        )
    return render_character_state_context(
        character_id=character_id, character_name=str(character.name),
        description=description, chapter_source=chapter_source, anchor=anchor,
        state_requested=state_requested, token_counter=token_counter,
    )
