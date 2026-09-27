# -*- coding: utf-8 -*-
"""Consistency API 测试。"""

from dataclasses import dataclass
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
