import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest


def _make_state(project_id: str = "proj-1") -> dict:
    return {
        "session_id": "sess-1",
        "project_id": project_id,
        "model_config": {},
        "active_agent": "writer",
        "is_completed": False,
        "error": None,
        "retry_count": 0,
        "message_checkpoints": [],
        "user_request": "",
    }


@pytest.mark.asyncio
async def test_read_chapter_summaries_reads_project_page() -> None:
    from app.agent_runtime.tools.impls.context.read_chapter_summaries import (
        ReadChapterSummariesTool,
    )

    tool = ReadChapterSummariesTool(_state=_make_state())
    chapters = [
        SimpleNamespace(id="c2", order=2, title="第二章"),
        SimpleNamespace(id="c3", order=3, title="第三章"),
    ]
    summaries = [
        SimpleNamespace(chapter_id="c2", summary="第二章摘要"),
        SimpleNamespace(chapter_id="c3", summary="第三章摘要"),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.chapter_repo"
    ) as mock_chapter_repo, patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.chapter_summary_repo"
    ) as mock_summary_repo:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_chapter_repo.list_by_project_page = AsyncMock(return_value=chapters)
        mock_summary_repo.list_chapter_summaries_by_chapter_ids = AsyncMock(
            return_value=summaries
        )

        result = await tool.ainvoke({"offset": 1, "limit": 2})

    assert json.loads(result) == {
        "summaries": [
            {"order": 2, "title": "第二章", "summary": "第二章摘要"},
            {"order": 3, "title": "第三章", "summary": "第三章摘要"},
        ]
    }


@pytest.mark.asyncio
async def test_read_chapter_summaries_prefers_page_query_over_orders() -> None:
    from app.agent_runtime.tools.impls.context.read_chapter_summaries import (
        ReadChapterSummariesTool,
    )

    tool = ReadChapterSummariesTool(_state=_make_state())
    chapters = [SimpleNamespace(id="c4", order=4, title="第四章")]
    summaries = [SimpleNamespace(chapter_id="c4", summary="第四章摘要")]

    with patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.chapter_repo"
    ) as mock_chapter_repo, patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.chapter_summary_repo"
    ) as mock_summary_repo:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_chapter_repo.list_by_project_page = AsyncMock(return_value=chapters)
        mock_chapter_repo.list_by_project = AsyncMock()
        mock_summary_repo.list_chapter_summaries_by_chapter_ids = AsyncMock(
            return_value=summaries
        )

        result = await tool.ainvoke({"offset": 0, "limit": 1, "orders": [9, 7]})

    assert json.loads(result) == {
        "summaries": [
            {"order": 4, "title": "第四章", "summary": "第四章摘要"},
        ]
    }
    mock_chapter_repo.list_by_project.assert_not_called()


@pytest.mark.asyncio
async def test_read_chapter_summaries_reads_exact_orders_when_requested() -> None:
    from app.agent_runtime.tools.impls.context.read_chapter_summaries import (
        ReadChapterSummariesTool,
    )

    tool = ReadChapterSummariesTool(_state=_make_state())
    chapters = [
        SimpleNamespace(id="c2", order=2, title="第二章"),
        SimpleNamespace(id="c5", order=5, title="第五章"),
    ]
    summaries = [
        SimpleNamespace(chapter_id="c5", summary="第五章摘要"),
        SimpleNamespace(chapter_id="c2", summary="第二章摘要"),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.chapter_repo"
    ) as mock_chapter_repo, patch(
        "app.agent_runtime.tools.impls.context.read_chapter_summaries.chapter_summary_repo"
    ) as mock_summary_repo:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_chapter_repo.list_by_project = AsyncMock(return_value=chapters)
        mock_summary_repo.list_chapter_summaries_by_chapter_ids = AsyncMock(
            return_value=summaries
        )

        result = await tool.ainvoke({"orders": [5, 2]})

    assert json.loads(result) == {
        "summaries": [
            {"order": 5, "title": "第五章", "summary": "第五章摘要"},
            {"order": 2, "title": "第二章", "summary": "第二章摘要"},
        ]
    }


@pytest.mark.asyncio
async def test_read_range_summaries_returns_ascending_page() -> None:
    from app.agent_runtime.tools.impls.context.read_range_summaries import (
        ReadRangeSummariesTool,
    )

    tool = ReadRangeSummariesTool(_state=_make_state())
    summaries = [
        SimpleNamespace(start_order=21, end_order=30, summary="21-30"),
        SimpleNamespace(start_order=11, end_order=20, summary="11-20"),
        SimpleNamespace(start_order=1, end_order=10, summary="1-10"),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.read_range_summaries.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.read_range_summaries.chapter_summary_repo"
    ) as mock_summary_repo:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_summary_repo.list_long_term_summaries_by_project = AsyncMock(
            return_value=summaries
        )

        result = await tool.ainvoke({"offset": 1, "limit": 2})

    assert json.loads(result) == {
        "summaries": [
            {"start_order": 11, "end_order": 20, "summary": "11-20"},
            {"start_order": 21, "end_order": 30, "summary": "21-30"},
        ]
    }


@pytest.mark.asyncio
async def test_list_characters_returns_project_character_names() -> None:
    from app.agent_runtime.tools.impls.context.character import ListCharactersTool

    tool = ListCharactersTool(_state=_make_state())
    characters = [
        SimpleNamespace(id="char-1", name="林舟", description="主角", is_favorited=True),
        SimpleNamespace(id="char-2", name="沈墨", description="反派", is_favorited=False),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.character.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.character.character_repo"
    ) as mock_character_repo:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_character_repo.list_all_by_project = AsyncMock(return_value=characters)

        result = await tool.ainvoke({})

    assert json.loads(result) == {
        "characters": [
            {"name": "林舟"},
            {"name": "沈墨"},
        ]
    }


@pytest.mark.asyncio
async def test_read_character_reads_description_by_name() -> None:
    from app.agent_runtime.tools.impls.context.character import ReadCharacterTool

    tool = ReadCharacterTool(_state=_make_state())
    characters = [
        SimpleNamespace(
            id="char-1",
            name="林舟",
            description="主角\n旧友",
            is_favorited=True,
        ),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.character.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.character.character_repo"
    ) as mock_character_repo:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_character_repo.list_all_by_project = AsyncMock(return_value=characters)

        result = await tool.ainvoke({"name": "林舟"})

    assert json.loads(result) == {
        "name": "林舟",
        "description": "1|主角\n2|旧友",
    }


# ============================================
# read_character 可选人物状态（LF-01）
# ============================================

CHARACTER_STATE_PROJECT_ID = "project-character-state"
CHARACTER_STATE_OTHER_PROJECT_ID = "project-character-state-other"
HUGE_CHAPTER_ORDER = 1_500_000


async def _invoke_character_tool(tool, session, payload: dict) -> dict:
    raw = await tool.ainvoke(
        payload,
        config={"configurable": {"db_session": session}},
    )
    return json.loads(raw)


def _character_state_tool(project_id: str = CHARACTER_STATE_PROJECT_ID):
    from app.agent_runtime.tools.impls.context.character import ReadCharacterTool

    return ReadCharacterTool(_state=_make_state(project_id))


