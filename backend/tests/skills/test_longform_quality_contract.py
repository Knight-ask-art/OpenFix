"""Static contracts for long-form quality guidance.

These tests verify protocol, loader, and lazy-reference consistency only.
They do not evaluate prose quality or generated model output.
"""

from dataclasses import dataclass
from unittest.mock import AsyncMock

import pytest

from app.agent_runtime.agents.definitions import get_default_agent_definition
from app.agent_runtime.tools.impls.skill.skill import (
    ActivateSkillTool,
    ReferenceSkillTool,
)
from app.core.utils.tiktoken import count_tokens
from app.skills import load_builtin_skill

TARGET_SKILLS = (
    "story-quality",
    "narrative-deslop",
    "fiction-prose-craft",
    "dialogue-design",
)

CORE_TOKEN_LIMITS = {
    "story-quality": 4000,
    "narrative-deslop": 6000,
    "fiction-prose-craft": 4000,
    "dialogue-design": 4000,
}

NEW_REFERENCE_TITLES = {
    "story-quality": (
        "跨章近况、成就与义务账",
        "专业判断、技术结论与情绪过程",
    ),
    "narrative-deslop": (
        "跨章近况与承诺账",
        "专业判断与情绪过程案例",
    ),
    "fiction-prose-craft": ("技术结果与说明边界",),
    "dialogue-design": ("群像对白与反应分配",),
}


@dataclass(frozen=True)
class ChapterCase:
    key: str
    style: str
    transition: str
    source: str
    next: str
    scope: str
    functions: tuple[str, ...]
    preserve: tuple[str, ...]
    boundary: str
    known: tuple[str, ...]
    unknown: tuple[str, ...]


CALM_SOURCE = (
    "她把修好的灯放回架上，记下还缺的两枚螺丝。窗外开始落雨，她没有起身关窗。\n\n"
    "“明天再去镇上。”她说。\n\n"
    "她把欠条压到账本最后一页，关灯前又数了一遍零钱。"
)

DIALOGUE_SOURCE = (
    "“名单上没有你。”门口的人把纸折回去，“我不能放你进。”\n\n"
    "“我替夜班的人来。”她没退，“他只说了一个字：换。”\n\n"
    "“哪个夜班？”\n\n"
    "她停了一下。后面的人开始咳嗽。"
)

HUMOR_SOURCE = (
    "水泵第三次停转时，老师傅蹲下去听了一会儿，说：“它在思考。”\n\n"
    "技术员把扳手递过去：“思考什么？”\n\n"
    "“思考今天谁值班。”老师傅敲了两下泵壳，机器咳了一声，又转起来。\n\n"
    "技术员没笑。他翻开记录本，在“异响”一栏写了个问号。"
)

