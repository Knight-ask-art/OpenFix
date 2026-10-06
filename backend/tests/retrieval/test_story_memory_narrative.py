# -*- coding: utf-8 -*-
"""Narrative Engine 叙事来源接入 Story Memory 的检索层测试。

覆盖：只索引已确认记录、世界事实与人物信念的语义标注互不串味、被取代 /
作废 / 失效的行排除、场景隐藏信息的作者可见标注、溯源截断、来源令牌指纹的
精确失效、新鲜度判定不读正文，以及叙事改动不会隐式触发全量重建。
"""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.background.jobs import service as background_service
from app.background.jobs.constants import JOB_TYPE_STORY_MEMORY_REBUILD
from app.background.jobs.states import JOB_STATUS_PENDING, JOB_STATUS_RUNNING
from app.retrieval.narrative_memory import (
    BELIEF_MARKER,
    MAX_ANCHOR_CHARS,
    SCENE_AUTHOR_ONLY_MARKER,
    WORLD_TRUTH_MARKER,
)
from app.retrieval.story_memory import (
    build_story_memory_documents,
    collect_story_memory_source_tokens,
    compute_story_memory_status,
    delete_project_story_memory_documents,
    fingerprint_story_memory_sources,
    story_document_id,
    story_memory_index_is_fresh,
    story_memory_index_key,
)
from app.retrieval.types import IndexDocument
from app.storage.models.note import Note
from app.storage.models.retrieval_index import RetrievalIndex
from app.storage.repos import note_repo, retrieval_index_repo

BASE = "/api/v1/projects/{project_id}/narrative"
MODEL_REF_ID = "model-ref-narrative-memory"


async def _create_project(client: AsyncClient, title: str = "叙事检索测试") -> str:
    response = await client.post("/api/v1/projects", data={"title": title})
    assert response.status_code == 201
    return response.json()["id"]


