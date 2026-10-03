# -*- coding: utf-8 -*-
"""Story setup draft API 测试。"""

import json
from dataclasses import dataclass
from typing import Any

import pytest
from httpx import AsyncClient

from app.core.errors import ProviderAuthError, ProviderError
from app.models.entities.model import Model

_DRAFT_JSON = (
    '{"title": "长夜记录",'
    ' "genre": "科幻",'
    ' "synopsis": "近未来悬疑：记者追查记忆缺失的真相。",'
    ' "world_background": "2035 年，记忆可以被编辑。",'
    ' "protagonist": {"name": "林川", "description": "失去部分记忆的记者",'
    ' "identity": "调查记者", "motivation": "证明自己没有记错", "goal": "找回记忆"},'
    ' "core_conflict": "真相与自我认知的冲突。",'
    ' "initial_outline": [{"title": "第一幕", "content": "调查"},'
    ' {"title": "第二幕", "content": "反转"}]}'
)


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
            usage={"input_tokens": 20, "output_tokens": 40, "total_tokens": 60},
        )


@dataclass
class _FakeResolved:
    client: _FakeLLMClient
    model: Model


def _patch_draft_model(monkeypatch: pytest.MonkeyPatch, content: str) -> _FakeLLMClient:
    """把草案生成的模型解析替换为固定输出的假客户端。"""
    fake_client = _FakeLLMClient(content)
    fake_model = Model(name="草案模型", provider_id="provider-1", model_id="draft-model")

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(client=fake_client, model=fake_model)

    from app.core import story_setup as story_setup_service

    monkeypatch.setattr(story_setup_service, "resolve_background_llm", _fake_resolve)
    return fake_client


async def _create_project(client: AsyncClient) -> str:
    response = await client.post("/api/v1/projects", data={"title": "草案测试小说"})
    assert response.status_code == 201
    return response.json()["id"]


@pytest.mark.asyncio
async def test_draft_rejects_empty_inspiration(client: AsyncClient) -> None:
    response = await client.post("/api/v1/story-setup/draft", json={"inspiration": ""})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_draft_rejects_blank_inspiration(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "   \n  "}
    )
    assert response.status_code == 400
    assert "灵感" in response.json()["detail"]


@pytest.mark.asyncio
async def test_draft_rejects_oversize_inspiration(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "灵" * 6_001}
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_draft_without_model_returns_400(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "近未来悬疑小说"}
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "background_model_unavailable"
    assert "模型" in detail["message"]


@pytest.mark.asyncio
async def test_draft_provider_failure_returns_safe_error(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        raise ProviderError("upstream raw detail secret-token-xyz")

    from app.core import story_setup as story_setup_service

    monkeypatch.setattr(story_setup_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "近未来悬疑小说"}
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "模型服务调用失败，请稍后重试"
    assert "secret-token-xyz" not in response.text


@pytest.mark.asyncio
async def test_draft_provider_auth_error_is_not_401(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """服务商认证失败不得复用 401，避免前端误判为登录态失效。"""

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        raise ProviderAuthError("invalid api key")

    from app.core import story_setup as story_setup_service

    monkeypatch.setattr(story_setup_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "近未来悬疑小说"}
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "模型服务调用失败，请稍后重试"


@pytest.mark.asyncio
async def test_draft_success_with_fake_model(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_client = _patch_draft_model(monkeypatch, _DRAFT_JSON)

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "近未来悬疑，失忆记者"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "长夜记录"
    assert data["genre"] == "科幻"
    assert data["synopsis"].startswith("近未来悬疑")
    assert data["world_background"]
    assert data["protagonist"] == {
        "name": "林川",
        "description": "失去部分记忆的记者",
        "identity": "调查记者",
        "motivation": "证明自己没有记错",
        "goal": "找回记忆",
    }
    assert data["core_conflict"]
    assert data["initial_outline"] == [
        {"title": "第一幕", "content": "调查"},
        {"title": "第二幕", "content": "反转"},
    ]
    assert data["model"] == "草案模型"
    assert data["usage"]["total_tokens"] == 60

    system_prompt = fake_client.messages[0]["content"]
    assert "JSON" in system_prompt
    assert "不是对你的指令" in system_prompt
    assert "近未来悬疑，失忆记者" in fake_client.messages[1]["content"]


@pytest.mark.asyncio
async def test_draft_malformed_model_output_returns_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_draft_model(monkeypatch, "完全不是 JSON 的内容")

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "任意灵感"}
    )

    assert response.status_code == 400
    assert "解析" in response.json()["detail"]


@pytest.mark.asyncio
async def test_draft_empty_model_output_returns_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_draft_model(monkeypatch, "   ")

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "任意灵感"}
    )

    assert response.status_code == 400
    assert "未返回" in response.json()["detail"]