CHAPTER_CASES = (
    ChapterCase(
        key="calm-continuation",
        style="克制叙述",
        transition="continuation",
        source=CALM_SOURCE,
        next=(
            "第二天雨没停。她带上零钱和那张欠条，走到门口才想起螺丝仍旧没买。\n\n"
            "灯留在架上，没有亮。"
        ),
        scope="第 N 章末／第 N+1 章首（合成节选）",
        functions=("延续未完成的采购", "保留等待与克制"),
        preserve=("POV 距离", "欠条与零钱状态", "未完成动作"),
        boundary="只交接状态，不补写过渡句，不新增事件",
        known=("欠条仍在", "螺丝未买", "灯未亮"),
        unknown=("她是否改变主意", "雨何时停"),
    ),
    ChapterCase(
        key="calm-hardcut",
        style="克制叙述",
        transition="hardcut",
        source=CALM_SOURCE,
        next=(
            "三周后，收割开始。她在场上翻麦，手边多了一把新螺丝刀，"
            "装螺丝的纸包没有拆。\n\n"
            "来帮忙的人问起那盏灯。\n\n"
            "“先收麦。”她说。"
        ),
        scope="第 N 章末／第 N+3 章首（合成节选）",
        functions=("时间跳转到农忙", "阶段切换"),
        preserve=("债务与物件结果", "人物当前目标", "克制的语气"),
        boundary="允许硬切；不要求复述镇上之行或补过渡句",
        known=("三周后", "螺丝刀已买", "纸包未拆"),
        unknown=("镇上之行发生了什么", "灯何时安装"),
    ),
    ChapterCase(
        key="dialogue-continuation",
        style="对话驱动",
        transition="continuation",
        source=DIALOGUE_SOURCE,
        next=(
            "“东门。”她说。\n\n"
            "门口的人看了她一会儿，把纸重新展开，在角上划了一道。\n\n"
            "“进去以后别走正门。”\n\n"
            "她点头，听见身后咳嗽的人往前挪了半步。"
        ),
        scope="第 N 章末／第 N+1 章首（合成节选）",
        functions=("延续交涉", "保留未完成的许可"),
        preserve=("未回答的身份问题", "咳嗽者带来的压力", "门口人的权限"),
        boundary="保留一个连续性载体；不新增放行理由或追兵",
        known=("她声称替夜班来", "门口人尚未完全放行"),
        unknown=("夜班的人是谁", "她最终是否获准进入"),
    ),
    ChapterCase(
        key="dialogue-hardcut",
        style="对话驱动",
        transition="hardcut",
        source=DIALOGUE_SOURCE,
        next=(
            "第二天傍晚，名单换了一张。她站在队尾，手里没有替班条，"
            "只拿着一封退回的信。\n\n"
            "门口的人问：“今天你找谁？”\n\n"
            "“不找谁。”她把信递过去，“我来还这个。”"
        ),
        scope="第 N 章末／第 N+1 章首（合成节选）",
        functions=("时间跳转", "开启新的归还目标"),
        preserve=("人物声线", "许可与身份的未决状态", "门口人的权限"),
        boundary="硬切保留因果与义务；不复述昨日入门过程，不大段解释信件",
        known=("名单已换", "她带着退回的信"),
        unknown=("昨天是否进入", "替班条去向"),
    ),
    ChapterCase(
        key="humor-continuation",
        style="人物化冷幽默",
        transition="continuation",
        source=HUMOR_SOURCE,
        next=(
            "第二天早上，泵又停了。老师傅没有蹲下去，只把昨天的扳手放在泵盖上。\n\n"
            "“这次思考得久一点。”他说。\n\n"
            "技术员先检查了进水管，才在本子上补了一行：空载能转，带载未测。"
        ),
        scope="第 N 章末／第 N+1 章首（合成节选）",
        functions=("延续故障观察", "用人物化幽默维持关系"),
        preserve=("老师傅的冷幽默", "技术员的记录习惯", "空载与带载的区别"),
        boundary="空载观察不等于带载安全；不补写测试或维修结果",
        known=("空载能转", "进水管已检查"),
        unknown=("带载能力", "温升上限", "故障原因"),
    ),
    ChapterCase(
        key="humor-hardcut",
        style="人物化冷幽默",
        transition="hardcut",
        source=HUMOR_SOURCE,
        next=(
            "月底检修时，泵已经被拆成三堆。老师傅站在旁边看新来的师傅量轴，"
            "手里还攥着那把扳手。\n\n"
            "技术员翻到记录本最后一页，上面只有一句：带载四小时，温升超标。\n\n"
            "“不是思考。”他说。\n\n"
            "老师傅把扳手放回工具箱：“那它想明白了。”"
        ),
        scope="第 N 章末／月底检修章首（合成节选）",
        functions=("时间跳转到检修", "兑现带载验证结果"),
        preserve=("扳手道具", "冷幽默声线", "已观察的带载结果"),
        boundary="允许硬切；不补检修过程，不写技术讲座",
        known=("带载四小时", "温升超标"),
        unknown=("是否彻底修复", "超标的具体原因"),
    ),
)