async def _seed_character_state_project(session) -> None:
    from app.storage.models.character import Character
    from app.storage.models.character_profile import CharacterProfile
    from app.storage.models.character_state import CharacterState
    from app.storage.models.chapter import Chapter
    from app.storage.models.project import Project
    from app.storage.models.volume import Volume

    session.add(Project(id=CHARACTER_STATE_PROJECT_ID, title="人物状态项目"))
    session.add(
        Project(id=CHARACTER_STATE_OTHER_PROJECT_ID, title="人物状态其他项目")
    )
    session.add(
        Volume(
            id="volume-a1",
            project_id=CHARACTER_STATE_PROJECT_ID,
            title="第一卷",
            order=1,
        )
    )
    session.add(
        Volume(
            id="volume-a2",
            project_id=CHARACTER_STATE_PROJECT_ID,
            title="第二卷",
            order=2,
        )
    )
    session.add(
        Volume(
            id="volume-b1",
            project_id=CHARACTER_STATE_OTHER_PROJECT_ID,
            title="外卷",
            order=1,
        )
    )
    # 章节 order 只在卷内唯一：两个卷都有 order=1 的章节；第一卷还有一个
    # 超过 1_000_000 的章节 order，用于证明字典序比较不依赖固定基数。
    chapters = [
        ("chapter-a1c1", CHARACTER_STATE_PROJECT_ID, "volume-a1", "雨夜", 1),
        ("chapter-a1c2", CHARACTER_STATE_PROJECT_ID, "volume-a1", "渡口", 2),
        ("chapter-a1c3", CHARACTER_STATE_PROJECT_ID, "volume-a1", "关城", 3),
        ("chapter-a1c4", CHARACTER_STATE_PROJECT_ID, "volume-a1", "雪山", 4),
        # 紧邻超长章序的锚点章节，用于验证工具层能解析巨大章序而不做固定基数猜测。
        ("chapter-a1hi-prev", CHARACTER_STATE_PROJECT_ID, "volume-a1", "前篇", HUGE_CHAPTER_ORDER - 1),
        ("chapter-a1hi", CHARACTER_STATE_PROJECT_ID, "volume-a1", "长篇", HUGE_CHAPTER_ORDER),
        ("chapter-a2c1", CHARACTER_STATE_PROJECT_ID, "volume-a2", "旧城", 1),
        ("chapter-a2c2", CHARACTER_STATE_PROJECT_ID, "volume-a2", "王都", 2),
        ("chapter-b1c1", CHARACTER_STATE_OTHER_PROJECT_ID, "volume-b1", "外章", 1),
    ]
    for chapter_id, project_id, volume_id, title, order in chapters:
        session.add(
            Chapter(
                id=chapter_id,
                project_id=project_id,
                volume_id=volume_id,
                title=title,
                content="",
                order=order,
            )
        )
    session.add(
        Character(
            id="char-a",
            project_id=CHARACTER_STATE_PROJECT_ID,
            name="林舟",
            description="镖师",
        )
    )
    session.add(
        Character(
            id="char-b",
            project_id=CHARACTER_STATE_OTHER_PROJECT_ID,
            name="林舟",
            description="旅人",
        )
    )
    session.add(
        Character(
            id="char-hi",
            project_id=CHARACTER_STATE_PROJECT_ID,
            name="迟舟",
            description="远行",
        )
    )
    # 只在锚点之后存在状态的同行角色：锚点及之前应显示未记录。
    session.add(
        Character(
            id="char-late",
            project_id=CHARACTER_STATE_PROJECT_ID,
            name="沈墨",
            description="同行",
        )
    )
    # 扩展档案仍写入库中，但 opt-in 输出不再展开这 15 个字段。
    session.add(
        CharacterProfile(
            id="profile-a",
            character_id="char-a",
            identity="镖师",
            abilities="擅长搬运",
        )
    )
    session.add(
        CharacterProfile(
            id="profile-b",
            character_id="char-b",
            identity="其他项目身份",
        )
    )
    states = [
        ("state-a-project", "char-a", CHARACTER_STATE_PROJECT_ID, None, "左手旧伤"),
        ("state-a1c1", "char-a", CHARACTER_STATE_PROJECT_ID, "chapter-a1c1", "手腕轻伤"),
        ("state-a1c2", "char-a", CHARACTER_STATE_PROJECT_ID, "chapter-a1c2", "左肩受伤"),
        ("state-a2c1", "char-a", CHARACTER_STATE_PROJECT_ID, "chapter-a2c1", "左眼失明"),
        # 锚点 (1,3) 之后的死亡与能力觉醒：回改时不得灌入。
        ("state-a1c4", "char-a", CHARACTER_STATE_PROJECT_ID, "chapter-a1c4", "已死亡"),
        # 超过 1_000_000 的章序，以及第二卷的未来状态。
        ("state-a1hi", "char-hi", CHARACTER_STATE_PROJECT_ID, "chapter-a1hi", "长章旧伤"),
        ("state-hi-future", "char-hi", CHARACTER_STATE_PROJECT_ID, "chapter-a2c2", "未来卷状态"),
        ("state-late", "char-late", CHARACTER_STATE_PROJECT_ID, "chapter-a1c2", "后章受伤"),
        ("state-late-project", "char-late", CHARACTER_STATE_PROJECT_ID, None, "常设受伤"),
        ("state-b-project", "char-b", CHARACTER_STATE_OTHER_PROJECT_ID, None, "其他项目常设状态"),
        ("state-b1c1", "char-b", CHARACTER_STATE_OTHER_PROJECT_ID, "chapter-b1c1", "其他项目章级状态"),
    ]
    for state_id, character_id, project_id, chapter_id, physical_state in states:
        notes = "觉醒异能" if state_id == "state-a1c4" else ""
        session.add(
            CharacterState(
                id=state_id,
                character_id=character_id,
                project_id=project_id,
                chapter_id=chapter_id,
                physical_state=physical_state,
                notes=notes,
            )
        )
    await session.flush()


def _anchor(volume_order: int, chapter_order: int) -> dict:
    return {
        "volume_ref": {"type": "order", "value": volume_order},
        "chapter_ref": {"type": "order", "value": chapter_order},
    }


@pytest.mark.asyncio
async def test_read_character_without_state_keeps_exact_default_output(
    session,
) -> None:
    await _seed_character_state_project(session)

    result = await _invoke_character_tool(
        _character_state_tool(), session, {"name": "林舟"}
    )

    assert result == {"name": "林舟", "description": "1|镖师"}
    assert "state_context" not in result


