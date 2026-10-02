# -*- coding: utf-8 -*-
"""Consistency API 测试。"""

from dataclasses import dataclass
import json
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import AsyncClient

from app.core.consistency.service import parse_consistency_issues


def _issues_json() -> str:
    return (
        '[{"type": "character_age", "severity": "warning", "message": "年龄可能与设定不符",'
        ' "evidence": ["十六岁的少年", "设定：林晚二十七岁"], "suggestion": "请核对人物年龄"},'
        ' {"type": "timeline", "severity": "bogus", "message": "时间线可能跳跃", "evidence": "驼铃", "suggestion": ""}]'
    )


def test_parse_issues_valid_and_normalizes() -> None:
    issues = parse_consistency_issues(_issues_json())
    assert len(issues) == 2
    assert issues[0].type == "character_age"
    assert issues[0].severity == "warning"
    assert issues[0].evidence == ["十六岁的少年", "设定：林晚二十七岁"]
    # 非法 severity 归一化为 warning；字符串 evidence 转数组
    assert issues[1].severity == "warning"
    assert issues[1].evidence == ["驼铃"]


def test_parse_issues_strips_code_fence_and_object_wrapper() -> None:
    wrapped = "```json\n{\"issues\": [{\"type\": \"rule\", \"severity\": \"info\", \"message\": \"可能遗漏伏笔\"}]}\n```"
    issues = parse_consistency_issues(wrapped)
    assert len(issues) == 1
    assert issues[0].severity == "info"
    assert issues[0].evidence == []


def test_parse_issues_rejects_garbage() -> None:
    from app.core.errors import ValidationError

    with pytest.raises(ValidationError):
        parse_consistency_issues("完全不是 json 的内容")


def test_parse_issues_keeps_more_than_twenty_valid_results() -> None:
    payload = json.dumps(
        [
            {"type": "plot", "severity": "warning", "message": f"问题 {index}"}
            for index in range(25)
        ],
        ensure_ascii=False,
    )

    assert len(parse_consistency_issues(payload)) == 25


async def _create_project_with_chapter(client: AsyncClient) -> tuple[str, str, str]:
    project = (
        await client.post("/api/v1/projects", data={"title": "一致性小说"})
    ).json()
    project_id = project["id"]
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    volume_id = volumes[0]["id"]
    chapter = (
        await client.post(
            f"/api/v1/projects/{project_id}/chapters",
            json={
                "volume_id": volume_id,
                "title": "第一章",
                "content": "十六岁的少年推门而入。驼铃声在远处回响。",
                "word_count": 20,
            },
        )
    ).json()
    await client.post(
        f"/api/v1/projects/{project_id}/characters",
        data={"name": "林晚", "description": "二十七岁的剑客"},
    )
    return project_id, chapter["id"], volume_id