STYLE_CONTRACTS = (
    (
        "克制叙述",
        "fiction-prose-craft",
        "修辞、细节与修订边界",
        ("直白、留白", "冷峻", "不判定整体风格高低"),
    ),
    (
        "对话驱动",
        "dialogue-design",
        "对话设计原始方法论",
        ("对话量按功能，不设百分比", "沉默、行动或迟来回应可能足够"),
    ),
    (
        "人物化冷幽默",
        "dialogue-design",
        "对话设计原始方法论",
        ("玩笑按人物与场合判断", "防御性幽默"),
    ),
)

FUNCTIONAL_CONTRACTS = (
    (
        "cross_chapter_state",
        "story-quality",
        "跨章近况、成就与义务账",
        ("首次", "承诺", "债务", "临时许可", "unknown", "requires_plot_change"),
    ),
    (
        "professional_technical_emotion",
        "story-quality",
        "专业判断、技术结论与情绪过程",
        (
            "专业人物",
            "判断",
            "权威",
            "observed_unloaded",
            "validated_loaded",
            "unknown_capacity",
            "永久治愈",
        ),
    ),
    (
        "narrative_cross_chapter_state",
        "narrative-deslop",
        "跨章近况与承诺账",
        ("债务", "临时许可", "unknown", "requires_plot_change"),
    ),
    (
        "narrative_professional_emotion",
        "narrative-deslop",
        "专业判断与情绪过程案例",
        ("判断", "权威", "悲伤", "工作", "永久治愈", "恢复"),
    ),
    (
        "technical_evidence",
        "fiction-prose-craft",
        "技术结果与说明边界",
        (
            "observed_unloaded",
            "validated_loaded",
            "unknown_capacity",
            "requires_plot_change",
        ),
    ),
    (
        "ensemble_dialogue",
        "dialogue-design",
        "群像对白与反应分配",
        ("轮流", "沉默", "打断", "点名", "not_covered"),
    ),
)

ISSUE_FIELDS = (
    "location",
    "evidence",
    "goal",
    "preserve",
    "requires_plot_change",
    "scope",
    "covered",
    "not_covered",
)


def _skill(name: str):
    skill = load_builtin_skill(f"builtin-skill--{name}")
    assert skill is not None
    return skill


def _reference(name: str, title: str):
    skill = _skill(name)
    for doc in skill.references:
        if doc.title == title:
            return doc
    raise AssertionError(f"missing reference: {name}/{title}")


def _all_target_text() -> str:
    parts = []
    for name in TARGET_SKILLS:
        skill = _skill(name)
        parts.append(skill.content)
        parts.extend(doc.content for doc in skill.references)
    return "\n".join(parts)


@pytest.mark.parametrize(
    "case",
    CHAPTER_CASES,
    ids=lambda case: f"{case.style}-{case.transition}",
)
def test_chapter_fixture_matrix_declares_full_review_contract(case: ChapterCase):
    assert case.source.strip() and case.next.strip()
    assert case.transition in {"continuation", "hardcut"}
    assert "章" in case.scope
    assert case.functions and all(value.strip() for value in case.functions)
    assert case.preserve and all(value.strip() for value in case.preserve)
    assert case.boundary.strip()
    assert case.known and all(value.strip() for value in case.known)
    assert case.unknown and all(value.strip() for value in case.unknown)
    assert "TODO" not in "\n".join((case.source, case.next, case.boundary))


def test_fixture_matrix_covers_three_styles_and_both_transition_modes():
    assert {case.style for case in CHAPTER_CASES} == {
        "克制叙述",
        "对话驱动",
        "人物化冷幽默",
    }
    assert {case.transition for case in CHAPTER_CASES} == {"continuation", "hardcut"}


@pytest.mark.parametrize(
    "case",
    CHAPTER_CASES,
    ids=lambda case: f"{case.style}-{case.transition}",
)
def test_transition_contract_supports_expected_mode(case: ChapterCase):
    loaded = _skill("narrative-deslop").content + _reference(
        "narrative-deslop", "章节接口判定与断裂类型"
    ).content
    shared = ("场景目标", "POV", "叙事收益")
    assert all(marker in loaded for marker in shared)
    if case.transition == "continuation":
        expected = ("连续性载体", "动作", "代价", "关系余波", "未完成动作")
    else:
        expected = ("硬切成立", "不要求补过渡句", "时间", "地点")
    assert all(marker in loaded for marker in expected)
    assert "不要求每章" in loaded or "不默认所有章节" in loaded


