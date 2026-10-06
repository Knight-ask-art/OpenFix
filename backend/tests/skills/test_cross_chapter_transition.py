# -*- coding: utf-8 -*-
"""跨章连续性（章节接口）规则的契约回归。

规则只有一个 owner：``narrative-deslop``（小说叙事去模板化）的章节接口段，
详细判定与断裂类型放在该 Skill 的 references 里，按需加载。
Writer / Reviewer / Actor prompt 只保留各自的行为与输出契约，不复制长规则。

所有断言只读取本地 YAML、loader、工具 registry 与 prompt chain：
不调用模型 API，不需要数据库、网络或 API Key。
"""

from pathlib import Path

import pytest
import yaml

from app.agent_runtime.tools.registry import ToolRegistry
from app.core.utils.tiktoken import count_tokens
from app.prompts import load_prompt_chain
from app.skills import BUILTIN_SKILL_ID_PREFIX, load_builtin_skill, load_builtin_skills

APP_DIR = Path(__file__).resolve().parents[2] / "app"
SKILLS_DIR = APP_DIR / "skills"

OWNER = "narrative-deslop"
OWNER_NAME = "小说叙事去模板化"
TRANSITION_REFERENCE = "章节接口判定与断裂类型"

# 这些长句只能出现在 owner 里；写进多个 Skill 或 prompt 就是规则重复。
OWNER_ONLY_CLAUSES = (
    "硬切成立的条件",
    "需要延续的条件",
    "时间可以跳跃，因果、认知与人物状态不能断线",
    "不把演过的动作、物件状态或环境描写再讲一遍",
    "连续用于多处接口，也不要求每章使用同一种钩子或收束方式",
    "未读到相邻章或缺少对照材料时只报未覆盖",
)

# 章节接口边界的证据来自既有只读工具，不新建相邻章上下文注入。
ADJACENT_CHAPTER_TOOLS = (
    "read_chapter",
    "read_chapter_summaries",
    "list_chapters",
    "read_narrative_state",
)


def _skill(name):
    skill = load_builtin_skill(f"{BUILTIN_SKILL_ID_PREFIX}{name}")
    assert skill is not None
    return skill


def _skill_text(name):
    skill = _skill(name)
    return "\n".join([skill.content, *(doc.content for doc in skill.references)])


def _raw(name):
    return yaml.safe_load((SKILLS_DIR / f"{name}.yaml").read_text(encoding="utf-8"))


def _prompt(agent):
    entries = load_prompt_chain(f"builtin-agent--{agent}")
    assert entries
    assert all(entry.is_enabled for entry in entries)
    return "\n".join(entry.content for entry in entries)


def test_transition_rule_keeps_a_single_owner_and_no_duplicate_skill():
    skills = {skill.id: skill for skill in load_builtin_skills()}
    assert f"{BUILTIN_SKILL_ID_PREFIX}{OWNER}" in skills
    assert set(skills) == {
        f"{BUILTIN_SKILL_ID_PREFIX}{path.stem}" for path in SKILLS_DIR.glob("*.yaml")
    }

    owner = _skill(OWNER)
    assert owner.name == OWNER_NAME
    assert owner.is_enabled
    assert "## 章节接口与跨章连续性" in owner.content

    raw = _raw(OWNER)
    assert set(raw) == {"id", "name", "summary", "is_enabled", "content", "references"}


def test_transition_rule_is_not_copied_into_other_skills():
    owner_text = _skill_text(OWNER)
    for clause in OWNER_ONLY_CLAUSES:
        assert clause in owner_text

    for skill in load_builtin_skills():
        if skill.id == f"{BUILTIN_SKILL_ID_PREFIX}{OWNER}":
            continue
        haystack = "\n".join(
            [skill.content, *(doc.content for doc in skill.references)]
        )
        for clause in OWNER_ONLY_CLAUSES:
            assert clause not in haystack, f"{skill.id} 复制了章节接口长规则: {clause}"


def test_agent_prompts_reference_owner_without_copying_decision_rules():
    for agent in ("writer", "reviewer", "actor"):
        prompt = _prompt(agent)
        for clause in OWNER_ONLY_CLAUSES:
            assert clause not in prompt, f"{agent} prompt 复制了章节接口 owner 规则: {clause}"


def test_transition_reference_stays_lazy_and_bounded():
    owner = _skill(OWNER)
    references = {doc.title: doc for doc in owner.references}
    assert TRANSITION_REFERENCE in references
    doc = references[TRANSITION_REFERENCE]
    assert doc.content.strip()
    assert doc.tokens == count_tokens(doc.content) > 0
    assert doc.content.strip() not in owner.content

    # 核心仍是有界的规则段，判定细节留在 reference。
    assert count_tokens(owner.content) <= 2200
    assert "chapter_transition" in owner.content
    assert "abrupt_cut" not in owner.content


def test_hard_cut_is_allowed_when_scene_completes_with_narrative_benefit():
    content = _skill(OWNER).content
    assert "硬切成立的条件" in content
    assert "场景目标、时间、地点与 POV 已经完成或明确收束" in content
    assert "叙事收益" in content
    assert "满足时允许硬切，不要求补过渡句" in content
    # 不把换场一律当断裂，也不把硬切当默认。
    assert "不默认所有章节都必须无缝相接，也不把换场一律当作断裂" in content
    assert "forced_continuity" in _skill_text(OWNER)


