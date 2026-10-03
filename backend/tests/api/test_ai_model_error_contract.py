# -*- coding: utf-8 -*-
"""后台模型不可用错误契约测试。

验证 BackgroundModelUnavailableError 在 HTTP 边界统一映射为
400 + {"code": "background_model_unavailable", "message": ...}，
且其它 400 / 502 分支仍保持原有纯文本 detail。
"""

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import AsyncClient

from app.api.schemas.ai_errors import AiModelUnavailableDetail
from app.background.llm.resolver import BackgroundModelUnavailableError
from app.core import story_setup as story_setup_service
from app.core.consistency import service as consistency_service
from app.core.errors import ProviderError
from app.core.inline_ai import service as inline_ai_service
from app.core.outline_ai import service as outline_ai_service

_CODE = "background_model_unavailable"


# ============================================
# 测试夹具
# ============================================


async def _create_project(client: AsyncClient, title: str = "错误契约测试") -> str:
    response = await client.post("/api/v1/projects", data={"title": title})
    assert response.status_code == 201
    return response.json()["id"]


async def _create_chapter(
    client: AsyncClient, project_id: str, *, content: str = "夜色笼罩着小镇。"
) -> tuple[str, str]:
    volume_id = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()[0]["id"]
    response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": volume_id, "title": "第一章", "content": content},
    )
    assert response.status_code == 201
    return volume_id, response.json()["id"]


async def _create_outline(
    client: AsyncClient, project_id: str, **payload: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "level": "book",
        "title": "全书主线",
        "content": "主角出发寻找真相。",
    }
    body.update(payload)
    response = await client.post(f"/api/v1/projects/{project_id}/outlines", json=body)
    assert response.status_code == 201
    return response.json()


def _patch_unavailable(
    monkeypatch: pytest.MonkeyPatch, module: Any, message: str
) -> None:
    """让指定服务的模型解析抛出后台模型不可用错误。"""

    async def _fake_resolve(session, *, model_policy, model_id=None):
        raise BackgroundModelUnavailableError(message)

    monkeypatch.setattr(module, "resolve_background_llm", _fake_resolve)


def _assert_coded_400(response: Any, expected_message: str | None = None) -> None:
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert isinstance(detail, dict)
    assert set(detail) == {"code", "message"}
    assert detail["code"] == _CODE
    assert isinstance(detail["message"], str)
    if expected_message is not None:
        assert detail["message"] == expected_message


# ============================================
# schema 契约
# ============================================


def test_detail_schema_pins_code_and_message() -> None:
    assert AiModelUnavailableDetail(message="模型不存在: m1").model_dump() == {
        "code": _CODE,
        "message": "模型不存在: m1",
    }
    # code 有固定默认值，前端可稳定依赖
    assert AiModelUnavailableDetail(message="任意").model_dump()["code"] == _CODE


# ============================================
# 各端点：后台模型不可用 -> 编码 400
# ============================================


@pytest.mark.asyncio
async def test_story_setup_unavailable_returns_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    message = "后台任务模型未配置: light_model"
    _patch_unavailable(monkeypatch, story_setup_service, message)

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "近未来悬疑小说"}
    )

    _assert_coded_400(response, message)


@pytest.mark.asyncio
async def test_inline_ai_unavailable_returns_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    _, chapter_id = await _create_chapter(client, project_id)
    message = "模型不存在: deleted-inline-model"
    _patch_unavailable(monkeypatch, inline_ai_service, message)

    response = await client.post(
        "/api/v1/inline-ai/transform",
        json={
            "project_id": project_id,
            "chapter_id": chapter_id,
            "action": "polish",
            "selected_text": "夜色笼罩着小镇。",
        },
    )

    _assert_coded_400(response, message)


@pytest.mark.asyncio
async def test_outline_improve_unavailable_returns_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)
    message = "模型提供商不存在: deleted-provider"
    _patch_unavailable(monkeypatch, outline_ai_service, message)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": outline["id"]},
    )

    _assert_coded_400(response, message)