@pytest.mark.parametrize(
    "style,skill_name,title,markers",
    STYLE_CONTRACTS,
    ids=[item[0] for item in STYLE_CONTRACTS],
)
def test_style_contracts_cover_distinct_styles_without_imposing_one(
    style, skill_name, title, markers
):
    assert any(case.style == style for case in CHAPTER_CASES)
    loaded = _skill(skill_name).content + _reference(skill_name, title).content
    assert all(marker in loaded for marker in markers)
    skill_text = _skill(skill_name).content
    assert "不强制" in skill_text or "允许" in skill_text

    all_text = _all_target_text()
    for banned in (
        "必须使用短句",
        "必须写金句",
        "每章必须写过渡",
        "所有人必须轮流发言",
        "悲痛必须持续",
    ):
        assert banned not in all_text


@pytest.mark.parametrize(
    "contract,skill_name,title,markers",
    FUNCTIONAL_CONTRACTS,
    ids=[item[0] for item in FUNCTIONAL_CONTRACTS],
)
def test_functional_reference_contract_fields_and_markers(
    contract, skill_name, title, markers
):
    doc = _reference(skill_name, title)
    assert doc.title == title
    assert doc.tokens == count_tokens(doc.content) > 0
    assert all(marker in doc.content for marker in markers)
    assert all(field in doc.content for field in ISSUE_FIELDS)
    assert "unknown" in doc.content


def test_technical_fixture_separates_unloaded_loaded_and_unknown():
    continuation = next(
        case
        for case in CHAPTER_CASES
        if case.style == "人物化冷幽默" and case.transition == "continuation"
    )
    hardcut = next(
        case
        for case in CHAPTER_CASES
        if case.style == "人物化冷幽默" and case.transition == "hardcut"
    )
    assert any("空载" in value for value in continuation.known)
    assert any("带载" in value or "承载" in value for value in continuation.unknown)
    assert any("带载" in value or "温升" in value for value in hardcut.known)
    assert hardcut.unknown

    doc = _reference("fiction-prose-craft", "技术结果与说明边界")
    for layer in ("observed_unloaded", "validated_loaded", "unknown_capacity"):
        assert layer in doc.content
    assert "不补写" in doc.content


@pytest.mark.parametrize("name", TARGET_SKILLS)
def test_main_skill_stays_bounded_and_references_are_small_and_lazy(name):
    skill = _skill(name)
    assert skill.id == f"builtin-skill--{name}"
    assert count_tokens(skill.content) <= CORE_TOKEN_LIMITS[name]
    assert len(skill.references) >= 3
    assert len({doc.title for doc in skill.references}) == len(skill.references)
    for doc in skill.references:
        assert 0 < doc.tokens <= 1200
        assert doc.content.strip() not in skill.content
    for title in NEW_REFERENCE_TITLES[name]:
        assert title in {doc.title for doc in skill.references}


@pytest.mark.asyncio
@pytest.mark.parametrize("name", TARGET_SKILLS)
async def test_new_references_load_only_on_request(name, monkeypatch):
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
    new_docs = [
        doc for doc in skill.references if doc.title in NEW_REFERENCE_TITLES[name]
    ]
    for doc in skill.references:
        assert doc.content.strip() not in activated

    for index, doc in enumerate(new_docs):
        result = await ReferenceSkillTool(_state=state).ainvoke(
            {"skill_name": skill.name, "reference_name": doc.title}
        )
        assert doc.content.strip() in result
        for other in new_docs:
            if other.title != doc.title:
                assert other.content.strip() not in result

    assert session.close.await_count == 1 + len(new_docs)
