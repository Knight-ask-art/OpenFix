"""Contract regressions for novel naturalness, lazy skills, and prompt ownership."""

from pathlib import Path
from unittest.mock import AsyncMock
import re

import pytest
import yaml

from app.agent_runtime.agents.definitions import get_default_agent_definition
from app.agent_runtime.context.parts.skills import build_skills
from app.agent_runtime.tools.impls.skill.skill import (
    ActivateSkillTool,
    ReferenceSkillTool,
)
from app.core.utils.tiktoken import count_tokens
from app.prompts import load_prompt_chain
from app.skills import load_builtin_skill, load_builtin_skills

SKILLS = (
    "deslop-writing",
    "deslop-lexicon",
    "narrative-deslop",
    "dialogue-design",
    "story-quality",
    "prose-format",
    "prose-polish",
    "style-profile",
    "author-style-profile",
    "fiction-prose-craft",
    "humor-writing",
)


def _skill(name):
    skill = load_builtin_skill(f"builtin-skill--{name}")
    assert skill is not None
    return skill


def _prompt(agent):
    entries = load_prompt_chain(f"builtin-agent--{agent}")
    assert entries
    assert all(entry.is_enabled for entry in entries)
    assert len({entry.order_index for entry in entries}) == len(entries)
    return "\n".join(entry.content for entry in entries)


def test_all_builtin_yaml_ids_are_unique_and_not_silently_skipped():
    skills_dir = Path(__file__).parents[2] / "app" / "skills"
    raw = [
        yaml.safe_load(path.read_text(encoding="utf-8"))
        for path in skills_dir.glob("*.yaml")
    ]
    ids = [item["id"] for item in raw]
    assert len(ids) == len(set(ids))
    assert {skill.id for skill in load_builtin_skills()} == set(ids)


@pytest.mark.parametrize("name", SKILLS)
def test_naturalness_skill_references_and_tokens(name):
    skill = _skill(name)
    assert skill.is_enabled
    assert count_tokens(skill.content) > 0
    assert skill.references
    assert len({doc.title for doc in skill.references}) == len(skill.references)
    for doc in skill.references:
        assert doc.content.strip()
        assert doc.tokens == count_tokens(doc.content) > 0


def test_deslop_core_is_bounded_and_keeps_core_protocol():
    skill = _skill("deslop-writing")
    assert 150 <= len(skill.content.splitlines()) <= 300
    assert count_tokens(skill.content) <= 4500
    for marker in (
        "Gate 0",
        "Pass 1",
        "Pass 5",
        "Minimum Effective Edit",
        "何时停止",
        "requires_plot_change",
        "单次自然使用",
    ):
        assert marker in skill.content
    assert len(skill.references) >= 4
    assert any(doc.title == "去AI味完整指南" for doc in skill.references)


def test_narrative_gates_cover_story_and_pov_without_forcing_new_events():
    content = _skill("narrative-deslop").content
    gates = (
        "Character Agency",
        "Resistance",
        "Choice",
        "Cost",
        "Irreversible Change",
        "Knowledge Boundary",
        "Interpretation Density",
        "Tidy Closure",
    )
    for index, label in enumerate(gates, 1):
        assert f"N{index} — {label}" in content
    for marker in (
        "不适用",
        "证据不足",
        "不能捏造",
        "Psychic Distance",
        "requires_plot_change=true",
        "误解",
        "不强迫",
    ):
        assert marker in content


@pytest.mark.parametrize("agent", ["writer", "reviewer", "actor", "build"])
def test_prompt_conflict_regressions(agent):
    prompt = _prompt(agent)
    compact = re.sub(r"\s+", "", prompt)
    for banned in (
        "禁止使用比喻、拟人等修辞",
        "不引入比喻、拟人等修辞",
        "对白应结构完整",
        "对白必须完整主谓宾",
        "每个段落不应超过60字",
        "每段必须≤60字",
        "段落是否仅1-3句、≤60字",
        "时刻推进剧情",
        "换用其它同义词",
        "你被禁止在正文部分使用以下词汇",
    ):
        assert banned not in compact
    assert "RuntimeStyleCard" in compact
    assert "剧情事实与角色设定" in prompt or "事实与人物设定" in prompt


def test_writer_is_generation_focused_and_reviewer_actor_have_targeted_protocol():
    writer = _prompt("writer")
    reviewer = _prompt("reviewer")
    actor = _prompt("actor")
    assert "Writer 负责生成" in writer
    assert "preserve" in writer
    assert "requires_plot_change=true" in writer
    assert "允许不完整句" in writer
    assert "低频、功能性" in writer
    assert "当前提示不是唯一事实来源" in writer
    assert '"risk_vector"' in reviewer
    for field in ("quote_anchor", "reason", "goal", "preserve", "requires_plot_change"):
        assert field in reviewer
        assert field in actor
    for issue in (
        "psychic_distance",
        "dialogue_voice",
        "tidy_closure",
        "character_agency",
    ):
        assert issue in reviewer
    assert "不能直接修改正文" in reviewer
    assert "minimum effective edit" in actor
    assert "不重写整章" in actor
    assert "候选未接受不能声称正文已修改" in actor