@pytest.mark.asyncio
async def test_read_character_state_anchor_selects_exact_chapter_across_volumes(
    session,
) -> None:
    await _seed_character_state_project(session)
    tool = _character_state_tool()

    early = await _invoke_character_tool(
        tool, session, {"name": "林舟", "include_state": True, **_anchor(1, 1)}
    )
    later = await _invoke_character_tool(
        tool, session, {"name": "林舟", "include_state": True, **_anchor(1, 2)}
    )
    second_volume = await _invoke_character_tool(
        tool, session, {"name": "林舟", "include_state": True, **_anchor(2, 1)}
    )

    early_context = early["state_context"]
    later_context = later["state_context"]
    second_context = second_volume["state_context"]

    assert early["description"] == "1|镖师"
    assert early["description_kind"] == "static_profile"
    assert early_context["scope"]["chapter_id"] == "chapter-a1c1"
    assert early_context["scope"]["chapter_label"] == "第1卷第1章 雨夜"
    assert early_context["chapter_state"]["state_id"] == "state-a1c1"
    assert early_context["chapter_state"]["fields"]["physical_state"] == "手腕轻伤"
    assert early_context["chapter_state"]["is_exact_anchor"] is True

    assert later_context["scope"]["chapter_id"] == "chapter-a1c2"
    assert later_context["scope"]["chapter_label"] == "第1卷第2章 渡口"
    assert later_context["chapter_state"]["state_id"] == "state-a1c2"
    assert later_context["chapter_state"]["fields"]["physical_state"] == "左肩受伤"

    # 第二卷的 order=1 不能被误解析为第一卷的 order=1。
    assert second_context["scope"]["chapter_id"] == "chapter-a2c1"
    assert second_context["scope"]["chapter_label"] == "第2卷第1章 旧城"
    assert second_context["chapter_state"]["fields"]["physical_state"] == "左眼失明"
    assert second_context["chapter_state"]["is_exact_anchor"] is True


@pytest.mark.asyncio
async def test_read_character_state_uses_latest_saved_chapter_at_or_before_anchor(
    session,
) -> None:
    await _seed_character_state_project(session)

    # (1,3) 本身没有状态；最近的已保存记录是 (1,2)，而不是后续的 (1,4) 或第二卷。
    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "林舟", "include_state": True, **_anchor(1, 3)},
    )

    context = result["state_context"]
    chapter_state = context["chapter_state"]
    assert context["scope"]["chapter_id"] == "chapter-a1c3"
    assert context["scope"]["chapter_label"] == "第1卷第3章 关城"
    assert chapter_state["state_id"] == "state-a1c2"
    assert chapter_state["chapter_id"] == "chapter-a1c2"
    assert chapter_state["is_exact_anchor"] is False
    assert chapter_state["requested_anchor"]["chapter_id"] == "chapter-a1c3"
    assert chapter_state["requested_anchor"]["chapter_label"] == "第1卷第3章 关城"
    assert chapter_state["fields"]["physical_state"] == "左肩受伤"
    assert "最近记录，非本章新确认" in chapter_state["provenance_note"]
    text = json.dumps(context, ensure_ascii=False)
    assert "最近记录，非本章新确认" in text
    assert "已死亡" not in text
    assert "觉醒异能" not in text
    assert "左眼失明" not in text


@pytest.mark.asyncio
async def test_read_character_state_orders_source_by_volume_before_repeated_chapter_order(
    session,
) -> None:
    await _seed_character_state_project(session)

    # 第二卷第 2 章：第二卷第 1 章才在锚点及之前最近；章序同为 2 的第一卷
    # 第 2 章不能被误选。
    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "林舟", "include_state": True, **_anchor(2, 2)},
    )

    chapter_state = result["state_context"]["chapter_state"]
    assert chapter_state["state_id"] == "state-a2c1"
    assert chapter_state["volume_order"] == 2
    assert chapter_state["chapter_order"] == 1
    assert chapter_state["chapter_label"] == "第2卷第1章 旧城"
    assert chapter_state["requested_anchor"]["chapter_label"] == "第2卷第2章 王都"
    assert chapter_state["is_exact_anchor"] is False
    assert chapter_state["fields"]["physical_state"] == "左眼失明"


@pytest.mark.asyncio
async def test_read_character_state_without_prior_record_is_unknown_despite_future_and_project_state(
    session,
) -> None:
    await _seed_character_state_project(session)

    # 沈墨只有 (1,2) 的后章状态与项目级常设状态，锚点 (1,1) 之前没有记录。
    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "沈墨", "include_state": True, **_anchor(1, 1)},
    )

    context = result["state_context"]
    assert context["chapter_state"] is None
    assert context["status"] == "no_records"
    assert any(
        "第1卷第1章 雨夜 的章级状态：未记录" in note for note in context["unknowns"]
    )
    # 项目级常设状态不被读取，也不充当锚点前的历史证据。
    assert "project_state" not in context
    assert any(
        "项目级常设状态没有章节来源" in note and "不作为历史证据" in note
        for note in context["unknowns"]
    )
    text = json.dumps(context, ensure_ascii=False)
    assert "后章受伤" not in text
    assert "常设受伤" not in text


@pytest.mark.asyncio
async def test_read_character_state_excludes_future_volume_with_huge_chapter_order(
    session,
) -> None:
    from app.storage.repos import character_extension_repo

    await _seed_character_state_project(session)

    # 旧实现用 Volume.order * 1_000_000 + Chapter.order，锚点 (1, 1_499_999)
    # 的值 2_499_999 会把第二卷（2_000_001 / 2_000_002）误判为锚点之前。
    before_huge = await character_extension_repo.get_latest_state_at_anchor(
        session,
        project_id=CHARACTER_STATE_PROJECT_ID,
        character_id="char-hi",
        volume_order=1,
        chapter_order=HUGE_CHAPTER_ORDER - 1,
    )
    assert before_huge is None

    # 锚点 (2,1) 之前最近的是第一卷超过 1_000_000 的章节，而不是第二卷。
    cross_volume = await character_extension_repo.get_latest_state_at_anchor(
        session,
        project_id=CHARACTER_STATE_PROJECT_ID,
        character_id="char-hi",
        volume_order=2,
        chapter_order=1,
    )
    assert cross_volume is not None
    assert cross_volume.state.id == "state-a1hi"
    assert cross_volume.volume_order == 1
    assert cross_volume.chapter_order == HUGE_CHAPTER_ORDER

    tool = _character_state_tool()
    unknown = await _invoke_character_tool(
        tool,
        session,
        {"name": "迟舟", "include_state": True, **_anchor(1, HUGE_CHAPTER_ORDER - 1)},
    )
    assert unknown["state_context"]["chapter_state"] is None
    assert "未来卷状态" not in json.dumps(unknown, ensure_ascii=False)

    exact = await _invoke_character_tool(
        tool, session, {"name": "迟舟", "include_state": True, **_anchor(1, HUGE_CHAPTER_ORDER)}
    )
    chapter_state = exact["state_context"]["chapter_state"]
    assert chapter_state["state_id"] == "state-a1hi"
    assert chapter_state["chapter_order"] == HUGE_CHAPTER_ORDER
    assert chapter_state["is_exact_anchor"] is True
    assert chapter_state["fields"]["physical_state"] == "长章旧伤"
    assert "未来卷状态" not in json.dumps(exact, ensure_ascii=False)


@pytest.mark.asyncio
async def test_read_character_state_query_excludes_future_death_and_ability(
    session,
) -> None:
    await _seed_character_state_project(session)

    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "林舟", "include_state": True, **_anchor(1, 3)},
    )

    text = json.dumps(result, ensure_ascii=False)
    # 锚点 (1,3) 能读到的是 (1,2) 的已伤状态；更早的 (1,1) 不是最近记录。
    chapter_state = result["state_context"]["chapter_state"]
    assert chapter_state["state_id"] == "state-a1c2"
    assert chapter_state["fields"]["physical_state"] == "左肩受伤"
    assert "手腕轻伤" not in text
    assert "已死亡" not in text
    assert "觉醒异能" not in text
    assert "左眼失明" not in text