@pytest.mark.asyncio
async def test_story_memory_context_drops_results_when_index_goes_stale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """源数据在检索途中变化时，旧检索片段必须在交付前丢弃。

    第一次 freshness 检查允许查询；查询返回带敏感标记的旧片段后，
    第二次复查判定索引已 stale，此时必须返回 None 走清单回退，
    不能把本次旧文本交给模型。
    """
    leaked = "敏感标记：检索途中源数据已变化"
    fake_session: Any = None

    class _FakeBuilder:
        def hybrid(self) -> "_FakeBuilder":
            return self

        def vector_top_k(self, _top_k: int) -> "_FakeBuilder":
            return self

        def bm25_top_k(self, _top_k: int) -> "_FakeBuilder":
            return self

        def ef(self, _ef: int) -> "_FakeBuilder":
            return self

        def filter_eq(self, _field: str, _value: str) -> "_FakeBuilder":
            return self

        def limit(self, _limit: int) -> "_FakeBuilder":
            return self

        async def run(self) -> list[Any]:
            return [SimpleNamespace(text=leaked)]

    class _FakeRetrievalService:
        async def query(self, *_args: Any, **_kwargs: Any) -> "_FakeBuilder":
            return _FakeBuilder()

    import app.background.jobs.definitions.retrieval_chapter_index_batch as batch_module
    from app.core.consistency import service as consistency_service

    freshness_calls: list[Any] = []

    async def _fake_is_fresh(session, *, project_id, index_row=None, documents=None):
        freshness_calls.append(index_row)
        # 第一次允许检索；查询完成后复查时源数据已变化。
        return len(freshness_calls) == 1

    async def _fake_index_settings(_session):
        return SimpleNamespace()

    async def _fake_resolve_index_model(_session, _config):
        return SimpleNamespace(id="model-1")

    async def _fake_get_by_index_key(_session, _key):
        return SimpleNamespace(status="ready")

    async def _fake_build_embedding_client(_session, _model_id):
        return SimpleNamespace()

    monkeypatch.setattr(consistency_service, "get_index_settings", _fake_index_settings)
    monkeypatch.setattr(
        consistency_service, "resolve_index_embedding_model", _fake_resolve_index_model
    )
    monkeypatch.setattr(
        consistency_service.retrieval_index_repo,
        "get_by_index_key",
        _fake_get_by_index_key,
    )
    monkeypatch.setattr(
        consistency_service, "story_memory_index_is_fresh", _fake_is_fresh
    )
    monkeypatch.setattr(
        consistency_service, "OpenFicRetrievalService", _FakeRetrievalService
    )
    monkeypatch.setattr(
        batch_module, "_build_embedding_client", _fake_build_embedding_client
    )

    context = await consistency_service._story_memory_context(
        fake_session, "project-1", "查询"
    )

    assert context is None
    # 检索前后各检查一次 freshness，且两次都携带同一个 ready 索引行
    assert len(freshness_calls) == 2
    assert leaked not in (context or "")


@pytest.mark.asyncio
async def test_consistency_check_without_model_returns_400(client: AsyncClient) -> None:
    project_id, chapter_id, _ = await _create_project_with_chapter(client)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )
    assert response.status_code == 400
    assert "模型" in response.json()["detail"]