async def _create_character(
    client: AsyncClient, project_id: str, name: str = "林洛"
) -> str:
    response = await client.post(
        f"/api/v1/projects/{project_id}/characters",
        data={"name": name, "description": "记者"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_chapter(
    client: AsyncClient, project_id: str, title: str = "第一章 雨夜入城"
) -> str:
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": volumes[0]["id"], "title": title, "content": "正文"},
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create(
    client: AsyncClient, project_id: str, resource: str, payload: dict
) -> dict:
    response = await client.post(
        f"{BASE.format(project_id=project_id)}/{resource}", json=payload
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _patch(
    client: AsyncClient, project_id: str, resource: str, item_id: str, payload: dict
) -> dict:
    response = await client.patch(
        f"{BASE.format(project_id=project_id)}/{resource}/{item_id}", json=payload
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _confirm(
    client: AsyncClient, project_id: str, resource: str, item: dict
) -> dict:
    response = await client.post(
        f"{BASE.format(project_id=project_id)}/{resource}/{item['id']}/confirm",
        json={"expected_updated_at": item["updated_at"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _create_confirmed(
    client: AsyncClient, project_id: str, resource: str, payload: dict
) -> dict:
    return await _confirm(
        client, project_id, resource, await _create(client, project_id, resource, payload)
    )


def _documents(documents: list[IndexDocument], source: str) -> list[IndexDocument]:
    return [doc for doc in documents if doc.document_id.startswith(f"{source}:")]


def _ids(documents: list[IndexDocument], source: str) -> set[str]:
    return {doc.document_id for doc in _documents(documents, source)}


async def _tokens(session: AsyncSession, project_id: str) -> dict[str, str]:
    return await collect_story_memory_source_tokens(session, project_id)


async def _fingerprint(session: AsyncSession, project_id: str) -> str:
    return fingerprint_story_memory_sources(await _tokens(session, project_id))


async def _certify_index(session: AsyncSession, project_id: str) -> RetrievalIndex:
    """把索引行认证为「与当前源快照一致」，模拟一次成功的重建。"""
    fingerprint = await _fingerprint(session, project_id)
    row = await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    if row is None:
        row = RetrievalIndex(
            index_key=story_memory_index_key(project_id),
            table_name=f"story_memory_{project_id}",
            status="ready",
            embedding_model_ref_id=MODEL_REF_ID,
            embedding_model_id_snapshot="embed-1",
            embedding_dimensions_snapshot=3,
        )
        session.add(row)
    row.status = "ready"
    row.source_fingerprint = fingerprint
    await session.flush()
    return row


# ============================================
# 默认检索：只索引已确认记录
# ============================================


@pytest.mark.asyncio
async def test_narrative_sources_index_only_confirmed_rows(
    client: AsyncClient, session: AsyncSession
) -> None:
    project_id = await _create_project(client)
    candidate = await _create(
        client, project_id, "world-facts", {"statement": "北城常年阴雨"}
    )
    rejected = await _create(
        client,
        project_id,
        "world-facts",
        {"statement": "被拒绝的断言", "confirmation": "rejected"},
    )
    inferred = await _create(
        client,
        project_id,
        "world-facts",
        {"statement": "推断出来的断言", "confirmation": "inferred"},
    )

    # 候选 / 推断 / 拒绝的断言都不进入向量库，也不会出现在文档集合里。
    assert _documents(await build_story_memory_documents(session, project_id), "world_fact") == []

    confirmed = await _confirm(client, project_id, "world-facts", candidate)
    assert confirmed["confirmation"] == "confirmed"

    documents = await build_story_memory_documents(session, project_id)
    fact_docs = _documents(documents, "world_fact")
    assert [doc.document_id for doc in fact_docs] == [
        story_document_id("world_fact", candidate["id"])
    ]
    assert "北城常年阴雨" in fact_docs[0].text
    assert fact_docs[0].attributes["source"] == "world_fact"
    assert fact_docs[0].metadata["entity_id"] == candidate["id"]
    assert _ids(documents, "world_fact") == {
        story_document_id("world_fact", candidate["id"])
    }
    assert rejected["id"] not in {doc.metadata["entity_id"] for doc in fact_docs}
    assert inferred["id"] not in {doc.metadata["entity_id"] for doc in fact_docs}


@pytest.mark.asyncio
async def test_all_four_narrative_sources_are_indexed(
    client: AsyncClient, session: AsyncSession
) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)
    chapter_id = await _create_chapter(client, project_id)

    await _create_confirmed(
        client, project_id, "world-facts", {"statement": "北城常年阴雨"}
    )
    await _create_confirmed(
        client,
        project_id,
        "character-beliefs",
        {"character_id": character_id, "proposition": "北城的雨是诅咒"},
    )
    await _create_confirmed(
        client, project_id, "plotlines", {"title": "失踪的兄长"}
    )
    await _create_confirmed(
        client,
        project_id,
        "scene-plans",
        {"chapter_id": chapter_id, "goal": "让林洛发现线索"},
    )

    documents = await build_story_memory_documents(session, project_id)
    assert _documents(documents, "world_fact")
    assert _documents(documents, "character_belief")
    assert _documents(documents, "open_plotline")
    assert _documents(documents, "scene_state")
    assert all(doc.attributes["project_id"] == project_id for doc in documents)


# ============================================
# 世界事实与人物信念不得混用
# ============================================


@pytest.mark.asyncio
async def test_world_truth_and_belief_are_labelled_separately(
    client: AsyncClient, session: AsyncSession
) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id, "林洛")
    await _create_confirmed(
        client, project_id, "world-facts", {"statement": "北城常年阴雨"}
    )
    belief = await _create(
        client,
        project_id,
        "character-beliefs",
        {"character_id": character_id, "proposition": "北城的雨是诅咒"},
    )
    belief = await _patch(
        client, project_id, "character-beliefs", belief["id"], {"belief_state": "mistaken"}
    )
    await _confirm(client, project_id, "character-beliefs", belief)

    documents = await build_story_memory_documents(session, project_id)
    fact_text = _documents(documents, "world_fact")[0].text
    belief_text = _documents(documents, "character_belief")[0].text

    assert WORLD_TRUTH_MARKER in fact_text
    assert BELIEF_MARKER not in fact_text

    assert BELIEF_MARKER in belief_text
    # 已确认的误解依然是「人物相信」，绝不能写成世界事实。
    assert WORLD_TRUTH_MARKER not in belief_text
    assert "林洛" in belief_text
    assert "误解" in belief_text
    assert "北城的雨是诅咒" in belief_text


# ============================================
# 取代 / 作废 / 失效 / 已了结的行必须排除
# ============================================


@pytest.mark.asyncio
async def test_superseded_retired_and_closed_rows_are_excluded(
    client: AsyncClient, session: AsyncSession
) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)

    old_fact = await _create_confirmed(
        client, project_id, "world-facts", {"statement": "北城只有一座城门"}
    )
    new_fact = await _create_confirmed(
        client, project_id, "world-facts", {"statement": "北城有三座城门"}
    )
    superseded = await _patch(
        client,
        project_id,
        "world-facts",
        old_fact["id"],
        {"superseded_by_id": new_fact["id"]},
    )
    assert superseded["status"] == "retired"

    retired_fact = await _create_confirmed(
        client, project_id, "world-facts", {"statement": "已经作废的设定"}
    )
    await _patch(
        client, project_id, "world-facts", retired_fact["id"], {"status": "retired"}
    )

    old_belief = await _create_confirmed(
        client,
        project_id,
        "character-beliefs",
        {"character_id": character_id, "proposition": "旧信念"},
    )
    new_belief = await _create_confirmed(
        client,
        project_id,
        "character-beliefs",
        {"character_id": character_id, "proposition": "新信念"},
    )
    await _patch(
        client,
        project_id,
        "character-beliefs",
        old_belief["id"],
        {"superseded_by_id": new_belief["id"]},
    )

    invalidated_belief = await _create_confirmed(
        client,
        project_id,
        "character-beliefs",
        {"character_id": character_id, "proposition": "已失效的信念"},
    )
    await _patch(
        client,
        project_id,
        "character-beliefs",
        invalidated_belief["id"],
        {"invalidated_at": "2026-01-01T00:00:00Z"},
    )

    resolved = await _create_confirmed(
        client, project_id, "plotlines", {"title": "已了结的情节线"}
    )
    await _patch(
        client, project_id, "plotlines", resolved["id"], {"state": "resolved"}
    )
    still_open = await _create_confirmed(
        client, project_id, "plotlines", {"title": "仍未兑现的情节线"}
    )

    documents = await build_story_memory_documents(session, project_id)

    assert _ids(documents, "world_fact") == {
        story_document_id("world_fact", new_fact["id"])
    }
    assert _ids(documents, "character_belief") == {
        story_document_id("character_belief", new_belief["id"])
    }
    assert _ids(documents, "open_plotline") == {
        story_document_id("open_plotline", still_open["id"])
    }


# ============================================
# 场景隐藏信息只属于作者
# ============================================


@pytest.mark.asyncio
async def test_scene_hidden_information_is_author_only(
    client: AsyncClient, session: AsyncSession
) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id, "第三章 雨夜入城")
    character_id = await _create_character(client, project_id, "林洛")
    plan = await _create(
        client,
        project_id,
        "scene-plans",
        {
            "chapter_id": chapter_id,
            "scene_index": 1,
            "goal": "让林洛发现客栈的异常",
            "pov_character_id": character_id,
            "location": "北城客栈",
            "tone": "压抑",
            "known_information": ["门外有人走动"],
            "hidden_information": ["真凶其实是管家"],
            "world_constraints": ["夜间宵禁"],
        },
    )
    await _confirm(client, project_id, "scene-plans", plan)

    documents = await build_story_memory_documents(session, project_id)
    scene_docs = _documents(documents, "scene_state")
    assert len(scene_docs) == 1
    text = scene_docs[0].text

    assert "第三章 雨夜入城" in text
    assert "林洛" in text
    assert "北城客栈" in text
    assert "门外有人走动" in text
    assert "真凶其实是管家" in text

    # 隐藏信息必须落在作者可见区块内，且整段标注不得出现在已知信息区块之前。
    author_only_index = text.index(SCENE_AUTHOR_ONLY_MARKER)
    hidden_index = text.index("真凶其实是管家")
    known_index = text.index("本场已知信息")
    assert known_index < author_only_index < hidden_index
    # 「本场已知信息」与「仅作者可见信息」是两个互不重叠的区块：
    # 隐藏信息不得出现在已知区块里。
    assert "真凶其实是管家" not in text[known_index:author_only_index]


# ============================================
# 溯源有界
# ============================================


@pytest.mark.asyncio
async def test_provenance_is_bounded_and_does_not_dump_full_anchor(
    client: AsyncClient, session: AsyncSession
) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id)
    long_anchor = "锚" * 200
    fact = await _create_confirmed(
        client,
        project_id,
        "world-facts",
        {
            "statement": "北城常年阴雨",
            "source_type": "chapter",
            "source_chapter_id": chapter_id,
            "quote_anchor": long_anchor,
            "confidence": 0.87,
        },
    )

    documents = await build_story_memory_documents(session, project_id)
    text = _documents(documents, "world_fact")[0].text

    assert "来源=章节" in text
    assert "置信度=0.87" in text
    assert long_anchor not in text
    anchor_line = next(line for line in text.splitlines() if line.startswith("溯源："))
    assert len(anchor_line) <= MAX_ANCHOR_CHARS + 40
    assert fact["id"] not in text


# ============================================
# 来源令牌指纹：精确失效，且不读正文
# ============================================


@pytest.mark.asyncio
async def test_source_tokens_track_confirmation_and_content_changes(
    client: AsyncClient, session: AsyncSession
) -> None:
    project_id = await _create_project(client)
    baseline = await _fingerprint(session, project_id)

    candidate = await _create(
        client, project_id, "world-facts", {"statement": "候选断言"}
    )
    assert await _fingerprint(session, project_id) == baseline
    assert story_document_id("world_fact", candidate["id"]) not in await _tokens(
        session, project_id
    )

    # 编辑未确认的候选记录不改变令牌集合：不会造成无意义的重建。
    candidate = await _patch(
        client, project_id, "world-facts", candidate["id"], {"statement": "候选断言 v2"}
    )
    assert await _fingerprint(session, project_id) == baseline

    # 确认后进入令牌集合。
    await _confirm(client, project_id, "world-facts", candidate)
    confirmed_fingerprint = await _fingerprint(session, project_id)
    assert confirmed_fingerprint != baseline
    assert story_document_id("world_fact", candidate["id"]) in await _tokens(
        session, project_id
    )

    # 正文改动推进 updated_at，令牌随之变化。
    await _patch(
        client, project_id, "world-facts", candidate["id"], {"statement": "候选断言 v3"}
    )
    edited_fingerprint = await _fingerprint(session, project_id)
    assert edited_fingerprint not in {baseline, confirmed_fingerprint}

    # 删除已确认记录后令牌消失，指纹再次变化。
    response = await client.delete(
        f"{BASE.format(project_id=project_id)}/world-facts/{candidate['id']}"
    )
    assert response.status_code == 204
    assert await _fingerprint(session, project_id) == baseline


@pytest.mark.asyncio
async def test_index_freshness_detects_narrative_changes_without_reading_bodies(
    client: AsyncClient, session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """新鲜度判定必须只看便宜的来源令牌：全程不得触发文档重建（读正文）。"""
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)
    fact = await _create_confirmed(
        client, project_id, "world-facts", {"statement": "北城常年阴雨"}
    )
    await _certify_index(session, project_id)

    async def _forbidden(*args, **kwargs):  # pragma: no cover - 断言用
        raise AssertionError("新鲜度判定不得重建文档 / 读取正文")

    monkeypatch.setattr(
        "app.retrieval.story_memory.build_story_memory_documents", _forbidden
    )
    assert await story_memory_index_is_fresh(session, project_id=project_id) is True

    # 新增并确认一条信念后索引立即失效。
    await _create_confirmed(
        client,
        project_id,
        "character-beliefs",
        {"character_id": character_id, "proposition": "新的信念"},
    )
    assert await story_memory_index_is_fresh(session, project_id=project_id) is False

    # 重新认证后，删除源行同样必须让索引失效。
    await _certify_index(session, project_id)
    assert await story_memory_index_is_fresh(session, project_id=project_id) is True
    response = await client.delete(
        f"{BASE.format(project_id=project_id)}/world-facts/{fact['id']}"
    )
    assert response.status_code == 204
    assert await story_memory_index_is_fresh(session, project_id=project_id) is False


@pytest.mark.asyncio
async def test_source_tokens_cover_exactly_the_indexed_documents(
    client: AsyncClient, session: AsyncSession
) -> None:
    """令牌集合必须与文档集合一一对应。

    这是「指纹」与「索引内容」之间唯一的防漂移保险：可用性判定一旦在两条路径
    上分叉，就会出现「指纹说最新、索引里却不是同一批文档」的静默错误。
    """
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id, "林洛")
    chapter_id = await _create_chapter(client, project_id)

    world_info = (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()
    visible_entry = (
        await client.post(
            f"/api/v1/world-info/{world_info['id']}/entries",
            json={"name": "北城", "content": "北方主城。"},
        )
    ).json()
    hidden_entry = (
        await client.post(
            f"/api/v1/world-info/{world_info['id']}/entries",
            json={"name": "隐藏设定", "content": "只有作者知道。"},
        )
    ).json()
    await client.put(
        f"/api/v1/world-info-entries/{hidden_entry['id']}/meta", json={"ai_visible": False}
    )
    await client.post(
        f"/api/v1/projects/{project_id}/outlines",
        json={"level": "book", "title": "主线", "content": "三幕结构。"},
    )
    visible_note = await note_repo.create(
        session,
        Note(project_id=project_id, title="设定笔记", content="记忆可被编辑。"),
    )
    await note_repo.create(
        session,
        Note(
            project_id=project_id,
            title="私密笔记",
            content="不应进入索引。",
            is_hidden=True,
        ),
    )
    await _create_confirmed(
        client, project_id, "world-facts", {"statement": "北城常年阴雨"}
    )
    await _create(client, project_id, "world-facts", {"statement": "候选断言"})
    await _create_confirmed(
        client,
        project_id,
        "character-beliefs",
        {"character_id": character_id, "proposition": "北城的雨是诅咒"},
    )
    await _create_confirmed(
        client, project_id, "plotlines", {"title": "失踪的兄长"}
    )
    await _create_confirmed(
        client, project_id, "scene-plans", {"chapter_id": chapter_id, "goal": "发现线索"}
    )
    await session.flush()

    documents = await build_story_memory_documents(session, project_id)
    tokens = await _tokens(session, project_id)

    assert set(tokens) == {doc.document_id for doc in documents}
    # 隐私边界：隐藏的笔记与对 AI 隐藏的世界设定，两条路径都不得包含。
    assert story_document_id("note", visible_note.id) in tokens
    assert not any(
        key.startswith("note:") and key != story_document_id("note", visible_note.id)
        for key in tokens
    )
    assert story_document_id("world_entry", visible_entry["id"]) in tokens
    assert story_document_id("world_entry", hidden_entry["id"]) not in tokens
    # 只确认了一条世界事实：候选断言不得进入令牌集合。
    assert len([key for key in tokens if key.startswith("world_fact:")]) == 1


@pytest.mark.asyncio
async def test_narrative_edit_marks_stale_without_enqueueing_rebuild(
    client: AsyncClient, session: AsyncSession
) -> None:
    """叙事状态改动只让索引失效，绝不隐式触发全量重建。"""
    project_id = await _create_project(client)
    fact = await _create_confirmed(
        client, project_id, "world-facts", {"statement": "北城常年阴雨"}
    )
    await _certify_index(session, project_id)
    status = await compute_story_memory_status(session, project_id=project_id)
    assert status.index_status == "ready"

    await _patch(
        client, project_id, "world-facts", fact["id"], {"statement": "北城秋冬多雨"}
    )

    status = await compute_story_memory_status(session, project_id=project_id)
    assert status.index_status == "stale"

    active_jobs = await background_service.list_jobs(
        session,
        subject_type="project",
        subject_id=project_id,
        job_type=JOB_TYPE_STORY_MEMORY_REBUILD,
        statuses={JOB_STATUS_PENDING, JOB_STATUS_RUNNING},
        limit=10,
        offset=0,
    )
    assert active_jobs == []


# ============================================
# 项目删除：叙事向量文档一并清理
# ============================================


@pytest.mark.asyncio
async def test_project_cleanup_includes_narrative_documents(
    client: AsyncClient, session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    character_id = await _create_character(client, project_id)
    chapter_id = await _create_chapter(client, project_id)
    fact = await _create_confirmed(
        client, project_id, "world-facts", {"statement": "北城常年阴雨"}
    )
    belief = await _create_confirmed(
        client,
        project_id,
        "character-beliefs",
        {"character_id": character_id, "proposition": "北城的雨是诅咒"},
    )
    plotline = await _create_confirmed(client, project_id, "plotlines", {"title": "失踪的兄长"})
    plan = await _create_confirmed(
        client, project_id, "scene-plans", {"chapter_id": chapter_id, "goal": "发现线索"}
    )
    session.add(
        RetrievalIndex(
            index_key=story_memory_index_key(project_id),
            table_name=f"story_memory_{project_id}",
            status="ready",
            embedding_model_ref_id=MODEL_REF_ID,
            embedding_model_id_snapshot="embed-1",
            embedding_dimensions_snapshot=3,
        )
    )
    await session.flush()

    calls: list[tuple[str, list[str]]] = []

    class _Recorder:
        async def delete_documents(self, session_, index_key, document_ids):
            _ = session_
            calls.append((index_key, list(document_ids)))

    monkeypatch.setattr(
        "app.retrieval.story_memory.OpenFicRetrievalService", lambda: _Recorder()
    )

    await delete_project_story_memory_documents(session, project_id=project_id)

    assert len(calls) == 1
    index_key, document_ids = calls[0]
    assert index_key == story_memory_index_key(project_id)
    assert set(document_ids) >= {
        story_document_id("world_fact", fact["id"]),
        story_document_id("character_belief", belief["id"]),
        story_document_id("open_plotline", plotline["id"]),
        story_document_id("scene_state", plan["id"]),
    }