@pytest.mark.asyncio
async def test_repo_state_at_anchor_returns_real_sql_source(session) -> None:
    from app.storage.repos import character_extension_repo

    await _seed_character_state_project(session)

    # 同一锚点：本章记录优先。
    exact = await character_extension_repo.get_latest_state_at_anchor(
        session,
        project_id=CHARACTER_STATE_PROJECT_ID,
        character_id="char-a",
        volume_order=1,
        chapter_order=2,
    )
    assert exact is not None
    assert exact.chapter_id == "chapter-a1c2"
    assert exact.state.id == "state-a1c2"
    assert exact.volume_id == "volume-a1"
    assert exact.volume_order == 1
    assert exact.chapter_title == "渡口"

    # 锚点前最近一条；章节 order 跨卷重复时按 (卷序, 章序) 比较。
    prior = await character_extension_repo.get_latest_state_at_anchor(
        session,
        project_id=CHARACTER_STATE_PROJECT_ID,
        character_id="char-a",
        volume_order=1,
        chapter_order=3,
    )
    assert prior is not None
    assert prior.state.id == "state-a1c2"
    across_volumes = await character_extension_repo.get_latest_state_at_anchor(
        session,
        project_id=CHARACTER_STATE_PROJECT_ID,
        character_id="char-a",
        volume_order=2,
        chapter_order=2,
    )
    assert across_volumes is not None
    assert across_volumes.state.id == "state-a2c1"
    assert (across_volumes.volume_order, across_volumes.chapter_order) == (2, 1)

    # 锚点之前没有记录时返回 None，不会回退到后章或项目级常设状态。
    missing = await character_extension_repo.get_latest_state_at_anchor(
        session,
        project_id=CHARACTER_STATE_PROJECT_ID,
        character_id="char-late",
        volume_order=1,
        chapter_order=1,
    )
    assert missing is None

    # 项目、角色归属不一致时查不到。
    cross_project = await character_extension_repo.get_latest_state_at_anchor(
        session,
        project_id=CHARACTER_STATE_OTHER_PROJECT_ID,
        character_id="char-a",
        volume_order=2,
        chapter_order=2,
    )
    assert cross_project is None


@pytest.mark.asyncio
async def test_read_character_historical_anchor_never_includes_future_chapter_state(
    session,
) -> None:
    await _seed_character_state_project(session)

    early = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "林舟", "include_state": True, **_anchor(1, 1)},
    )

    text = json.dumps(early["state_context"], ensure_ascii=False)
    assert "手腕轻伤" in text
    assert "左肩受伤" not in text
    assert "左眼失明" not in text
    # 项目级常设状态完全不进入章节状态输出。
    assert early["state_context"]["chapter_state"]["state_id"] == "state-a1c1"
    assert "state-a-project" not in text


@pytest.mark.asyncio
async def test_read_character_rejects_partial_chapter_anchor(session) -> None:
    await _seed_character_state_project(session)

    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "林舟", "include_state": True, "chapter_ref": {"type": "order", "value": 1}},
    )

    assert result["success"] is False
    assert "必须同时提供" in result["message"]


@pytest.mark.asyncio
async def test_read_character_unknown_anchor_fails_instead_of_guessing(
    session,
) -> None:
    await _seed_character_state_project(session)

    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "林舟", "include_state": True, **_anchor(1, 99)},
    )

    assert result["success"] is False
    assert "未找到章节" in result["message"]


@pytest.mark.asyncio
async def test_read_character_state_is_strictly_project_isolated(session) -> None:
    from app.storage.models.character_state import CharacterState

    await _seed_character_state_project(session)
    # 即使库里存在归属错配的状态行，也不能通过当前项目查询读到。
    # 1) 状态自身属于其他项目；2) 状态项目正确但绑定的章节属于其他项目。
    session.add(
        CharacterState(
            id="state-cross",
            character_id="char-a",
            project_id=CHARACTER_STATE_OTHER_PROJECT_ID,
            chapter_id="chapter-a1c1",
            physical_state="跨项目越权状态",
        )
    )
    session.add(
        CharacterState(
            id="state-cross-chapter",
            character_id="char-a",
            project_id=CHARACTER_STATE_PROJECT_ID,
            chapter_id="chapter-b1c1",
            physical_state="跨项目章节状态",
        )
    )
    await session.flush()

    own = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "林舟", "include_state": True, **_anchor(1, 1)},
    )
    other = await _invoke_character_tool(
        _character_state_tool(CHARACTER_STATE_OTHER_PROJECT_ID),
        session,
        {"name": "林舟", "include_state": True, **_anchor(1, 1)},
    )

    own_text = json.dumps(own, ensure_ascii=False)
    other_text = json.dumps(other, ensure_ascii=False)
    assert own["state_context"]["character_id"] == "char-a"
    assert own["state_context"]["chapter_state"]["state_id"] == "state-a1c1"
    assert "其他项目章级状态" not in own_text
    assert "跨项目越权状态" not in own_text
    assert "跨项目章节状态" not in own_text
    assert "其他项目身份" not in own_text

    assert other["state_context"]["character_id"] == "char-b"
    assert other["description"] == "1|旅人"
    assert other["state_context"]["chapter_state"]["state_id"] == "state-b1c1"
    assert "手腕轻伤" not in other_text


@pytest.mark.asyncio
async def test_read_character_state_reports_unknowns_for_legacy_character_without_state(
    session,
) -> None:
    from app.storage.models.character import Character
    from app.storage.models.project import Project

    session.add(Project(id=CHARACTER_STATE_PROJECT_ID, title="旧项目"))
    session.add(
        Character(
            id="char-legacy",
            project_id=CHARACTER_STATE_PROJECT_ID,
            name="无状态角色",
            description="旧项目角色",
        )
    )
    await session.flush()

    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "无状态角色", "include_state": True},
    )

    context = result["state_context"]
    assert result["name"] == "无状态角色"
    assert context["status"] == "no_records"
    assert context["chapter_state"] is None
    assert context["scope"] is None
    assert context["unknowns"]
    assert context["budget"]["chars"] <= context["budget"]["max_chars"]
    assert context["budget"]["tokens"] <= context["budget"]["max_tokens"]


