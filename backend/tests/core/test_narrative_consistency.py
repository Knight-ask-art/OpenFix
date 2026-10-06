# -*- coding: utf-8 -*-
"""一致性检查接入 Narrative Engine「已确认」状态的测试。

覆盖：项目隔离、已确认状态可见性与未确认 / 作废状态过滤、世界事实与人物信念的
区分（含 unknown / mistaken）、注入长度上界、知识边界告警的证据校验，以及
「正文已交代该信息」的例外。

知识边界本身是语义判断：服务端不做关键词裁决，只保证两件确定性的事：

1. 提示词明确要求模型谨慎，并列出不得报告的情形；
2. 模型给出的知识边界告警必须能在本次检查的正文里定位到逐字原文，
   定位不到就按证据不足丢弃。

因此模型行为本身用 fake model 固定，测试断言的是服务端的输入输出边界。
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.narrative_context import (
    MAX_CONTEXT_CHARS,
    MAX_WORLD_FACTS,
    build_narrative_state_context,
)
from app.storage.models.character_belief import CharacterBelief
from app.storage.models.plotline import Plotline
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.world_fact import WorldFact

KEY_STATEMENT = "城南书铺的抽屉里藏着一把黄铜钥匙"
KEY_HIDDEN_INFO = "抽屉暗格里那把黄铜钥匙的来历"


@pytest.mark.asyncio
async def test_chapter_labels_exclude_foreign_project(monkeypatch):
    from app.core.narrative_context import _chapter_labels

    async def metadata(session, ids):
        return [
            SimpleNamespace(id="own", project_id="p1", order=1, title="本项目"),
            SimpleNamespace(id="other", project_id="p2", order=2, title="私有标题"),
        ]

    monkeypatch.setattr(
        "app.core.narrative_context.chapter_repo.get_metadata_by_ids", metadata
    )
    assert await _chapter_labels(None, "p1", ["own", "other"]) == {
        "own": "第1章 本项目"
    }


async def _create_project(
    client: AsyncClient, title: str, *, content: str | None = None
) -> tuple[str, str, str]:
    """建立项目 / 章节 / 人物，返回三个 ID。"""
    project = (await client.post("/api/v1/projects", data={"title": title})).json()
    project_id = project["id"]
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    chapter_content = content or "林晚推门而入，屋里只有一盏油灯。"
    chapter = (
        await client.post(
            f"/api/v1/projects/{project_id}/chapters",
            json={
                "volume_id": volumes[0]["id"],
                "title": "第一章",
                "content": chapter_content,
                "word_count": len(chapter_content),
            },
        )
    ).json()
    character = (
        await client.post(
            f"/api/v1/projects/{project_id}/characters",
            data={"name": "林晚", "description": "二十七岁的剑客"},
        )
    ).json()
    return project_id, chapter["id"], character["id"]


async def _add_fact(
    session: AsyncSession, project_id: str, statement: str, **overrides: Any
) -> WorldFact:
    fact = WorldFact(project_id=project_id, statement=statement, **overrides)
    session.add(fact)
    await session.flush()
    return fact


async def _add_belief(
    session: AsyncSession,
    project_id: str,
    character_id: str,
    proposition: str,
    **overrides: Any,
) -> CharacterBelief:
    belief = CharacterBelief(
        project_id=project_id,
        character_id=character_id,
        proposition=proposition,
        **overrides,
    )
    session.add(belief)
    await session.flush()
    return belief


async def _add_plotline(
    session: AsyncSession, project_id: str, title: str, **overrides: Any
) -> Plotline:
    plotline = Plotline(project_id=project_id, title=title, **overrides)
    session.add(plotline)
    await session.flush()
    return plotline


async def _add_scene_plan(
    session: AsyncSession, project_id: str, chapter_id: str, **overrides: Any
) -> ScenePlan:
    plan = ScenePlan(project_id=project_id, chapter_id=chapter_id, **overrides)
    session.add(plan)
    await session.flush()
    return plan


def _patch_fake_model(monkeypatch: pytest.MonkeyPatch, content: str = "[]") -> list[Any]:
    """替换后台模型，返回捕获到的 messages 列表。"""
    captured: list[list[dict[str, str]]] = []

    @dataclass
    class _FakeResolved:
        client: Any
        model: Any
        provider: Any = None

    class _FakeLLM:
        async def generate(self, messages, timeout=None):
            captured.append(messages)
            return SimpleNamespace(content=content)

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(
            client=_FakeLLM(),
            model=type("M", (), {"name": "测试模型", "model_id": "fake"})(),
        )

    from app.core.consistency import service as consistency_service

    monkeypatch.setattr(consistency_service, "resolve_background_llm", _fake_resolve)
    return captured


@pytest_asyncio.fixture
async def narrative_project(
    client: AsyncClient,
) -> tuple[str, str, str]:
    """带章节与人物、但还没有任何叙事状态记录的项目。"""
    return await _create_project(client, "叙事状态项目")


@pytest.mark.asyncio
async def test_confirmed_state_is_read_and_unconfirmed_is_skipped(
    narrative_project: tuple[str, str, str], session: AsyncSession
) -> None:
    project_id, chapter_id, character_id = narrative_project

    confirmed_fact = await _add_fact(
        session, project_id, KEY_STATEMENT, status="confirmed", confirmation="confirmed"
    )
    await _add_fact(session, project_id, "候选事实：书名是《夜雨》")
    await _add_fact(
        session, project_id, "被拒绝的事实", status="confirmed", confirmation="rejected"
    )
    await _add_fact(
        session, project_id, "已作废的事实", status="retired", confirmation="confirmed"
    )
    await _add_fact(
        session,
        project_id,
        "已被取代的事实",
        status="retired",
        confirmation="confirmed",
        superseded_by_id=confirmed_fact.id,
    )
    await _add_fact(
        session,
        project_id,
        "被推翻的事实",
        status="contradicted",
        confirmation="confirmed",
    )

    await _add_belief(
        session,
        project_id,
        character_id,
        "不知道抽屉里藏着钥匙",
        belief_state="unknown",
        confirmation="confirmed",
    )
    await _add_belief(
        session,
        project_id,
        character_id,
        "以为师父还活着",
        belief_state="mistaken",
        confirmation="confirmed",
    )
    await _add_belief(
        session, project_id, character_id, "候选信念", belief_state="known"
    )
    await _add_belief(
        session,
        project_id,
        character_id,
        "已失效的信念",
        belief_state="known",
        confirmation="confirmed",
        invalidated_at=datetime.now(UTC),
    )

    await _add_plotline(
        session, project_id, "钥匙的来历", state="open", confirmation="confirmed"
    )
    await _add_plotline(
        session, project_id, "被放弃的支线", state="abandoned", confirmation="confirmed"
    )

    await _add_scene_plan(
        session,
        project_id,
        chapter_id,
        scene_index=0,
        goal="林晚找到钥匙",
        hidden_information_json=f'["{KEY_HIDDEN_INFO}"]',
        confirmation="confirmed",
    )
    await _add_scene_plan(
        session,
        project_id,
        chapter_id,
        scene_index=1,
        goal="候选场景",
        hidden_information_json='["候选场景的隐藏信息"]',
    )

    context = await build_narrative_state_context(
        session, project_id=project_id, scene_plan_chapter_id=chapter_id
    )

    assert KEY_STATEMENT in context
    assert "被推翻的事实" in context
    assert "候选事实" not in context
    assert "被拒绝的事实" not in context
    assert "已作废的事实" not in context
    assert "已被取代的事实" not in context

    # 事实与信念分区展示：信念明确标注为「可能是错的」，并保留把握程度
    belief_header = "人物信念（人物相信的命题，可能是错的"
    assert "世界事实（故事世界中成立的断言" in context
    assert belief_header in context
    assert "把握程度：unknown" in context
    assert "把握程度：mistaken" in context
    assert context.index(KEY_STATEMENT) < context.index(belief_header)
    assert "候选信念" not in context
    assert "已失效的信念" not in context
    # 没有得知章节时明确标注为未记录，避免把「查不到」当成「知道」
    assert "得知章节：未记录" in context

    assert "钥匙的来历" in context
    assert "被放弃的支线" not in context

    assert KEY_HIDDEN_INFO in context
    assert "候选场景的隐藏信息" not in context


@pytest.mark.asyncio
async def test_narrative_state_is_project_scoped(
    client: AsyncClient, session: AsyncSession
) -> None:
    first_project, first_chapter, first_character = await _create_project(
        client, "甲项目"
    )
    second_project, second_chapter, second_character = await _create_project(
        client, "乙项目"
    )
    await _add_fact(
        session, first_project, "甲项目的世界事实", status="confirmed", confirmation="confirmed"
    )
    await _add_belief(
        session,
        first_project,
        first_character,
        "甲项目的人物信念",
        confirmation="confirmed",
    )
    await _add_scene_plan(
        session,
        first_project,
        first_chapter,
        scene_index=0,
        goal="甲项目场景",
        confirmation="confirmed",
    )
    await _add_fact(
        session, second_project, "乙项目的世界事实", status="confirmed", confirmation="confirmed"
    )
    await _add_belief(
        session,
        second_project,
        second_character,
        "乙项目的人物信念",
        confirmation="confirmed",
    )
    await _add_scene_plan(
        session,
        second_project,
        second_chapter,
        scene_index=0,
        goal="乙项目场景",
        confirmation="confirmed",
    )

    context = await build_narrative_state_context(
        session, project_id=first_project, scene_plan_chapter_id=first_chapter
    )

    assert "甲项目的世界事实" in context
    assert "甲项目的人物信念" in context
    assert "甲项目场景" in context
    assert "乙项目" not in context
    # 只读取传入的章节，不读取其它项目的同序号场景
    assert "乙项目场景" not in context


@pytest.mark.asyncio
async def test_narrative_state_stays_within_budget(
    narrative_project: tuple[str, str, str], session: AsyncSession
) -> None:
    project_id, chapter_id, _ = narrative_project
    for index in range(40):
        await _add_fact(
            session,
            project_id,
            f"事实 {index}：" + "长" * 200,
            status="confirmed",
            confirmation="confirmed",
        )

    context = await build_narrative_state_context(
        session, project_id=project_id, scene_plan_chapter_id=chapter_id
    )

    assert context
    assert len(context) <= MAX_CONTEXT_CHARS
    listed = [line for line in context.splitlines() if line.startswith("- [")]
    assert 0 < len(listed) <= MAX_WORLD_FACTS
    # 被截断时必须显式说明还有记录没列出，避免模型把「没列出」当成「不存在」
    assert "其余已确认记录未列出。" in context
    assert "共 40 条已确认" in context


@pytest.mark.asyncio
async def test_narrative_state_absent_yields_empty_context(
    narrative_project: tuple[str, str, str], session: AsyncSession
) -> None:
    project_id, chapter_id, _ = narrative_project

    assert (
        await build_narrative_state_context(
            session, project_id=project_id, scene_plan_chapter_id=chapter_id
        )
        == ""
    )


@pytest.mark.asyncio
async def test_consistency_check_injects_confirmed_narrative_state(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id, chapter_id, character_id = await _create_project(client, "注入检查")
    await _add_fact(
        session, project_id, KEY_STATEMENT, status="confirmed", confirmation="confirmed"
    )
    await _add_belief(
        session,
        project_id,
        character_id,
        "不知道抽屉里藏着钥匙",
        belief_state="unknown",
        confirmation="confirmed",
    )
    captured = _patch_fake_model(monkeypatch)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )

    assert response.status_code == 200
    data = response.json()
    # 输出结构与取值不变：未配置 embedding 时仍走清单回退
    assert data["context_source"] == "inventory"
    assert data["issues"] == []
    user_message = captured[0][1]["content"]
    assert "【已确认叙事状态】" in user_message
    assert KEY_STATEMENT in user_message
    assert "把握程度：unknown" in user_message


@pytest.mark.asyncio
async def test_knowledge_boundary_issue_keeps_locatable_evidence(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quote = "林晚径直从抽屉里取出那把黄铜钥匙"
    project_id, chapter_id, character_id = await _create_project(
        client,
        "知识边界",
        content=f"屋里只有一盏油灯。{quote}，仿佛早就知道它在那里。",
    )
    await _add_belief(
        session,
        project_id,
        character_id,
        "不知道抽屉里藏着钥匙",
        belief_state="unknown",
        confirmation="confirmed",
    )
    _patch_fake_model(
        monkeypatch,
        '[{"type": "knowledge_boundary", "severity": "warning",'
        ' "message": "林晚可能使用了其认知范围外的信息",'
        f' "evidence": ["{quote}"], "suggestion": "请检查该信息是否已交代"}}]',
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )

    assert response.status_code == 200
    issues = response.json()["issues"]
    assert len(issues) == 1
    assert issues[0]["type"] == "knowledge_boundary"
    assert issues[0]["severity"] == "warning"
    assert len(issues[0]["sources"]) == 1
    assert issues[0]["sources"][0]["quote"] == quote
    assert issues[0]["sources"][0]["chapter_id"] == chapter_id


@pytest.mark.asyncio
async def test_knowledge_boundary_issue_without_locatable_evidence_is_dropped(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """证据不足的知识边界告警不展示：引用资料而不是正文原文时一律丢弃。"""
    project_id, chapter_id, character_id = await _create_project(client, "证据不足")
    await _add_belief(
        session,
        project_id,
        character_id,
        "不知道抽屉里藏着钥匙",
        belief_state="unknown",
        confirmation="confirmed",
    )
    _patch_fake_model(
        monkeypatch,
        '[{"type": "knowledge_boundary", "severity": "warning",'
        ' "message": "林晚可能知道不该知道的事",'
        ' "evidence": ["设定：林晚不知道钥匙的位置"], "suggestion": "请检查"}]',
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )

    assert response.status_code == 200
    assert response.json()["issues"] == []


@pytest.mark.asyncio
async def test_knowledge_boundary_type_variants_use_the_same_evidence_gate(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """type 的大小写与分隔符变体走同一条证据校验，不因写法不同而绕过。"""
    project_id, chapter_id, _ = await _create_project(client, "类型变体")
    _patch_fake_model(
        monkeypatch,
        '[{"type": "Knowledge-Boundary", "severity": "warning",'
        ' "message": "可能越界", "evidence": ["并不存在于正文的引用"]}]',
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )

    assert response.status_code == 200
    assert response.json()["issues"] == []


@pytest.mark.asyncio
async def test_other_issue_types_keep_unlocatable_evidence_unchanged(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """证据校验只作用于知识边界类别，其它类别的既有行为保持不变。"""
    project_id, chapter_id, _ = await _create_project(client, "其它类别")
    _patch_fake_model(
        monkeypatch,
        '[{"type": "timeline", "severity": "warning", "message": "时间可能跳跃",'
        ' "evidence": ["并不存在于正文的引用"], "suggestion": ""}]',
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )

    assert response.status_code == 200
    issues = response.json()["issues"]
    assert len(issues) == 1
    assert issues[0]["type"] == "timeline"
    assert issues[0]["sources"] == []


@pytest.mark.asyncio
async def test_knowledge_boundary_prompt_states_the_learned_information_exception(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """正文已明确交代该信息时不得报告：提示词契约 + 遵守契约时的输出。

    语义判断由模型完成，服务端只保证提示词把例外写清楚，并且模型不报时
    结果里确实没有知识边界告警。
    """
    informed_text = "老者把钥匙的来历原原本本告诉了林晚，林晚这才知道其中缘由。"
    project_id, chapter_id, _ = await _create_project(
        client, "已交代", content=informed_text
    )
    captured = _patch_fake_model(monkeypatch, "[]")

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )

    assert response.status_code == 200
    assert response.json()["issues"] == []
    system_prompt = captured[0][0]["content"]
    assert "已经明确交代该信息" in system_prompt
    assert "没有记录不等于人物不知道" in system_prompt
    assert "knowledge_boundary" in system_prompt
    assert informed_text in captured[0][1]["content"]


@pytest.mark.asyncio
async def test_issue_analysis_also_receives_narrative_state(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id, chapter_id, character_id = await _create_project(client, "复核注入")
    await _add_belief(
        session,
        project_id,
        character_id,
        "不知道抽屉里藏着钥匙",
        belief_state="unknown",
        confirmation="confirmed",
    )
    captured = _patch_fake_model(monkeypatch, "依据尚不足，建议核实前后文。")

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/analyze",
        json={
            "scope": "chapter",
            "chapter_id": chapter_id,
            "issue": {
                "type": "knowledge_boundary",
                "severity": "warning",
                "message": "林晚可能使用了认知范围外的信息",
                "evidence": [],
                "suggestion": "请核对",
            },
        },
    )

    assert response.status_code == 200
    user_message = captured[0][1]["content"]
    assert "【已确认叙事状态】" in user_message
    assert "把握程度：unknown" in user_message