def test_surface_linter_and_format_share_contextual_rules():
    lexicon = _skill("deslop-lexicon")
    prose = _skill("prose-format")
    for marker in ("Surface Linter", "单次自然使用", "豁免", "不机械轮换同义词"):
        assert marker in lexicon.content
    for old_rule in ("出现即修", "出现即替换", "一级禁用词", "最毒禁用"):
        assert old_rule not in lexicon.content
        assert all(old_rule not in doc.content for doc in lexicon.references)
    assert "按戏剧单元 / 镜头 / 信息变化自然断段" in prose.content
    assert "省略号可以表示未尽，破折号可以表示中断" in prose.content
    assert "不机械改成动作" in prose.content
    dialogue = _skill("dialogue-design").content
    for marker in (
        "Character Voice Card",
        "高压",
        "关系对象",
        "遮掉角色名",
        "允许不完整",
    ):
        assert marker in dialogue


@pytest.mark.parametrize("agent", ["build", "plan"])
def test_dispatch_reuses_existing_workflow_and_skips_unnecessary_calls(agent):
    prompt = _prompt(agent)
    for stage in (
        "Narrative Check",
        "Writer Draft",
        "Narrative Reviewer",
        "Surface Deslop Reviewer",
        "Actor Targeted Revision",
        "Final Review",
    ):
        assert stage in prompt
    assert "跳过 Actor" in prompt
    assert "纯审查只派 Reviewer" in prompt
    assert "不把 Writer 全部历史" in prompt


def test_default_agent_skill_bundles_are_small_and_readonly_reviewer():
    writer = get_default_agent_definition("writer")
    reviewer = get_default_agent_definition("reviewer")
    assert writer.enabled_skills == (
        "builtin-skill--style-profile",
        "builtin-skill--deslop-writing",
        "builtin-skill--fiction-prose-craft",
        "builtin-skill--prose-polish",
    )
    assert "builtin-skill--narrative-deslop" in reviewer.enabled_skills
    assert "builtin-skill--deslop-lexicon" in reviewer.enabled_skills
    assert len(writer.enabled_skills) <= 4
    assert len(reviewer.enabled_skills) <= 8
    assert not any(
        category.endswith("_write") for category in reviewer.enabled_tool_categories
    )
    for agent in ("writer", "reviewer", "actor", "composer"):
        assert all(
            load_builtin_skill(skill_id)
            for skill_id in get_default_agent_definition(agent).enabled_skills
        )


def test_continuity_audit_skill_keeps_ledger_protocol():
    skill = _skill("continuity-audit")
    assert skill.is_enabled
    for marker in (
        "伏笔账",
        "人物状态账",
        "设定与时间线账",
        "Pass A",
        "Pass B",
        "Pass C",
        "Pass D",
        "Pass E",
        "Pass F",
        "分批建账",
        "增量体检",
        "双锚点",
        "账本附录",
        "待裁定",
        "不做文学裁决",
    ):
        assert marker in skill.content
    assert len(skill.references) >= 2
    reviewer = get_default_agent_definition("reviewer")
    assert "builtin-skill--continuity-audit" in reviewer.enabled_skills


@pytest.mark.asyncio
@pytest.mark.parametrize("agent", ["writer", "reviewer"])
async def test_manifest_never_pushes_full_core_or_references(agent, monkeypatch):
    session = AsyncMock()
    definition = get_default_agent_definition(agent)
    monkeypatch.setattr(
        "app.agent_runtime.context.parts.skills.load_agent_definition",
        AsyncMock(return_value=definition),
    )
    monkeypatch.setattr(
        "app.storage.repos.skill_repo.list_by_ids", AsyncMock(return_value=[])
    )
    msg = await build_skills({"user_request": "继续"}, agent, session)
    assert msg is not None
    assert "<available_skills>" in msg.content
    assert count_tokens(msg.content) <= 1200
    for skill_id in definition.enabled_skills:
        skill = load_builtin_skill(skill_id)
        assert skill is not None
        assert skill.name in msg.content
        assert skill.content.strip() not in msg.content
        assert all(doc.content.strip() not in msg.content for doc in skill.references)


@pytest.mark.asyncio
@pytest.mark.parametrize("name", SKILLS)
async def test_real_skill_tools_load_core_and_only_requested_reference(
    name, monkeypatch
):
    skill = _skill(name)
    definition = get_default_agent_definition("reviewer")
    session = AsyncMock()
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.skill.skill.create_session",
        AsyncMock(return_value=session),
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.skill.skill.load_agent_definition",
        AsyncMock(return_value=definition),
    )
    monkeypatch.setattr(
        "app.storage.repos.skill_repo.list_by_ids", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        "app.storage.repos.skill_repo.list_enabled", AsyncMock(return_value=[])
    )
    state = {"active_agent": "reviewer", "referenced_skill_ids": [skill.id]}
    activated = await ActivateSkillTool(_state=state).ainvoke(
        {"skill_name": skill.name}
    )
    assert skill.content.strip() in activated
    assert all(doc.content.strip() not in activated for doc in skill.references)
    for doc in skill.references:
        result = await ReferenceSkillTool(_state=state).ainvoke(
            {"skill_name": skill.name, "reference_name": doc.title}
        )
        assert doc.content.strip() in result
    assert session.close.await_count == 1 + len(skill.references)