@pytest.mark.asyncio
async def test_read_character_state_respects_budget_and_marks_omitted_fields(
    session,
) -> None:
    from app.storage.models.character import Character
    from app.storage.models.character_profile import CharacterProfile
    from app.storage.models.character_state import CharacterState
    from app.storage.models.chapter import Chapter
    from app.storage.models.project import Project
    from app.storage.models.volume import Volume

    session.add(Project(id=CHARACTER_STATE_PROJECT_ID, title="长状态项目"))
    session.add(
        Volume(id="volume-long", project_id=CHARACTER_STATE_PROJECT_ID, title="长卷", order=1)
    )
    session.add(
        Chapter(
            id="chapter-long",
            project_id=CHARACTER_STATE_PROJECT_ID,
            volume_id="volume-long",
            title="长章",
            content="",
            order=1,
        )
    )
    session.add(
        Character(
            id="char-long",
            project_id=CHARACTER_STATE_PROJECT_ID,
            name="沈墨",
            description="旧档",
        )
    )
    session.add(
        CharacterProfile(
            id="profile-long",
            character_id="char-long",
            identity="镖师",
            background="旧事" * 600,
        )
    )
    session.add(
        CharacterState(
            id="state-long",
            character_id="char-long",
            project_id=CHARACTER_STATE_PROJECT_ID,
            chapter_id="chapter-long",
            location="渡口",
            physical_state="手腕轻伤",
            mental_state="",
            notes="雨夜" * 4_000,
        )
    )
    session.add(
        CharacterState(
            id="state-long-project",
            character_id="char-long",
            project_id=CHARACTER_STATE_PROJECT_ID,
            chapter_id=None,
            physical_state="左手旧伤",
        )
    )
    await session.flush()

    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "沈墨", "include_state": True, **_anchor(1, 1)},
    )
    context = result["state_context"]
    chapter_state = context["chapter_state"]

    assert context["budget"]["chars"] <= context["budget"]["max_chars"]
    assert context["budget"]["tokens"] <= context["budget"]["max_tokens"]
    assert context["status"] == "truncated"
    assert context["budget"]["truncated"] is True
    assert chapter_state["state_id"] == "state-long"
    assert chapter_state["chapter_id"] == "chapter-long"
    assert chapter_state["fields"]["physical_state"] == "手腕轻伤"
    assert chapter_state["fields"]["location"] == "渡口"
    # 空字段与预算省略分开：mental_state 未记录，notes 因预算整项省略。
    assert "mental_state" in chapter_state["unknown_fields"]
    assert "notes" in chapter_state["omitted_fields"]
    assert "notes" not in chapter_state["fields"]
    text = json.dumps(result, ensure_ascii=False)
    assert "雨夜" * 10 not in text
    # 扩展档案不再展开；项目级常设状态也不读取。
    assert "旧事" not in text
    assert "左手旧伤" not in text


@pytest.mark.asyncio
async def test_read_character_state_negation_is_whole_field_or_omitted(session) -> None:
    from app.storage.models.character import Character
    from app.storage.models.character_state import CharacterState
    from app.storage.models.chapter import Chapter
    from app.storage.models.project import Project
    from app.storage.models.volume import Volume

    session.add(Project(id=CHARACTER_STATE_PROJECT_ID, title="否定词项目"))
    session.add(
        Volume(id="volume-n", project_id=CHARACTER_STATE_PROJECT_ID, title="卷", order=1)
    )
    session.add(
        Chapter(
            id="chapter-n",
            project_id=CHARACTER_STATE_PROJECT_ID,
            volume_id="volume-n",
            title="章",
            content="",
            order=1,
        )
    )
    session.add(
        Character(
            id="char-n",
            project_id=CHARACTER_STATE_PROJECT_ID,
            name="白露",
            description="医者",
        )
    )
    session.add(
        CharacterState(
            id="state-n",
            character_id="char-n",
            project_id=CHARACTER_STATE_PROJECT_ID,
            chapter_id="chapter-n",
            physical_state="伤势稳定",
            notes="伤势记录：" + "平稳。" * 3_000 + "并未死亡，意识清醒。",
        )
    )
    await session.flush()

    result = await _invoke_character_tool(
        _character_state_tool(),
        session,
        {"name": "白露", "include_state": True, **_anchor(1, 1)},
    )
    chapter_state = result["state_context"]["chapter_state"]
    assert chapter_state["fields"]["physical_state"] == "伤势稳定"
    assert "notes" in chapter_state["omitted_fields"]
    assert "notes" not in chapter_state["fields"]
    text = json.dumps(result, ensure_ascii=False)
    # 省略是整项省略：不会只留下否定词后缀造成误导，也不会保留半句。
    assert "伤势记录" not in text
    assert "平稳。" not in text


@pytest.mark.asyncio
async def test_read_character_state_whole_opt_in_output_is_hard_bounded(session) -> None:
    from app.core.character_state_context import MAX_CONTEXT_CHARS, MAX_CONTEXT_TOKENS
    from app.storage.models.character import Character
    from app.storage.models.character_profile import CharacterProfile
    from app.storage.models.character_state import CharacterState
    from app.storage.models.chapter import Chapter
    from app.storage.models.project import Project
    from app.storage.models.volume import Volume

    long_name = "长名" * 300
    huge = "旧事" * 50_000
    session.add(Project(id=CHARACTER_STATE_PROJECT_ID, title="超长输出项目"))
    session.add(
        Volume(id="volume-huge", project_id=CHARACTER_STATE_PROJECT_ID, title="长卷", order=1)
    )
    session.add(
        Chapter(
            id="chapter-huge",
            project_id=CHARACTER_STATE_PROJECT_ID,
            volume_id="volume-huge",
            title="长章",
            content="",
            order=1,
        )
    )
    session.add(
        Character(
            id="char-huge",
            project_id=CHARACTER_STATE_PROJECT_ID,
            name=long_name,
            description="\n".join("描述内容" * 20 for _ in range(400)),
        )
    )
    session.add(
        CharacterProfile(
            id="profile-huge",
            character_id="char-huge",
            identity="镖师",
            background=huge,
        )
    )
    session.add(
        CharacterState(
            id="state-huge",
            character_id="char-huge",
            project_id=CHARACTER_STATE_PROJECT_ID,
            chapter_id="chapter-huge",
            location="渡口",
            physical_state="手腕轻伤",
            mental_state=huge,
            goal=huge,
            relationship_note=huge,
            notes=huge,
        )
    )
    session.add(
        CharacterState(
            id="state-huge-project",
            character_id="char-huge",
            project_id=CHARACTER_STATE_PROJECT_ID,
            chapter_id=None,
            physical_state="左手旧伤",
        )
    )
    await session.flush()

    raw = await _character_state_tool().ainvoke(
        {"name": long_name, "include_state": True, **_anchor(1, 1)},
        config={"configurable": {"db_session": session}},
    )
    result = json.loads(raw)
    context = result["state_context"]

    # 硬上限覆盖整份 JSON，包括名称、描述、来源、unknowns 与预算数字。
    assert len(raw) <= MAX_CONTEXT_CHARS
    assert context["budget"]["chars"] == len(raw)
    assert context["budget"]["tokens"] <= MAX_CONTEXT_TOKENS
    assert context["budget"]["truncated"] is True
    assert context["status"] == "truncated"
    assert result["name"] is None
    assert result["name_omitted"] is True
    assert result["description"] is None
    assert result["description_omitted"] is True
    assert any("描述超出读取预算未列出" in note for note in context["unknowns"])
    # 来源不可被静默丢弃；地点 / 身体状态优先于描述。
    chapter_state = context["chapter_state"]
    assert chapter_state["chapter_id"] == "chapter-huge"
    assert chapter_state["requested_anchor"]["chapter_id"] == "chapter-huge"
    assert chapter_state["fields"]["physical_state"] == "手腕轻伤"
    assert chapter_state["fields"]["location"] == "渡口"
    # 预算丢弃的字段显式列出，且巨大文本没有被截半输出。
    assert set(chapter_state["omitted_fields"]) == {
        "mental_state", "goal", "relationship_note", "notes"
    }
    assert "旧事" not in raw
    assert "长名" not in raw