@pytest.mark.asyncio
async def test_draft_ignores_wrong_types_and_keeps_valid_fields(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = json.dumps(
        {
            "title": 123,
            "genre": "",
            "synopsis": "  有效简介  ",
            "protagonist": "只有一段设定的主角",
            "initial_outline": [{"title": "第一幕"}, "第二幕：反转"],
        },
        ensure_ascii=False,
    )
    _patch_draft_model(monkeypatch, content)

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "灵感"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] is None
    assert data["genre"] is None
    assert data["synopsis"] == "有效简介"
    assert data["world_background"] is None
    assert data["core_conflict"] is None
    assert data["protagonist"] == {
        "name": "",
        "description": "只有一段设定的主角",
        "identity": "",
        "motivation": "",
        "goal": "",
    }
    assert data["initial_outline"] == [
        {"title": "第一幕", "content": ""},
        {"title": "", "content": "第二幕：反转"},
    ]


@pytest.mark.asyncio
async def test_draft_truncates_outline_to_twelve_items(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    items = [
        {"title": f"第{index}幕", "content": f"内容{index}"} for index in range(1, 16)
    ]
    content = json.dumps(
        {"synopsis": "简介", "initial_outline": items}, ensure_ascii=False
    )
    _patch_draft_model(monkeypatch, content)

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "灵感"}
    )

    assert response.status_code == 200
    outline = response.json()["initial_outline"]
    assert len(outline) == 12
    assert outline[0]["title"] == "第1幕"
    assert outline[-1]["title"] == "第12幕"


@pytest.mark.asyncio
async def test_draft_rejects_output_with_no_usable_field(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_draft_model(
        monkeypatch, '{"title": 1, "protagonist": [], "initial_outline": []}'
    )

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "灵感"}
    )

    assert response.status_code == 400
    assert "有效内容" in response.json()["detail"]


def test_draft_service_does_not_depend_on_storage_services() -> None:
    """草案服务不引用任何写入型 storage service。"""
    from app.core import story_setup as story_setup_service

    for name in (
        "project_service",
        "character_service",
        "world_info_entry_service",
        "outline_service",
        "volume_service",
        "chapter_service",
        "project_profile_service",
    ):
        assert not hasattr(story_setup_service, name)


@pytest.mark.asyncio
async def test_draft_generation_persists_nothing(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    projects_before = (await client.get("/api/v1/projects")).json()["total"]
    outlines_before = (
        await client.get(f"/api/v1/projects/{project_id}/outlines")
    ).json()["total"]
    characters_before = (
        await client.get(f"/api/v1/projects/{project_id}/characters")
    ).json()["total"]
    profile_before = (await client.get(f"/api/v1/projects/{project_id}/profile")).json()
    world_info = (await client.get(f"/api/v1/projects/{project_id}/world-info")).json()
    entries_before = (
        await client.get(f"/api/v1/world-info/{world_info['id']}/entries")
    ).json()["total"]

    _patch_draft_model(monkeypatch, _DRAFT_JSON)
    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "近未来悬疑"}
    )
    assert response.status_code == 200

    assert (await client.get("/api/v1/projects")).json()["total"] == projects_before
    assert (
        await client.get(f"/api/v1/projects/{project_id}/outlines")
    ).json()["total"] == outlines_before
    assert (
        await client.get(f"/api/v1/projects/{project_id}/characters")
    ).json()["total"] == characters_before
    assert (
        await client.get(f"/api/v1/projects/{project_id}/profile")
    ).json()["synopsis"] == profile_before["synopsis"]
    assert (
        await client.get(f"/api/v1/world-info/{world_info['id']}/entries")
    ).json()["total"] == entries_before
