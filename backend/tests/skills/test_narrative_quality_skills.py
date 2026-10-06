"""Narrative Engine 质量技能（文笔工艺、幽默写作、对话设计）的契约回归。

所有断言只读取本地 YAML、loader 与 prompt chain：
不调用模型 API，不需要数据库、网络或 API Key。
"""

from pathlib import Path

import pytest
import yaml

from app.core.utils.tiktoken import count_tokens
from app.prompts import load_prompt_chain
from app.skills import BUILTIN_SKILL_ID_PREFIX, load_builtin_skill, load_builtin_skills

APP_DIR = Path(__file__).resolve().parents[2] / "app"
SKILLS_DIR = APP_DIR / "skills"

NEW_QUALITY_SKILLS = ("fiction-prose-craft", "humor-writing")
QUALITY_SKILLS = (*NEW_QUALITY_SKILLS, "dialogue-design")

CORE_TOKEN_LIMIT = 2500
REFERENCE_TOKEN_LIMIT = 2500
REFERENCES_TOKEN_LIMIT = 6000

# 通用偏好标记必须排在已确认项目文风之后；每个技能用各自的措辞。
GENERIC_ADVICE_MARKERS = {
    "fiction-prose-craft": "文笔工艺 >",
    "humor-writing": "通用喜剧偏好",
    "dialogue-design": "通用对话偏好",
}


def _skill(name):
    skill = load_builtin_skill(f"{BUILTIN_SKILL_ID_PREFIX}{name}")
    assert skill is not None
    return skill


def _skill_text(name):
    skill = _skill(name)
    return "\n".join([skill.content, *(doc.content for doc in skill.references)])


def _raw(name):
    return yaml.safe_load((SKILLS_DIR / f"{name}.yaml").read_text(encoding="utf-8"))


def _reviewer_prompt():
    entries = load_prompt_chain("builtin-agent--reviewer")
    assert entries
    return "\n".join(entry.content for entry in entries)


def test_quality_skill_ids_load_with_unique_names():
    skills = {skill.id: skill for skill in load_builtin_skills()}
    for name in QUALITY_SKILLS:
        skill = _skill(name)
        assert skill.id == f"{BUILTIN_SKILL_ID_PREFIX}{name}"
        assert skills[skill.id] is skill
        assert skill.is_enabled
        assert skill.source == "builtin"
        assert skill.name.strip() and skill.summary.strip()

    names = [skill.name for skill in skills.values()]
    assert len(names) == len(set(names))


@pytest.mark.parametrize("name", NEW_QUALITY_SKILLS)
def test_new_quality_skill_core_is_small_and_references_stay_lazy(name):
    skill = _skill(name)
    core_tokens = count_tokens(skill.content)
    assert 150 <= core_tokens <= CORE_TOKEN_LIMIT
    assert len(skill.content.splitlines()) <= 130
    assert len(skill.references) >= 3

    reference_tokens = 0
    for doc in skill.references:
        assert doc.content.strip()
        assert doc.tokens == count_tokens(doc.content)
        assert doc.tokens <= REFERENCE_TOKEN_LIMIT
        assert doc.content.strip() not in skill.content
        reference_tokens += doc.tokens
    assert reference_tokens <= REFERENCES_TOKEN_LIMIT

    raw = _raw(name)
    assert raw["id"] == skill.id
    assert set(raw) == {"id", "name", "summary", "is_enabled", "content", "references"}


@pytest.mark.parametrize("name", QUALITY_SKILLS)
def test_quality_skills_keep_canon_and_project_style_above_generic_advice(name):
    content = _skill(name).content
    canon = content.index("剧情事实与角色设定")
    style = content.index("Style Profile")
    generic = content.index(GENERIC_ADVICE_MARKERS[name])
    assert canon < style < generic


def test_dialogue_voice_card_covers_register_goal_asymmetry_and_pressure_modes():
    skill = _skill("dialogue-design")
    card = next(doc for doc in skill.references if doc.title == "Character Voice Card模板")
    for field in (
        "known_register",
        "goal_under_pressure",
        "relationship_asymmetry",
        "pressure_modes",
    ):
        assert field in card.content
    core = skill.content
    assert "已知语域" in core
    assert "目标受阻时语言怎么变" in core
    assert "A 对 B 与 B 对 A" in core
    assert "突发高压" in core and "长期压力" in core
    assert "不为区分角色批量设计" in core
    assert "voice_knowledge_mismatch" in core