@pytest.mark.asyncio
async def test_create_character_returns_diff() -> None:
    from app.agent_runtime.tools.impls.context.character import CreateCharacterTool

    tool = CreateCharacterTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    created = SimpleNamespace(
        id="char-1",
        project_id="proj-1",
        name="林舟",
        description="主角",
        image_path=None,
        is_favorited=False,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.character.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.character.character_repo"
    ) as mock_character_repo, patch(
        "app.agent_runtime.tools.impls.context.character.character_service"
    ) as mock_character_service, patch(
        "app.agent_runtime.tools.impls.context.character.record_character_diffs"
    ) as mock_record_diffs:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_character_repo.list_all_by_project = AsyncMock(return_value=[])
        mock_character_service.create_character = AsyncMock(return_value=created)
        mock_record_diffs.return_value = ["char-1"]

        result = await tool.ainvoke({"name": "林舟", "description": "主角"})

    data = json.loads(result)
    assert set(data) == {"success", "metadata"}
    assert data["success"] is True
    assert data["metadata"]["character_diff"] == {
        "operation": "create",
        "character_id": "char-1",
        "character_name": "林舟",
        "sections": [
            {
                "type": "content",
                "lines": [
                    {
                        "type": "added",
                        "before_line_number": None,
                        "after_line_number": 1,
                        "text": "主角",
                    }
                ],
            }
        ],
    }