@pytest.mark.asyncio
async def test_consistency_check_unknown_chapter_returns_404(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, _, _ = await _create_project_with_chapter(client)

    @dataclass
    class _FakeResolved:
        client: Any
        model: Any
        provider: Any = None

    class _FakeLLM:
        async def generate(self, messages, timeout=None):
            class _Resp:
                content = "[]"

            return _Resp()

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(
            client=_FakeLLM(),
            model=type("M", (), {"name": "fake", "model_id": "fake"})(),
        )

    from app.core.consistency import service as consistency_service

    monkeypatch.setattr(consistency_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": "missing"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_consistency_check_success_with_fake_model(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, chapter_id, _ = await _create_project_with_chapter(client)

    @dataclass
    class _FakeResolved:
        client: Any
        model: Any
        provider: Any = None

    class _FakeLLM:
        def __init__(self) -> None:
            self.messages: list[dict[str, str]] = []

        async def generate(self, messages, timeout=None):
            self.messages = messages

            class _Resp:
                content = _issues_json()

            return _Resp()

    fake_llm = _FakeLLM()

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(
            client=fake_llm,
            model=type("M", (), {"name": "测试模型", "model_id": "fake"})(),
        )

    from app.core.consistency import service as consistency_service

    monkeypatch.setattr(consistency_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )
    assert response.status_code == 200
    data = response.json()
    # 未配置 embedding 模型时走人物清单回退
    assert data["context_source"] == "inventory"
    assert data["model"] == "测试模型"
    assert len(data["issues"]) == 2
    assert data["issues"][0]["severity"] == "warning"
    # 回退资料注入到 prompt 里，包含人物信息
    user_message = fake_llm.messages[1]["content"]
    assert "林晚" in user_message
    assert "二十七岁" in user_message


@pytest.mark.asyncio
async def test_consistency_check_rejects_empty_chapter(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = (
        await client.post("/api/v1/projects", data={"title": "空章节小说"})
    ).json()
    project_id = project["id"]
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    chapter = (
        await client.post(
            f"/api/v1/projects/{project_id}/chapters",
            json={"volume_id": volumes[0]["id"], "title": "空章", "content": ""},
        )
    ).json()

    @dataclass
    class _FakeResolved:
        client: Any
        model: Any
        provider: Any = None

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(
            client=type("C", (), {})(),
            model=type("M", (), {"name": "fake", "model_id": "fake"})(),
        )

    from app.core.consistency import service as consistency_service

    monkeypatch.setattr(consistency_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter["id"]},
    )
    assert response.status_code == 400
    assert "空" in response.json()["detail"]


async def _create_project_with_two_chapters(client: AsyncClient) -> tuple[str, str, str]:
    project = (await client.post("/api/v1/projects", data={"title": "分卷检查小说"})).json()
    project_id = project["id"]
    volume_id = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()[0]["id"]
    first = (
        await client.post(
            f"/api/v1/projects/{project_id}/chapters",
            json={
                "volume_id": volume_id,
                "title": "第一章",
                "content": "少年十六岁。",
                "word_count": 6,
            },
        )
    ).json()
    second = (
        await client.post(
            f"/api/v1/projects/{project_id}/chapters",
            json={
                "volume_id": volume_id,
                "title": "第二章",
                "content": "少年自称二十七岁。",
                "word_count": 8,
            },
        )
    ).json()
    return project_id, first["id"], second["id"]


def _patch_fake_model(monkeypatch: pytest.MonkeyPatch, content: str = "[]"):
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


@pytest.mark.asyncio
async def test_consistency_volume_scope_includes_all_chapters(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, first_id, _ = await _create_project_with_two_chapters(client)
    captured = _patch_fake_model(monkeypatch)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"scope": "volume", "chapter_id": first_id},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["scope"] == "volume"
    assert data["chapter_count"] == 2
    assert data["label"].startswith("卷：")
    user_message = captured[0][1]["content"]
    assert "第一章" in user_message
    assert "第二章" in user_message


@pytest.mark.asyncio
async def test_consistency_book_scope_covers_project(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, _, _ = await _create_project_with_two_chapters(client)
    captured = _patch_fake_model(monkeypatch)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"scope": "book"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["scope"] == "book"
    assert data["label"] == "全书"
    assert data["chapter_count"] == 2
    assert "待检查范围：全书" in captured[0][1]["content"]


@pytest.mark.asyncio
async def test_consistency_volume_scope_without_chapters_returns_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = (await client.post("/api/v1/projects", data={"title": "空项目"})).json()
    project_id = project["id"]
    volume_id = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()[0]["id"]
    _patch_fake_model(monkeypatch)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"scope": "volume", "volume_id": volume_id},
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_consistency_rejects_invalid_scope(client: AsyncClient) -> None:
    project = (await client.post("/api/v1/projects", data={"title": "非法范围"})).json()
    response = await client.post(
        f"/api/v1/projects/{project['id']}/consistency/check",
        json={"scope": "universe"},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_consistency_book_scope_chunks_large_content(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = (await client.post("/api/v1/projects", data={"title": "长篇分段检查"})).json()
    project_id = project["id"]
    volume_id = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()[0]["id"]

    chapter_count = 5
    filler_len = 12_000
    markers: list[tuple[str, str]] = []
    for index in range(1, chapter_count + 1):
        head_marker = f"CH{index}-HEAD-标记"
        tail_marker = f"CH{index}-TAIL-标记"
        content = f"{head_marker}{'中' * filler_len}{tail_marker}"
        await client.post(
            f"/api/v1/projects/{project_id}/chapters",
            json={
                "volume_id": volume_id,
                "title": f"第{index}章",
                "content": content,
                "word_count": len(content),
            },
        )
        markers.append((head_marker, tail_marker))

    captured = _patch_fake_model(monkeypatch)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"scope": "book"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["scope"] == "book"
    assert data["label"] == "全书"
    assert data["chapter_count"] == chapter_count

    # 选中正文远超 MAX_SCOPE_EXCERPT（48,000），必须拆分为多次请求
    assert len(captured) > 1
    user_messages = [item[1]["content"] for item in captured]
    joined = "\n".join(user_messages)
    # 每章开头与结尾的唯一标记都必须出现在某次请求里，证明末段未被截断
    for head_marker, tail_marker in markers:
        assert head_marker in joined
        assert tail_marker in joined
    # 每个请求都标明自己检查的是哪一段，最终响应 label 保持“全书”
    for position, message in enumerate(user_messages, start=1):
        assert f"全书（第 {position}/{len(captured)} 段）" in message


@pytest.mark.asyncio
async def test_consistency_book_scope_keeps_issues_from_all_segments(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, _, _ = await _create_project_with_two_chapters(client)
    captured: list[list[dict[str, str]]] = []

    @dataclass
    class _FakeResolved:
        client: Any
        model: Any
        provider: Any = None

    class _FakeLLM:
        async def generate(self, messages, timeout=None):
            captured.append(messages)
            segment = len(captured)
            content = json.dumps(
                [
                    {
                        "type": "plot",
                        "severity": "warning",
                        "message": f"第 {segment} 段问题 {index}",
                    }
                    for index in range(15)
                ],
                ensure_ascii=False,
            )
            return SimpleNamespace(content=content)

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(
            client=_FakeLLM(),
            model=type("M", (), {"name": "测试模型", "model_id": "fake"})(),
        )

    from app.core.consistency import service as consistency_service

    monkeypatch.setattr(consistency_service, "resolve_background_llm", _fake_resolve)
    monkeypatch.setattr(
        consistency_service,
        "_build_scope_chunks",
        lambda chapters, limit: ["第一段", "第二段"],
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"scope": "book"},
    )

    assert response.status_code == 200
    data = response.json()
    assert len(captured) == 2
    assert len(data["issues"]) == 30
    assert data["failed_segments"] == []


@pytest.mark.asyncio
async def test_consistency_book_scope_reports_unparseable_segments_as_partial(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, _, _ = await _create_project_with_two_chapters(client)

    @dataclass
    class _FakeResolved:
        client: Any
        model: Any
        provider: Any = None

    class _FakeLLM:
        async def generate(self, messages, timeout=None):
            if "第 1/2 段" in messages[1]["content"]:
                return SimpleNamespace(content=_issues_json())
            return SimpleNamespace(content="模型输出无法解析")

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(
            client=_FakeLLM(),
            model=type("M", (), {"name": "测试模型", "model_id": "fake"})(),
        )

    from app.core.consistency import service as consistency_service

    monkeypatch.setattr(consistency_service, "resolve_background_llm", _fake_resolve)
    monkeypatch.setattr(
        consistency_service,
        "_build_scope_chunks",
        lambda chapters, limit: ["第一段", "第二段"],
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"scope": "book"},
    )

    assert response.status_code == 200
    data = response.json()
    assert len(data["issues"]) == 2
    assert data["failed_segments"] == [2]


@pytest.mark.asyncio
async def test_consistency_check_maps_only_verbatim_manuscript_evidence(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, chapter_id, _ = await _create_project_with_chapter(client)
    _patch_fake_model(
        monkeypatch,
        '[{"type":"timeline","severity":"warning","message":"时间可能不一致",'
        '"evidence":["十六岁的少年","不存在于正文的引用"],"suggestion":"请核对"}]',
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"scope": "chapter", "chapter_id": chapter_id},
    )

    assert response.status_code == 200
    issue = response.json()["issues"][0]
    assert len(issue["sources"]) == 1
    assert issue["sources"][0]["chapter_id"] == chapter_id
    assert issue["sources"][0]["quote"] == "十六岁的少年"
    assert "十六岁的少年" in issue["sources"][0]["excerpt"]
    assert "不存在于正文的引用" not in issue["sources"][0]["excerpt"]


@pytest.mark.asyncio
async def test_consistency_issue_analysis_uses_scoped_manuscript_context(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, chapter_id, _ = await _create_project_with_chapter(client)
    captured = _patch_fake_model(monkeypatch, "依据尚不足，建议核实前后文。")

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/analyze",
        json={
            "scope": "chapter",
            "chapter_id": chapter_id,
            "issue": {
                "type": "character_age",
                "severity": "warning",
                "message": "人物年龄可能矛盾",
                "evidence": ["十六岁的少年"],
                "suggestion": "核对年龄变化。",
            },
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "model": "测试模型",
        "analysis": "依据尚不足，建议核实前后文。",
    }
    user_message = captured[0][1]["content"]
    assert "十六岁的少年" in user_message
    assert "服务端定位到的正文片段" in user_message
    assert "人物年龄可能矛盾" in user_message
