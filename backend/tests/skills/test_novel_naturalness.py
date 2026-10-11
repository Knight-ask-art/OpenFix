"""Contract regressions for novel naturalness, lazy skills, and prompt ownership."""

from pathlib import Path
from unittest.mock import AsyncMock
import re

import pytest
import yaml

from app.agent_runtime.agents.definitions import get_default_agent_definition
from app.agent_runtime.context.parts.skills import build_skills
from app.agent_runtime.graph.state import AgentRuntimeState
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
    "continuity-audit",
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
    assert "builtin-skill--continuity-audit" in reviewer.enabled_skills
    assert "builtin-skill--prose-polish" in get_default_agent_definition("actor").enabled_skills
    assert len(reviewer.enabled_skills) <= 8
    assert not any(
        category.endswith("_write") for category in reviewer.enabled_tool_categories
    )
    for agent in ("writer", "reviewer", "actor", "composer"):
        assert all(
            load_builtin_skill(skill_id)
            for skill_id in get_default_agent_definition(agent).enabled_skills
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("agent", ["writer", "reviewer", "actor"])
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
    state: AgentRuntimeState = {
        "session_id": "test-session",
        "task_id": "test-task",
        "project_id": "test-project",
        "model_config": {},
        "active_agent": agent,
        "agent_key": agent,
        "is_completed": False,
        "error": None,
        "retry_count": 0,
        "user_request": "继续",
        "user_attachments": [],
        "current_revision_id": None,
    }
    msg = await build_skills(state, agent, session)
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


def test_prose_selfcheck_respects_style_and_preserves_existing_guards():
    writer = _prompt("writer")
    assert "<prose_selfcheck>" in writer
    assert "不强制本能、行动、言语的固定排列" in writer
    assert "不要求多数长段" in writer
    assert "不默认增加模型调用" in writer
    for preserved in ("measure_text", "read_narrative_state", "structural_compression"):
        assert preserved in writer
    for old_rule in ("本能→行动→言语 排序", "发达叙事段是否占多数"):
        assert old_rule not in writer
    actor = _prompt("actor")
    assert "文笔润色" in actor
    assert "preserve" in actor


def test_continuity_audit_keeps_provenance_and_adjudication_boundaries():
    skill = _skill("continuity-audit")
    content = skill.content
    for marker in (
        "伏笔账", "人物状态账", "设定与时间线账", "Pass A", "Pass F",
        "双锚点", "ledger_delta", "baseline", "source_id", "quote_anchor",
        "candidate / inferred", "不可靠叙述", "已确认 Canon", "写入审批",
        "非 Canon", "不能记 passed=true", "evidence insufficient",
        "只读新章", "不扫描整本", "长期悬置可以合法",
    ):
        assert marker in content
    assert "以正文原文为准" not in content
    assert "正文原文 > 人工确认" not in content
    assert count_tokens(content) <= 4500
    reviewer = _prompt("reviewer")
    assert "pending_adjudication" in reviewer
    assert "不能记 passed=true" in reviewer
    for agent in ("build", "plan"):
        prompt = _prompt(agent)
        assert "长篇一致性体检" in prompt
        assert "不能记 passed=true" in prompt
        assert "已有写入审批" in prompt
        assert "不能自动污染 Canon" in prompt


def test_prose_polish_core_and_references_preserve_confirmed_style():
    skill = _skill("prose-polish")
    all_text = "\n".join([skill.content, *(doc.content for doc in skill.references)])
    for banned in (
        "刺激永远先行", "反应内部按神经速度排序", "反应内部按本能→行动→言语排序",
        "发达的多句叙事段应占多数", "发达叙事段是否占多数",
        "被一句话段落主导的章节\n推定为有缺陷", "一个场景只允许 1-2",
        "每段对话应让读者", "一章内高光句子不超过 3", "微评判与拔高是否清零",
    ):
        assert banned not in all_text
    for marker in (
        "已确认项目文风优先", "可选诊断工具", "show / tell 非绝对规则",
        "不强制本能→行动→言语", "不以单句段比例判定质量",
        "不要求每段对话有潜台词", "不为了补齐 MRU 新增微动作",
        "润色不得改变这些状态", "从句表达因果", "物件可替代",
    ):
        assert marker in skill.content
    reference = next(doc for doc in skill.references if doc.title == "MRU 与节拍堆叠案例")
    assert "不按顺序判错" in reference.content
    assert "只是可选路径" in reference.content