async def test_create_character_serializes_parallel_creates_per_project() -> None:
    from app.agent_runtime.tools.impls import _locks
    from app.agent_runtime.tools.impls.context import character as ch

    _locks._LOCKS.clear()
    entered = asyncio.Event()
    release = asyncio.Event()
    call_count = 0

    async def list_characters(*_args, **_kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            entered.set()
            await release.wait()
        return []

    created = SimpleNamespace(id="char-1", project_id="proj-1", name="林舟", description="主角")
    ch_name = "app.agent_runtime.tools.impls.context.character"
    with patch(f"{ch_name}.create_session") as mock_cs, patch(
        f"{ch_name}.character_repo"
    ) as mock_repo, patch(
        f"{ch_name}.character_service"
    ) as mock_service, patch(
        f"{ch_name}.record_character_diffs", AsyncMock()
    ):
        mock_cs.return_value = AsyncMock()
        mock_repo.list_all_by_project = AsyncMock(side_effect=list_characters)
        mock_service.create_character = AsyncMock(return_value=created)

        def make_tool():
            return ch.CreateCharacterTool(
                _state={**_make_state(), "current_revision_id": "rev-1"}
            )

        task1 = asyncio.create_task(
            make_tool().ainvoke({"name": "林舟", "description": "主角"})
        )
        await entered.wait()
        task2 = asyncio.create_task(
            make_tool().ainvoke({"name": "林舟", "description": "主角"})
        )
        await asyncio.sleep(0.05)
        assert not task2.done()
        release.set()
        await asyncio.gather(task1, task2)


@pytest.mark.asyncio
async def test_create_character_rejects_over_limit_description_without_creating() -> None:
    from app.agent_runtime.tools.impls.context.character import CreateCharacterTool

    tool = CreateCharacterTool(_state={**_make_state(), "current_revision_id": "rev-1"})

    with patch(
        "app.agent_runtime.tools.impls.context.character.character_service"
    ) as mock_character_service:
        mock_character_service.create_character = AsyncMock()

        result = await tool.ainvoke(
            {"name": "林舟", "description": "\n".join("内容" for _ in range(2001))}
        )

    assert "内容超出限制" in json.loads(result)["message"]
    mock_character_service.create_character.assert_not_awaited()


def test_edit_character_input_rejects_empty_old_description() -> None:
    from pydantic import ValidationError

    from app.agent_runtime.tools.impls.context.character import EditCharacterInput

    with pytest.raises(ValidationError):
        EditCharacterInput.model_validate({
            "name": "林舟",
            "old_description": "",
            "new_description": "x",
        })


@pytest.mark.asyncio
async def test_edit_character_replaces_description_text() -> None:
    from app.agent_runtime.tools.impls.context.character import EditCharacterTool

    tool = EditCharacterTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    character = SimpleNamespace(
        id="char-1",
        project_id="proj-1",
        name="林舟",
        description="主角",
        is_favorited=False,
    )
    updated_character = SimpleNamespace(
        id="char-1",
        project_id="proj-1",
        name="林舟",
        description="主角与旧友",
        is_favorited=True,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.character.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.character.character_repo"
    ) as mock_character_repo, patch(
        "app.agent_runtime.tools.impls.context.character.character_service"
    ) as mock_character_service, patch(
        "app.agent_runtime.tools.impls.context.character.record_character_diffs"
    ) as mock_record_diffs:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_character_repo.list_all_by_project = AsyncMock(return_value=[character])
        mock_character_service.update_character = AsyncMock(return_value=updated_character)
        mock_record_diffs.return_value = ["char-1"]

        result = await tool.ainvoke(
            {
                "name": "林舟",
                "old_description": "主角",
                "new_description": "主角与旧友",
            }
        )

    data = json.loads(result)
    assert set(data) == {"success", "metadata"}
    assert data["success"] is True
    assert data["metadata"]["character_diff"]["operation"] == "edit"
    assert data["metadata"]["character_diff"]["sections"][0]["lines"] == [
        {
            "type": "removed",
            "before_line_number": 1,
            "after_line_number": None,
            "text": "主角",
        },
        {
            "type": "added",
            "before_line_number": None,
            "after_line_number": 1,
            "text": "主角与旧友",
        },
    ]


@pytest.mark.asyncio
async def test_edit_character_rejects_over_limit_replacement_without_updating() -> None:
    from app.agent_runtime.tools.impls.context.character import EditCharacterTool

    tool = EditCharacterTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    character = SimpleNamespace(
        id="char-1",
        project_id="proj-1",
        name="林舟",
        description="旧内容",
        is_favorited=False,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.character.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.character.character_repo"
    ) as mock_character_repo, patch(
        "app.agent_runtime.tools.impls.context.character.character_service"
    ) as mock_character_service:
        mock_cs.return_value = AsyncMock()
        mock_character_repo.list_all_by_project = AsyncMock(return_value=[character])
        mock_character_service.update_character = AsyncMock()

        result = await tool.ainvoke(
            {
                "name": "林舟",
                "old_description": "旧内容",
                "new_description": "\n".join("内容" for _ in range(2001)),
            }
        )

    assert "内容超出限制" in json.loads(result)["message"]
    mock_character_service.update_character.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_character_removes_name() -> None:
    from app.agent_runtime.tools.impls.context.character import DeleteCharacterTool

    tool = DeleteCharacterTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    character = SimpleNamespace(
        id="char-1",
        project_id="proj-1",
        name="林舟",
        description="主角",
        is_favorited=False,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.character.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.character.character_repo"
    ) as mock_character_repo, patch(
        "app.agent_runtime.tools.impls.context.character.character_service"
    ) as mock_character_service, patch(
        "app.agent_runtime.tools.impls.context.character.capture_character_extensions",
        new=AsyncMock(return_value={"version": 1}),
    ), patch(
        "app.agent_runtime.tools.impls.context.character.record_character_diffs"
    ) as mock_record_diffs:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_character_repo.list_all_by_project = AsyncMock(return_value=[character])
        mock_character_service.delete_character = AsyncMock(return_value=None)
        mock_record_diffs.return_value = ["char-1"]

        result = await tool.ainvoke({"name": "林舟"})

    data = json.loads(result)
    assert set(data) == {"success", "metadata"}
    assert data["success"] is True
    assert data["metadata"]["character_diff"]["operation"] == "delete"
    assert data["metadata"]["character_diff"]["character_id"] == "char-1"
    assert data["metadata"]["character_diff"]["character_name"] == "林舟"


@pytest.mark.asyncio
async def test_list_world_entries_returns_enabled_entry_titles() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import ListWorldEntriesTool

    tool = ListWorldEntriesTool(_state=_make_state())
    entries = [
        SimpleNamespace(id="e1", name="主角", uid=1, order=1, content="林舟"),
        SimpleNamespace(id="e2", name="势力", uid=2, order=2, content="青岚会"),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_entry_meta_service.is_entry_ai_visible",
        new=AsyncMock(return_value=True),
    ):
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_enabled_by_world_info = AsyncMock(return_value=entries)

        result = await tool.ainvoke({})

    assert json.loads(result) == {
        "entries": [
            {"title": "主角", "uid": 1, "order": 1},
            {"title": "势力", "uid": 2, "order": 2},
        ]
    }


@pytest.mark.asyncio
async def test_list_world_entries_omits_ai_hidden_entries() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import ListWorldEntriesTool

    tool = ListWorldEntriesTool(_state=_make_state())
    entries = [
        SimpleNamespace(id="visible", name="公开", uid=1, order=1),
        SimpleNamespace(id="hidden", name="秘密", uid=2, order=2),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_entry_meta_service.is_entry_ai_visible",
        new=AsyncMock(side_effect=lambda _session, entry_id: entry_id == "visible"),
    ):
        mock_cs.return_value = AsyncMock()
        mock_world_repo.get_by_project_id = AsyncMock(
            return_value=SimpleNamespace(id="world-1")
        )
        mock_entry_repo.list_enabled_by_world_info = AsyncMock(return_value=entries)

        result = await tool.ainvoke({})

    assert json.loads(result) == {
        "entries": [{"title": "公开", "uid": 1, "order": 1}]
    }


@pytest.mark.asyncio
async def test_read_world_entry_reads_content_by_title() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import ReadWorldEntryTool

    tool = ReadWorldEntryTool(_state=_make_state())
    entries = [
        SimpleNamespace(id="e1", name="主角", uid=1, order=1, content="林舟\n旧友"),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_entry_meta_service.is_entry_ai_visible",
        new=AsyncMock(return_value=True),
    ):
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(return_value=entries)

        result = await tool.ainvoke({"title": "主角"})

    assert json.loads(result) == {
        "title": "主角",
        "uid": 1,
        "order": 1,
        "content": "1|林舟\n2|旧友",
    }


@pytest.mark.asyncio
async def test_read_world_entry_rejects_ai_hidden_content() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import ReadWorldEntryTool

    tool = ReadWorldEntryTool(_state=_make_state())
    hidden_content = "作者秘密：角色其实是皇族。"
    entry = SimpleNamespace(
        id="hidden",
        name="隐藏设定",
        uid=1,
        order=1,
        content=hidden_content,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_entry_meta_service.is_entry_ai_visible",
        new=AsyncMock(return_value=False),
    ):
        mock_cs.return_value = AsyncMock()
        mock_world_repo.get_by_project_id = AsyncMock(
            return_value=SimpleNamespace(id="world-1")
        )
        mock_entry_repo.list_all_by_world_info = AsyncMock(return_value=[entry])

        result = await tool.ainvoke({"title": "隐藏设定"})

    data = json.loads(result)
    assert data["type"] == "fail"
    assert hidden_content not in json.dumps(data, ensure_ascii=False)


@pytest.mark.asyncio
async def test_read_world_entry_rejects_duplicate_titles() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import ReadWorldEntryTool

    tool = ReadWorldEntryTool(_state=_make_state())
    entries = [
        SimpleNamespace(id="e1", name="主角", uid=1, order=1, content="一"),
        SimpleNamespace(id="e2", name="主角", uid=2, order=2, content="二"),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(return_value=entries)

        result = await tool.ainvoke({"title": "主角"})

    data = json.loads(result)
    assert data["type"] == "fail"
    assert data["message"] == "世界书条目标题不唯一: 主角"


@pytest.mark.asyncio
async def test_create_world_entry_returns_diff() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import CreateWorldEntryTool

    tool = CreateWorldEntryTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    created = SimpleNamespace(
        id="e1",
        world_info_id="world-1",
        name="主角",
        uid=1,
        order=1,
        content="林舟",
        token_count=2,
        is_enabled=True,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_service"
    ) as mock_entry_service, patch(
        "app.agent_runtime.tools.impls.context.world_entry.record_world_entry_diffs"
    ) as mock_record_diffs:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(return_value=[])
        mock_entry_service.create_entry = AsyncMock(return_value=created)
        mock_record_diffs.return_value = ["e1"]

        result = await tool.ainvoke({"title": "主角", "content": "林舟"})

    data = json.loads(result)
    assert set(data) == {"success", "metadata"}
    assert data["success"] is True
    assert data["metadata"]["world_info_id"] == "world-1"
    assert data["metadata"]["world_entry_diff"] == {
        "operation": "create",
        "entry_id": "e1",
        "entry_title": "主角",
        "sections": [
            {
                "type": "content",
                "lines": [
                    {
                        "type": "added",
                        "before_line_number": None,
                        "after_line_number": 1,
                        "text": "林舟",
                    }
                ],
            }
        ],
    }


async def test_create_world_entry_serializes_parallel_creates_per_world() -> None:
    from app.agent_runtime.tools.impls import _locks
    from app.agent_runtime.tools.impls.context import world_entry as we

    _locks._LOCKS.clear()
    entered = asyncio.Event()
    release = asyncio.Event()
    call_count = 0

    async def list_entries(*_args, **_kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            entered.set()
            await release.wait()
        return []

    created = SimpleNamespace(
        id="e1",
        world_info_id="world-1",
        uid=1,
        name="主角",
        order=1,
        content="林舟",
        token_count=2,
        is_enabled=True,
    )
    we_name = "app.agent_runtime.tools.impls.context.world_entry"
    with patch(f"{we_name}.create_session") as mock_cs, patch(
        f"{we_name}.world_info_repo"
    ) as mock_world_repo, patch(
        f"{we_name}.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        f"{we_name}.world_info_entry_service"
    ) as mock_entry_service, patch(
        f"{we_name}.record_world_entry_diffs", AsyncMock(return_value=["e1"])
    ):
        mock_cs.return_value = AsyncMock()
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(side_effect=list_entries)
        mock_entry_service.create_entry = AsyncMock(return_value=created)

        def make_tool():
            return we.CreateWorldEntryTool(
                _state={**_make_state(), "current_revision_id": "rev-1"}
            )

        task1 = asyncio.create_task(
            make_tool().ainvoke({"title": "主角", "content": "林舟"})
        )
        await entered.wait()
        task2 = asyncio.create_task(
            make_tool().ainvoke({"title": "配角", "content": "林舟"})
        )
        await asyncio.sleep(0.05)
        assert not task2.done()
        release.set()
        await asyncio.gather(task1, task2)


@pytest.mark.asyncio
async def test_create_world_entry_rejects_duplicate_title() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import CreateWorldEntryTool

    tool = CreateWorldEntryTool(_state={**_make_state(), "current_revision_id": "rev-1"})

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo:
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(
            return_value=[SimpleNamespace(id="e1", name="主角", uid=1, order=1, content="")]
        )

        result = await tool.ainvoke({"title": "主角", "content": "林舟"})

    data = json.loads(result)
    assert data["type"] == "fail"
    assert data["message"] == "世界书条目标题已存在: 主角"


@pytest.mark.asyncio
async def test_create_world_entry_rejects_over_limit_content_without_creating() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import CreateWorldEntryTool

    tool = CreateWorldEntryTool(_state={**_make_state(), "current_revision_id": "rev-1"})

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_service"
    ) as mock_entry_service:
        mock_entry_service.create_entry = AsyncMock()

        result = await tool.ainvoke(
            {"title": "主角", "content": "\n".join("内容" for _ in range(2001))}
        )

    assert "内容超出限制" in json.loads(result)["message"]
    mock_entry_service.create_entry.assert_not_awaited()


def test_edit_world_entry_input_rejects_empty_old_content() -> None:
    from pydantic import ValidationError

    from app.agent_runtime.tools.impls.context.world_entry import EditWorldEntryInput

    with pytest.raises(ValidationError):
        EditWorldEntryInput.model_validate({
            "title": "主角",
            "old_content": "",
            "new_content": "x",
        })


@pytest.mark.asyncio
async def test_edit_world_entry_returns_diff() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import EditWorldEntryTool

    tool = EditWorldEntryTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    entry = SimpleNamespace(
        id="e1",
        world_info_id="world-1",
        name="主角",
        uid=1,
        order=1,
        content="林舟",
        token_count=2,
        is_enabled=True,
    )
    updated_entry = SimpleNamespace(
        id="e1",
        world_info_id="world-1",
        name="主角",
        uid=1,
        order=1,
        content="林舟与旧友",
        token_count=2,
        is_enabled=True,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_service"
    ) as mock_entry_service, patch(
        "app.agent_runtime.tools.impls.context.world_entry.record_world_entry_diffs"
    ) as mock_record_diffs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_entry_meta_service.is_entry_ai_visible",
        new=AsyncMock(return_value=True),
    ):
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(return_value=[entry])
        mock_entry_service.update_entry = AsyncMock(return_value=updated_entry)
        mock_record_diffs.return_value = ["e1"]

        result = await tool.ainvoke(
            {"title": "主角", "old_content": "林舟", "new_content": "林舟与旧友"}
        )

    data = json.loads(result)
    assert set(data) == {"success", "metadata"}
    assert data["success"] is True
    assert data["metadata"]["world_entry_diff"]["operation"] == "edit"
    assert data["metadata"]["world_entry_diff"]["sections"] == [
        {
            "type": "content",
            "lines": [
                {
                    "type": "removed",
                    "before_line_number": 1,
                    "after_line_number": None,
                    "text": "林舟",
                },
                {
                    "type": "added",
                    "before_line_number": None,
                    "after_line_number": 1,
                    "text": "林舟与旧友",
                },
            ],
        }
    ]


@pytest.mark.asyncio
async def test_edit_world_entry_rejects_over_limit_replacement_without_updating() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import EditWorldEntryTool

    tool = EditWorldEntryTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    entry = SimpleNamespace(
        id="e1",
        world_info_id="world-1",
        name="主角",
        uid=1,
        order=1,
        content="旧内容",
        token_count=2,
        is_enabled=True,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_service"
    ) as mock_entry_service, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_entry_meta_service.is_entry_ai_visible",
        new=AsyncMock(return_value=True),
    ):
        mock_cs.return_value = AsyncMock()
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(return_value=[entry])
        mock_entry_service.update_entry = AsyncMock()

        result = await tool.ainvoke(
            {
                "title": "主角",
                "old_content": "旧内容",
                "new_content": "\n".join("内容" for _ in range(2001)),
            }
        )

    assert "内容超出限制" in json.loads(result)["message"]
    mock_entry_service.update_entry.assert_not_awaited()