def test_reviewer_final_review_verifies_preserve_and_accepts_intentional_style():
    text = _reviewer_prompt()
    assert "preserve（事实/认知/关系/声线/信息边界）" in text
    assert "Final Review 逐条复核已修 issue 的 preserve 是否被遵守" in text
    assert "accepted" in text and "not_covered 只表示未检查" in text
    assert "requires_plot_change=true 的问题只确认是否已交回剧情设计" in text
    assert '"accepted": []' in text
    assert "voice_knowledge_mismatch" in text and "humor_misfire" in text
    assert "小说文笔工艺" in text and "小说幽默写作" in text
    assert "未引入时不假装已加载" in text
    # 既有 scene_function 契约保持可报告
    assert "scene_function" in text


RESTRAINED_FIXTURE = {
    "name": "restrained",
    "skill": "fiction-prose-craft",
    "text": (
        "她把碗放回桌上，碗底磕在木头上，声音很轻。\n"
        "她知道自己应该哭；她只是坐着，听雨把院墙一寸寸淋成深色，"
        "等灶上的水凉透，才想起自己还没有点灯。\n"
        "“我不难过。”她说。"
    ),
    "exercises": ("知道自己应该哭", "我不难过", "一寸寸淋成深色"),
    "permits": (
        "直接标注",
        "允许长句",
        "选择性细节",
        "功能性比喻",
        "narrative-deslop",
        "不是固定公式",
    ),
    "bans": (
        "不得直接命名情绪",
        "必须把情绪改写成动作",
        "一律删除长句",
        "禁止使用比喻、拟人",
        "每段不超过",
    ),
}

DIALOGUE_FIXTURE = {
    "name": "dialogue",
    "skill": "dialogue-design",
    "text": (
        "“名单呢？”\n"
        "“您先坐。”她把茶推过去，“外面冷。”\n"
        "“我问你名单。”\n"
        "“我知道。”她说，“我一直在等您问。”\n"
        "他没坐，也没再问。"
    ),
    "exercises": ("您先坐", "我一直在等您问", "也没再问"),
    "permits": (
        "允许不完整",
        "答非所问",
        "relationship_asymmetry",
        "goal_under_pressure",
        "长期压力",
        "不强制一人一口癖",
    ),
    "bans": ("每个角色必须有口头禅", "必须句句推进剧情", "方言才能体现"),
}

COLD_HUMOR_FIXTURE = {
    "name": "cold-humor",
    "skill": "humor-writing",
    "text": (
        "“你昨天说不会再迟到。”\n"
        "“今天不算。”\n"
        "他把伞收好，认真地宣布：今天谁都不许淋雨。\n"
        "没有人反驳，因为外面已经停了。"
    ),
    "exercises": ("今天不算", "谁都不许淋雨", "已经停了"),
    "permits": (
        "冷幽默",
        "不解释",
        "留白",
        "共情",
        "信息差",
        "非喜剧项目",
        "不强行添加笑话",
        "canon",
    ),
    "bans": ("每章至少一个笑点", "必须解释笑点", "必须使用网络流行语", "禁止冷幽默"),
}

FIXTURES = (RESTRAINED_FIXTURE, DIALOGUE_FIXTURE, COLD_HUMOR_FIXTURE)
FIXTURE_IDS = [fixture["name"] for fixture in FIXTURES]


@pytest.mark.parametrize("fixture", FIXTURES, ids=FIXTURE_IDS)
def test_quality_fixtures_keep_legal_variation_outside_the_ban_list(fixture):
    text = _skill_text(fixture["skill"])
    for marker in fixture["exercises"]:
        assert marker in fixture["text"]
    for marker in fixture["permits"]:
        assert marker in text
    for marker in fixture["bans"]:
        assert marker not in text


@pytest.mark.parametrize("fixture", FIXTURES, ids=FIXTURE_IDS)
def test_quality_fixtures_do_not_smuggle_absolute_rules_into_any_builtin_skill(fixture):
    """任一内置技能都不得出现“把合法变体一律判错”的绝对规则。"""
    for skill in load_builtin_skills():
        haystack = "\n".join([skill.content, *(doc.content for doc in skill.references)])
        for marker in fixture["bans"]:
            assert marker not in haystack, f"{skill.id} 出现绝对规则: {marker}"