@pytest.mark.asyncio
async def test_outline_check_pacing_unavailable_returns_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    await _create_outline(client, project_id)
    message = "后台任务模型未配置: light_model"
    _patch_unavailable(monkeypatch, outline_ai_service, message)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/check-pacing",
        json={"scope": "book"},
    )

    _assert_coded_400(response, message)


@pytest.mark.asyncio
async def test_outline_split_chapters_unavailable_returns_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(
        client, project_id, level="volume", title="第一卷", content="剧情节点。"
    )
    message = "模型不存在: deleted-volume-model"
    _patch_unavailable(monkeypatch, outline_ai_service, message)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/split-chapters",
        json={"outline_id": outline["id"]},
    )

    _assert_coded_400(response, message)


@pytest.mark.asyncio
async def test_outline_update_from_chapter_unavailable_returns_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)
    _, chapter_id = await _create_chapter(client, project_id)
    message = "模型提供商不存在: deleted-provider"
    _patch_unavailable(monkeypatch, outline_ai_service, message)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/update-from-chapter",
        json={"outline_id": outline["id"], "chapter_id": chapter_id},
    )

    _assert_coded_400(response, message)


@pytest.mark.asyncio
async def test_consistency_check_unavailable_returns_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    _, chapter_id = await _create_chapter(client, project_id)
    message = "后台任务模型未配置: light_model"
    _patch_unavailable(monkeypatch, consistency_service, message)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/check",
        json={"chapter_id": chapter_id},
    )

    _assert_coded_400(response, message)


@pytest.mark.asyncio
async def test_consistency_analyze_unavailable_returns_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    _, chapter_id = await _create_chapter(client, project_id)
    message = "模型不存在: deleted-analyze-model"
    _patch_unavailable(monkeypatch, consistency_service, message)

    response = await client.post(
        f"/api/v1/projects/{project_id}/consistency/analyze",
        json={
            "scope": "chapter",
            "chapter_id": chapter_id,
            "issue": {
                "type": "character_age",
                "severity": "warning",
                "message": "人物年龄可能矛盾",
                "evidence": ["夜色笼罩着小镇。"],
                "suggestion": "核对年龄变化。",
            },
        },
    )

    _assert_coded_400(response, message)


# ============================================
# 三个不可用变体都保持编码 400
# ============================================


@pytest.mark.asyncio
async def test_all_unavailable_variants_keep_coded_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    _, chapter_id = await _create_chapter(client, project_id)
    payload = {
        "project_id": project_id,
        "chapter_id": chapter_id,
        "action": "polish",
        "selected_text": "夜色笼罩着小镇。",
    }

    for message in (
        "后台任务模型未配置: light_model",
        "模型不存在: deleted-model-id",
        "模型提供商不存在: deleted-provider-id",
    ):
        _patch_unavailable(monkeypatch, inline_ai_service, message)
        response = await client.post("/api/v1/inline-ai/transform", json=payload)
        _assert_coded_400(response, message)


# ============================================
# 其它错误分支语义不变
# ============================================


class _BlankLLMClient:
    async def generate(self, messages: list[dict[str, str]], timeout: int | None = None):
        return SimpleNamespace(content="   ")


@dataclass
class _FakeResolved:
    client: Any
    model: Any


@pytest.mark.asyncio
async def test_ordinary_validation_400_with_model_text_stays_plain_string(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """普通校验 400（message 含“模型”）仍是纯字符串，不带错误码。"""

    async def _fake_resolve(session, *, model_policy, model_id=None):
        return _FakeResolved(
            client=_BlankLLMClient(),
            model=SimpleNamespace(name="测试模型", model_id="test-model"),
        )

    monkeypatch.setattr(story_setup_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "任意灵感"}
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert isinstance(detail, str)
    assert "模型" in detail
    assert _CODE not in response.text


@pytest.mark.asyncio
async def test_provider_error_502_is_safe_and_uncoded(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake_resolve(session, *, model_policy, model_id=None):
        raise ProviderError("upstream raw detail secret-token-xyz")

    monkeypatch.setattr(story_setup_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        "/api/v1/story-setup/draft", json={"inspiration": "近未来悬疑小说"}
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "模型服务调用失败，请稍后重试"
    assert "secret-token-xyz" not in response.text
    assert _CODE not in response.text