@pytest.mark.asyncio
async def test_edit_world_entry_rejects_duplicate_new_title() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import EditWorldEntryTool

    tool = EditWorldEntryTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    entries = [
        SimpleNamespace(id="e1", name="主角", uid=1, order=1, content="林舟"),
        SimpleNamespace(id="e2", name="反派", uid=2, order=2, content="沈墨"),
    ]

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_entry_meta_service.is_entry_ai_visible",
        new=AsyncMock(return_value=True),
    ):
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(return_value=entries)

        result = await tool.ainvoke({"title": "主角", "new_title": "反派"})
    data = json.loads(result)
    assert data["type"] == "fail"
    assert data["message"] == "世界书条目标题已存在: 反派"


@pytest.mark.asyncio
async def test_delete_world_entry_removes_title() -> None:
    from app.agent_runtime.tools.impls.context.world_entry import DeleteWorldEntryTool

    tool = DeleteWorldEntryTool(_state={**_make_state(), "current_revision_id": "rev-1"})
    entry = SimpleNamespace(
        id="e1",
        world_info_id="world-1",
        name="主角",
        uid=1,
        order=1,
        content="林舟",
        token_count=2,
        is_enabled=True,
    )

    with patch(
        "app.agent_runtime.tools.impls.context.world_entry.create_session"
    ) as mock_cs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_repo"
    ) as mock_world_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_repo"
    ) as mock_entry_repo, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_info_entry_service"
    ) as mock_entry_service, patch(
        "app.agent_runtime.tools.impls.context.world_entry.capture_world_entry_extensions",
        new=AsyncMock(return_value={"version": 1}),
    ), patch(
        "app.agent_runtime.tools.impls.context.world_entry.record_world_entry_diffs"
    ) as mock_record_diffs, patch(
        "app.agent_runtime.tools.impls.context.world_entry.world_entry_meta_service.is_entry_ai_visible",
        new=AsyncMock(return_value=True),
    ):
        mock_session = AsyncMock()
        mock_cs.return_value = mock_session
        mock_world_repo.get_by_project_id = AsyncMock(return_value=SimpleNamespace(id="world-1"))
        mock_entry_repo.list_all_by_world_info = AsyncMock(return_value=[entry])
        mock_entry_service.delete_entry = AsyncMock(return_value=None)
        mock_record_diffs.return_value = ["e1"]

        result = await tool.ainvoke({"title": "主角"})

    data = json.loads(result)
    assert set(data) == {"success", "metadata"}
    assert data["success"] is True
    assert data["metadata"]["world_info_id"] == "world-1"
    assert data["metadata"]["world_entry_diff"]["operation"] == "delete"
    assert data["metadata"]["world_entry_diff"]["entry_id"] == "e1"
    assert data["metadata"]["world_entry_diff"]["entry_title"] == "主角"
