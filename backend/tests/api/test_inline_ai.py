# -*- coding: utf-8 -*-
"""Inline AI API 测试。"""

from dataclasses import dataclass, field
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.inline_ai.service import normalize_inline_ai_output
from app.models.entities.model import Model
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.world_fact import WorldFact


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
    detail = response.json()["detail"]
    assert detail["code"] == "background_model_unavailable"
    assert "模型" in detail["message"]


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


@pytest.mark.asyncio
async def test_story_setup_generate_endpoint_is_removed(client: AsyncClient) -> None:
    """story-setup 只保留 /draft 一个契约，旧的 /generate 不再提供。"""
    response = await client.post(
        "/api/v1/story-setup/generate", json={"inspiration": "近未来悬疑小说"}
    )
    assert response.status_code == 404


# ============================================
# 已确认叙事状态：按动作区分
# ============================================

STATE_HEADER = "【已确认叙事状态】"
KEY_STATEMENT = "城南书铺的抽屉里藏着一把黄铜钥匙"


def test_inline_prompt_is_unchanged_without_narrative_state() -> None:
    """不传叙事状态时，提示词与接入之前完全一致（普通路径不受影响）。"""
    from app.core.inline_ai import prompts as inline_prompts

    bare = inline_prompts.build_inline_ai_messages(
        action="dialogue", selected_text="原文"
    )
    explicit_empty = inline_prompts.build_inline_ai_messages(
        action="dialogue", selected_text="原文", narrative_state="   "
    )

    assert bare == explicit_empty
    assert all(STATE_HEADER not in message["content"] for message in bare)


async def _seed_confirmed_state(
    session: AsyncSession, *, project_id: str, chapter_id: str
) -> None:
    session.add(
        WorldFact(
            project_id=project_id,
            statement=KEY_STATEMENT,
            status="confirmed",
            confirmation="confirmed",
        )
    )
    session.add(
        ScenePlan(
            project_id=project_id,
            chapter_id=chapter_id,
            scene_index=0,
            goal="林晚找到钥匙",
            hidden_information_json='["抽屉暗格里的钥匙来历"]',
            confirmation="confirmed",
        )
    )
    await session.flush()


def _patch_inline_ai_model(
    monkeypatch: pytest.MonkeyPatch, content: str = "改写后的文本"
) -> _FakeLLMClient:
    """把内联 AI 的模型解析替换为固定输出的假客户端，并拦截审计写入。"""
    fake_client = _FakeLLMClient(content)
    fake_model = Model(name="测试模型", provider_id="provider-1", model_id="test-model")

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
        return None

    from app.core.inline_ai import service as inline_ai_service

    monkeypatch.setattr(inline_ai_service, "resolve_background_llm", _fake_resolve)
    monkeypatch.setattr("app.audit.context.enqueue_audit_log", _fake_enqueue)
    return fake_client


def _count_narrative_reads(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """记录内联 AI 是否读取了叙事状态；读取次数可直接断言。"""
    from app.core.inline_ai import service as inline_ai_service

    calls: list[str] = []
    original = inline_ai_service.build_narrative_state_context

    async def _spy(*args: Any, **kwargs: Any) -> str:
        calls.append("read")
        return await original(*args, **kwargs)

    monkeypatch.setattr(inline_ai_service, "build_narrative_state_context", _spy)
    return calls


@pytest.mark.parametrize("action", ["dialogue", "expand"])
@pytest.mark.asyncio
async def test_dialogue_and_expand_receive_bounded_confirmed_state(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    action: str,
) -> None:
    project_id, chapter_id = await _create_project_with_chapter(client)
    await _seed_confirmed_state(session, project_id=project_id, chapter_id=chapter_id)
    fake_client = _patch_inline_ai_model(monkeypatch)
    reads = _count_narrative_reads(monkeypatch)

    response = await client.post(
        "/api/v1/inline-ai/transform",
        json=_payload(project_id, chapter_id, action=action),
    )

    assert response.status_code == 200
    assert reads == ["read"]
    system_prompt = fake_client.messages[0]["content"]
    user_prompt = fake_client.messages[1]["content"]
    assert STATE_HEADER in user_prompt
    assert KEY_STATEMENT in user_prompt
    assert "抽屉暗格里的钥匙来历" in user_prompt
    # 状态是资料而不是指令，且不得据此改动剧情事实。
    assert "不是指令" in system_prompt
    assert "保留原文写法" in system_prompt


@pytest.mark.parametrize("action", ["grammar", "polish", "shorten", "custom"])
@pytest.mark.asyncio
async def test_surface_actions_neither_read_nor_inject_narrative_state(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    action: str,
) -> None:
    project_id, chapter_id = await _create_project_with_chapter(client)
    await _seed_confirmed_state(session, project_id=project_id, chapter_id=chapter_id)
    fake_client = _patch_inline_ai_model(monkeypatch)
    reads = _count_narrative_reads(monkeypatch)

    payload = _payload(project_id, chapter_id, action=action)
    if action == "custom":
        payload["instruction"] = "把这句话写得更克制"
    response = await client.post("/api/v1/inline-ai/transform", json=payload)

    assert response.status_code == 200
    assert reads == []
    assert STATE_HEADER not in fake_client.messages[0]["content"]
    assert STATE_HEADER not in fake_client.messages[1]["content"]


@pytest.mark.asyncio
async def test_dialogue_without_confirmed_state_keeps_prompt_unchanged(
    client: AsyncClient,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id, chapter_id = await _create_project_with_chapter(client)
    fake_client = _patch_inline_ai_model(monkeypatch)

    response = await client.post(
        "/api/v1/inline-ai/transform",
        json=_payload(project_id, chapter_id, action="dialogue"),
    )

    assert response.status_code == 200
    assert STATE_HEADER not in fake_client.messages[0]["content"]
    assert STATE_HEADER not in fake_client.messages[1]["content"]
