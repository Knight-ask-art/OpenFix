# -*- coding: utf-8 -*-
"""Inline AI API 测试。"""

from dataclasses import dataclass, field
from typing import Any

import pytest
from httpx import AsyncClient

from app.core.inline_ai.service import normalize_inline_ai_output
from app.models.entities.model import Model


async def _create_project_with_chapter(client: AsyncClient) -> tuple[str, str]:
    response = await client.post(
        "/api/v1/projects",
        data={"title": "内联AI测试小说"},
    )
    assert response.status_code == 201
    project_id = response.json()["id"]
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    assert len(volumes) == 1
    chapter_payload = {
        "volume_id": volumes[0]["id"],
        "title": "第一章",
        "content": "夜色笼罩着小镇。",
    }
    chapter_response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json=chapter_payload,
    )
    assert chapter_response.status_code == 201
    return project_id, chapter_response.json()["id"]


def _payload(project_id: str, chapter_id: str, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "project_id": project_id,
        "chapter_id": chapter_id,
        "action": "polish",
        "selected_text": "夜色笼罩着小镇。",
    }
    payload.update(overrides)
    return payload


@dataclass
class _FakeLLMResponse:
    content: str
    usage: dict[str, Any] | None = None


class _FakeLLMClient:
    def __init__(self, content: str) -> None:
        self._content = content
        self.messages: list[dict[str, str]] = []

    async def generate(
        self, messages: list[dict[str, str]], timeout: int | None = None
    ) -> _FakeLLMResponse:
        self.messages = messages
        return _FakeLLMResponse(
            content=self._content,
            usage={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        )


def test_normalize_strips_code_fence_and_quotes() -> None:
    assert normalize_inline_ai_output("```text\n改写后的文本\n```") == "改写后的文本"
    assert normalize_inline_ai_output("“改写后的文本”") == "改写后的文本"
    assert normalize_inline_ai_output('"改写后的文本"') == "改写后的文本"
    assert normalize_inline_ai_output("普通文本") == "普通文本"


@pytest.mark.asyncio
async def test_transform_rejects_invalid_action(client: AsyncClient) -> None:
    project_id, chapter_id = await _create_project_with_chapter(client)
    payload = _payload(project_id, chapter_id, action="unknown_action")
    response = await client.post("/api/v1/inline-ai/transform", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_transform_rejects_empty_selection(client: AsyncClient) -> None:
    project_id, chapter_id = await _create_project_with_chapter(client)
    payload = _payload(project_id, chapter_id, selected_text="")
    response = await client.post("/api/v1/inline-ai/transform", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_transform_custom_requires_instruction(client: AsyncClient) -> None:
    project_id, chapter_id = await _create_project_with_chapter(client)
    payload = _payload(project_id, chapter_id, action="custom")
    response = await client.post("/api/v1/inline-ai/transform", json=payload)
    assert response.status_code == 400
    assert "指令" in response.json()["detail"]


@pytest.mark.asyncio
async def test_transform_unknown_chapter_returns_404(client: AsyncClient) -> None:
    project_id, _ = await _create_project_with_chapter(client)
    payload = _payload(project_id, "missing-chapter")
    response = await client.post("/api/v1/inline-ai/transform", json=payload)
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_transform_without_model_returns_400(client: AsyncClient) -> None:
    project_id, chapter_id = await _create_project_with_chapter(client)
    payload = _payload(project_id, chapter_id)
    response = await client.post("/api/v1/inline-ai/transform", json=payload)
    assert response.status_code == 400
    assert "模型" in response.json()["detail"]


@pytest.mark.asyncio
async def test_transform_success_with_fake_model(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, chapter_id = await _create_project_with_chapter(client)

    fake_client = _FakeLLMClient("```text\n夜色轻柔地笼罩着小镇。\n```")
    fake_model = Model(name="测试模型", provider_id="provider-1", model_id="test-model")
    captured_audit_logs: list[Any] = []

    @dataclass
    class _FakeProvider:
        provider_type: str = "openai"

    @dataclass
    class _FakeResolved:
        client: _FakeLLMClient
        model: Model
        provider: _FakeProvider = field(default_factory=_FakeProvider)

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(client=fake_client, model=fake_model)

    async def _fake_enqueue(audit_log: Any) -> None:
        captured_audit_logs.append(audit_log)

    from app.core.inline_ai import service as inline_ai_service

    monkeypatch.setattr(inline_ai_service, "resolve_background_llm", _fake_resolve)
    monkeypatch.setattr("app.audit.context.enqueue_audit_log", _fake_enqueue)

    payload = _payload(project_id, chapter_id)
    response = await client.post("/api/v1/inline-ai/transform", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["original"] == "夜色笼罩着小镇。"
    assert data["result"] == "夜色轻柔地笼罩着小镇。"
    assert data["model"] == "测试模型"
    assert data["usage"]["total_tokens"] == 15
    assert fake_client.messages[0]["role"] == "system"
    assert "润色" in fake_client.messages[0]["content"]
    assert "夜色笼罩着小镇。" in fake_client.messages[1]["content"]

    assert len(captured_audit_logs) == 1
    audit_log = captured_audit_logs[0]
    assert audit_log.category == "editor"
    assert audit_log.operation == "inline_ai_polish"
    assert audit_log.project_id == project_id
    assert audit_log.chapter_id == chapter_id
    assert audit_log.model_name == "测试模型"
    assert audit_log.status == "success"
    assert audit_log.tokens_input == 10
    assert audit_log.tokens_output == 5
    assert audit_log.tokens_total == 15
    assert audit_log.latency_ms >= 0
    assert audit_log.extra_data is not None
    assert "inline_ai_action" in audit_log.extra_data
