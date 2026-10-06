# -*- coding: utf-8 -*-
"""Narrative state reader - 读取「已确认」的结构化叙事状态，供一致性检查等只读用途。

Narrative Engine 的四张扩展表（世界事实 / 人物信念 / 情节线 / 场景计划）同时保存
候选与已确认的叙事状态。一致性检查只应该看到**人工确认过**的那部分，并且必须严格
区分两条正交的轴（见 `docs/narrative-engine-v1-audit.md` §6）：

* 世界事实描述「故事世界中成立的断言」；
* 人物信念描述「某个人物相信的命题」，它可以是错的（mistaken），也可以是
  「不知道」（unknown），绝不能当作世界事实。

读取约束：

* 只按 `project_id` 读取，绝不跨项目；
* 每类记录先按上限取回、再按上限渲染，超出部分只汇总数量，不做全量注入；
* 跳过未确认（candidate / inferred / rejected）、已取代、已失效、已作废的记录；
* 只返回一段有界文本，不返回 ORM 行，也不写回任何数据。

本模块不检索、不建索引、不写入，也不参与正文修改；它是叙事状态表的只读适配层，
可以复用于一致性检查之外的只读场景。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.storage.repos import chapter_repo, character_repo

# 注入上下文的总上限，以及每个分类自己的上限。与一致性检查的
# MAX_CONTEXT_CHARS（6,000）同量级但更小：结构化状态只是线索，不占满预算。
MAX_CONTEXT_CHARS = 2_200
SECTION_CHARS = 500
MAX_ITEM_CHARS = 160
MAX_SUBJECT_CHARS = 60
MAX_ANCHOR_CHARS = 60

# 每类最多取回的已确认行数（仓储上限 200，这里取更小的值）。
FETCH_LIMIT = 50
MAX_WORLD_FACTS = 6
MAX_BELIEFS = 8
MAX_PLOTLINES = 4
MAX_SCENE_PLANS = 2

# 已作废 / 已中止的记录不再构成可判定的义务，直接跳过（行保留在库中）。
EXCLUDED_WORLD_FACT_STATUSES: tuple[str, ...] = ("retired",)
EXCLUDED_PLOTLINE_STATES: tuple[str, ...] = ("abandoned",)

UNKNOWN_CHARACTER_NAME = "（未命名人物）"
UNKNOWN_CHAPTER_LABEL = "未记录"

SECTION_HEADER = (
    "【已确认叙事状态】\n"
    "以下内容来自项目设定库中经过人工确认的结构化记录，仅作为线索："
    "记录已确认不代表命题必然为真：世界事实须按 confirmed/uncertain/contradicted 状态判断；人物信念是某个人物相信的命题，"
    "可能是错的，不能当作世界事实。资料未记录不等于事实不存在。"
)

_TRUNCATION_NOTE = "（其余已确认记录未列出。）"


def _clip(text: Any, limit: int = MAX_ITEM_CHARS) -> str:
    """压成单行并截断，避免把多行散文注入到有界上下文里。"""
    return " ".join(str(text or "").split())[:limit]


def _fit_lines(header: str, lines: list[str], budget: int = SECTION_CHARS) -> str:
    """把分类标题与条目装进字符预算；超出的条目只留下一条说明。"""
    if not lines:
        return ""
    reserved = len(_TRUNCATION_NOTE) + 1
    kept: list[str] = []
    used = len(header)
    for line in lines:
        if used + len(line) + 1 + reserved > budget:
            break
        kept.append(line)
        used += len(line) + 1
    if not kept:
        return ""
    text = "\n".join([header, *kept])
    if len(kept) < len(lines):
        text = f"{text}\n{_TRUNCATION_NOTE}"
    return text


def _provenance_hint(view: Any) -> str:
    """来源类型与引用锚点：让模型知道这条记录是怎么来的。"""
    parts: list[str] = []
    source_type = _clip(getattr(view, "source_type", ""), 30)
    if source_type:
        parts.append(f"来源：{source_type}")
    anchor = _clip(getattr(view, "quote_anchor", ""), MAX_ANCHOR_CHARS)
    if anchor:
        parts.append(f"锚点：{anchor}")
    return "；".join(parts)


def _world_fact_section(facts: list[Any], total: int) -> str:
    lines: list[str] = []
    for fact in facts:
        if fact.superseded_by_id or fact.status in EXCLUDED_WORLD_FACT_STATUSES:
            continue
        statement = _clip(fact.statement)
        if not statement:
            continue
        details: list[str] = []
        subject = _clip(fact.subject_ref, MAX_SUBJECT_CHARS)
        if subject:
            details.append(f"主体：{subject}")
        hint = _provenance_hint(fact.provenance)
        if hint:
            details.append(hint)
        suffix = f"（{'；'.join(details)}）" if details else ""
        lines.append(f"- [{fact.status}] {statement}{suffix}")
        if len(lines) >= MAX_WORLD_FACTS:
            break
    header = f"世界事实（故事世界中成立的断言；共 {total} 条已确认记录）："
    return _fit_lines(header, lines)


def _belief_section(
    beliefs: list[Any], total: int, names: dict[str, str], chapters: dict[str, str]
) -> str:
    lines: list[str] = []
    for belief in beliefs:
        if belief.superseded_by_id or belief.invalidated_at is not None:
            continue
        proposition = _clip(belief.proposition)
        if not proposition:
            continue
        name = names.get(belief.character_id, UNKNOWN_CHARACTER_NAME)
        learned = chapters.get(belief.learned_at_chapter_id or "")
        details = [f"把握程度：{belief.belief_state}"]
        details.append(f"得知于{learned}" if learned else f"得知章节：{UNKNOWN_CHAPTER_LABEL}")
        lines.append(f"- {name}：{proposition}（{'；'.join(details)}）")
        if len(lines) >= MAX_BELIEFS:
            break
    header = f"人物信念（人物相信的命题，可能是错的；共 {total} 条已确认记录）："
    return _fit_lines(header, lines)


def _plotline_section(plotlines: list[Any], total: int) -> str:
    lines: list[str] = []
    for plotline in plotlines:
        if plotline.state in EXCLUDED_PLOTLINE_STATES:
            continue
        title = _clip(plotline.title, 100)
        if not title:
            continue
        details: list[str] = []
        if plotline.current_question:
            details.append(f"待解答：{_clip(plotline.current_question)}")
        if plotline.payoff:
            details.append(f"预期兑现：{_clip(plotline.payoff)}")
        suffix = f"（{'；'.join(details)}）" if details else ""
        lines.append(f"- [{plotline.state}] {title}{suffix}")
        if len(lines) >= MAX_PLOTLINES:
            break
    header = f"情节线（setup/payoff 义务；共 {total} 条已确认记录）："
    return _fit_lines(header, lines)


def _scene_plan_section(
    plans: list[Any],
    total: int,
    *,
    chapter_label: str,
    names: dict[str, str],
) -> str:
    lines: list[str] = []
    for plan in plans:
        parts: list[str] = []
        goal = _clip(plan.goal)
        if goal:
            parts.append(f"目标：{goal}")
        if plan.pov_character_id:
            parts.append(
                f"视角人物：{names.get(plan.pov_character_id, UNKNOWN_CHARACTER_NAME)}"
            )
        if plan.participants:
            participants = "、".join(
                names.get(item, UNKNOWN_CHARACTER_NAME) for item in plan.participants
            )
            parts.append(f"参与者：{_clip(participants, 100)}")
        if plan.known_information:
            parts.append(f"已知信息：{_clip('；'.join(plan.known_information))}")
        if plan.hidden_information:
            parts.append(
                f"隐藏信息（未被获知的人物不得使用）："
                f"{_clip('；'.join(plan.hidden_information))}"
            )
        if not parts:
            continue
        lines.append(f"- 场景 {plan.scene_index + 1}：{'；'.join(parts)}")
        if len(lines) >= MAX_SCENE_PLANS:
            break
    scope = f"{chapter_label}；" if chapter_label else ""
    header = f"场景计划（{scope}共 {total} 个已确认场景）："
    return _fit_lines(header, lines)


async def _character_names(
    session: AsyncSession, project_id: str, character_ids: list[str]
) -> dict[str, str]:
    """把人物 ID 解析成名称；只读取本项目中确实存在的人物。"""
    unique_ids = [item for item in dict.fromkeys(character_ids) if item]
    if not unique_ids:
        return {}
    characters = await character_repo.list_by_project_and_ids(
        session, project_id, unique_ids
    )
    return {character.id: character.name for character in characters}


async def _chapter_labels(
    session: AsyncSession, project_id: str, chapter_ids: list[str]
) -> dict[str, str]:
    """把章节 ID 解析成「第N章 标题」，只读取元数据，不加载正文。"""
    unique_ids = [item for item in dict.fromkeys(chapter_ids) if item]
    if not unique_ids:
        return {}
    chapters = await chapter_repo.get_metadata_by_ids(session, unique_ids)
    return {
        chapter.id: f"第{chapter.order}章 {chapter.title}".strip()
        for chapter in chapters
        if chapter.project_id == project_id
    }


async def build_narrative_state_context(
    session: AsyncSession,
    *,
    project_id: str,
    scene_plan_chapter_id: str | None = None,
) -> str:
    """返回一段有界的「已确认叙事状态」文本；没有可用记录时返回空串。

    `scene_plan_chapter_id` 指定要附带哪个章节的场景计划（通常是被检查的章节），
    不传则不读取场景计划，避免为整卷 / 全书逐章查询。
    """
    # 沿用 core 层按需导入 storage service 的写法，避免与 storage 层形成导入环。
    from app.storage.services import narrative_service

    facts, facts_total = await narrative_service.list_world_facts(
        session, project_id, confirmation="confirmed", limit=FETCH_LIMIT
    )
    beliefs, beliefs_total = await narrative_service.list_character_beliefs(
        session, project_id, confirmation="confirmed", limit=FETCH_LIMIT
    )
    plotlines, plotlines_total = await narrative_service.list_plotlines(
        session, project_id, confirmation="confirmed", limit=FETCH_LIMIT
    )
    plans: list[Any] = []
    plans_total = 0
    if scene_plan_chapter_id:
        plans, plans_total = await narrative_service.list_scene_plans(
            session,
            project_id,
            chapter_id=scene_plan_chapter_id,
            confirmation="confirmed",
            limit=FETCH_LIMIT,
        )

    character_ids = [belief.character_id for belief in beliefs]
    for plan in plans:
        if plan.pov_character_id:
            character_ids.append(plan.pov_character_id)
        character_ids.extend(plan.participants)
    names = await _character_names(session, project_id, character_ids)

    chapter_ids = [
        belief.learned_at_chapter_id
        for belief in beliefs
        if belief.learned_at_chapter_id
    ]
    if scene_plan_chapter_id:
        chapter_ids.append(scene_plan_chapter_id)
    chapters = await _chapter_labels(session, project_id, chapter_ids)

    sections = [
        _world_fact_section(facts, facts_total),
        _belief_section(beliefs, beliefs_total, names, chapters),
        _plotline_section(plotlines, plotlines_total),
        _scene_plan_section(
            plans,
            plans_total,
            chapter_label=chapters.get(scene_plan_chapter_id or "", ""),
            names=names,
        ),
    ]
    body = "\n\n".join(section for section in sections if section)
    if not body:
        return ""
    return f"{SECTION_HEADER}\n\n{body}"[:MAX_CONTEXT_CHARS]