def test_continuation_keeps_one_carrier_when_prior_chapter_still_drives():
    content = _skill(OWNER).content
    assert "需要延续的条件" in content
    assert "上一章的动作、代价、身体状态、决定、关系余波、" in content
    assert "未回答的问题或关键物件仍在直接驱动下一章人物的行为。" in content
    assert "至少保留一个自然的连续性载体" in content
    assert "落在上一章章尾或下一章章首" in content
    for carrier in (
        "时间",
        "地点",
        "身体状态",
        "未完成动作",
        "关系余波",
        "问题",
        "物件",
        "决定",
    ):
        assert carrier in content
    # 不要求逐类齐全，也不要求每章都延续。
    assert "不要求逐类齐全，也不要求跨章逐项交接" in content


def test_time_jump_keeps_causal_and_state_continuity():
    text = _skill_text(OWNER)
    content = _skill(OWNER).content
    assert "时间可以跳跃，因果、认知与人物状态不能断线" in content
    assert "已经写在纸上的未完成动作若被跳跃跨过" in content
    assert "在后续可见因果链中给出结果（做了／没做／做不成），不无声消失" in content
    assert "dropped_action" in text
    assert "判因果断线" in text
    # 断裂类型不靠"读者可以自己补"来解释。
    assert "不当作“读者可以自己补”" in text


def test_continuation_rejects_recap_preview_and_mechanical_restatement():
    text = _skill_text(OWNER)
    content = _skill(OWNER).content
    assert "延续不等于复述" in content
    assert "不重复总结上一章、不由作者预告下文" in content
    assert "不用梦境或生硬回忆补接缝" in content
    assert "recap_instead_of_aftermath" in text
    assert "sequence_rewind" in text
    # 仍保留结尾的既有自由度：允许停在未解问题与阶段收束。
    assert "结尾" in content or "收束方式" in content
    for banned in (
        "必须总结上一章",
        "每章必须无缝相接",
        "每章结尾必须留钩子",
        "必须使用同一种钩子",
    ):
        assert banned not in text


def test_single_repeated_device_and_frozen_ending_are_reported():
    text = _skill_text(OWNER)
    content = _skill(OWNER).content
    assert "同一个接缝装置" in content
    assert "连续用于多处接口" in content
    assert "device_reuse" in text
    assert "frozen_ending" in text
    assert "abrupt_cut" in text


def test_reviewer_reports_interface_location_break_type_evidence_and_goal():
    reviewer = _prompt("reviewer")
    assert "小说叙事去模板化" in reviewer
    assert "章节接口规则" in reviewer
    assert "接口问题用 chapter_transition 类型" in reviewer
    assert "相邻两章位置与原文短引" in reviewer
    assert "断裂类型、证据与局部修改目标" in reviewer
    assert "chapter_transition" in reviewer
    # 既有 issue 字段协议保持不变。
    for field in ("quote_anchor", "reason", "goal", "preserve", "requires_plot_change"):
        assert field in reviewer


def test_actor_confines_interface_fix_to_boundary_span():
    actor = _prompt("actor")
    assert "章节接口类 issue 只改接口附近的最小 span" in actor
    assert "通常是章尾或章首" in actor
    assert "不静默改事件、事件顺序或大纲" in actor
    assert "不靠复述上一章、预告下文或再添一个停住的姿态补齐" in actor
    assert "需要新增事件或改动章末悬置内容时按 requires_plot_change 交回" in actor
    # 最小有效修订契约不被章节接口规则放宽。
    assert "minimum effective edit" in actor
    assert "不重写整章" in actor


def test_writer_uses_known_next_chapter_goal_and_falls_back_without_inventing():
    writer = _prompt("writer")
    assert "下一章的已知目标或场景计划" in writer
    assert "read_narrative_state 按下一章的卷内序号" in writer
    assert "仍查不到就不臆造下一章内容" in writer
    assert "按本章自身场景功能收束" in writer
    assert "章节接口规则判断" in writer
    # 仍然禁止把下一章的 beat 提前写完。
    assert "不提前写完属于下一章 beat 的内容" in writer


def test_missing_adjacent_chapter_evidence_stays_uncovered():
    text = _skill_text(OWNER)
    assert "未读到相邻章或缺少对照材料时只报未覆盖，不判定断裂" in _skill(OWNER).content
    assert "未读到相邻章时记 not_covered，不写断裂结论" in text
    assert "未读相邻章时标未覆盖" in _prompt("reviewer")
    assert "未读到相邻章时标未验证，不判断裂" in _prompt("reviewer")
    # 缺证据不要求重写，也不假装已经比对过相邻章。
    assert "不据此要求重写" in _skill(OWNER).content
    writer = _prompt("writer")
    assert "核对相邻章接口只读接口所在的那一章或该章摘要，不扫描全书" in writer


def test_adjacent_chapter_evidence_reuses_existing_readonly_tools():
    names = set(ToolRegistry.list_names())
    for tool in ADJACENT_CHAPTER_TOOLS:
        assert tool in names
    # 相邻章边界通过既有只读工具按需读取，不新增固定相邻章上下文。
    assert "read_narrative_state" in _prompt("writer")
    assert "不要求逐类齐全" in _skill(OWNER).content


@pytest.mark.parametrize("name", [OWNER])
def test_transition_owner_still_loads_through_yaml_loader(name):
    skill = _skill(name)
    assert skill.source == "builtin"
    assert skill.name.strip() and skill.summary.strip()
    assert skill.references
    assert len({doc.title for doc in skill.references}) == len(skill.references)
