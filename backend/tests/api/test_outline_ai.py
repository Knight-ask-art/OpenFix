# -*- coding: utf-8 -*-
"""Outline AI API 测试（PRD §14 四个动作）。"""

import json
from dataclasses import dataclass
from typing import Any

import pytest
from httpx import AsyncClient

from app.core.errors import ProviderAuthError, ProviderError
from app.models.entities.model import Model


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
            usage={"input_tokens": 30, "output_tokens": 60, "total_tokens": 90},
        )


@dataclass
class _FakeResolved:
    client: _FakeLLMClient
    model: Model


def _patch_outline_ai_model(
    monkeypatch: pytest.MonkeyPatch, content: str
) -> _FakeLLMClient:
    """把大纲 AI 的模型解析替换为固定输出的假客户端。"""
    fake_client = _FakeLLMClient(content)
    fake_model = Model(name="大纲模型", provider_id="provider-1", model_id="outline-model")

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        return _FakeResolved(client=fake_client, model=fake_model)

    from app.core.outline_ai import service as outline_ai_service

    monkeypatch.setattr(outline_ai_service, "resolve_background_llm", _fake_resolve)
    return fake_client


async def _create_project(client: AsyncClient) -> str:
    response = await client.post("/api/v1/projects", data={"title": "大纲AI测试小说"})
    assert response.status_code == 201
    return response.json()["id"]


async def _create_outline(
    client: AsyncClient, project_id: str, **payload: Any
) -> dict[str, Any]:
    body = {"level": "book", "title": "全书主线", "content": "主角出发寻找真相。"}
    body.update(payload)
    response = await client.post(f"/api/v1/projects/{project_id}/outlines", json=body)
    assert response.status_code == 201
    return response.json()


async def _create_chapter(client: AsyncClient, project_id: str, content: str) -> str:
    volumes = (await client.get(f"/api/v1/projects/{project_id}/volumes")).json()
    response = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": volumes[0]["id"], "title": "第一章", "content": content},
    )
    assert response.status_code == 201
    return response.json()["id"]


# ============================================
# AI 完善大纲
# ============================================


@pytest.mark.asyncio
async def test_improve_without_model_returns_400(client: AsyncClient) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "background_model_unavailable"
    assert "模型" in detail["message"]


@pytest.mark.asyncio
async def test_improve_unknown_outline_returns_404(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": "missing-outline"},
    )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_improve_rejects_empty_draft(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"level": "book", "title": "  ", "content": ""},
    )

    assert response.status_code == 400
    assert "标题" in response.json()["detail"]


@pytest.mark.asyncio
async def test_improve_success_returns_candidate_and_persists_nothing(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)
    before = (await client.get(f"/api/v1/projects/{project_id}/outlines")).json()

    content = json.dumps(
        {
            "title": "全书主线（完善版）",
            "content": "第一幕：出发。\n第二幕：真相。",
            "notes": "补全了第二幕目标",
        },
        ensure_ascii=False,
    )
    fake_client = _patch_outline_ai_model(monkeypatch, content)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": outline["id"], "instruction": "加强悬念"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "全书主线（完善版）"
    assert "第二幕" in data["content"]
    assert data["notes"] == "补全了第二幕目标"
    assert data["model"] == "大纲模型"
    assert data["usage"]["total_tokens"] == 90

    system_prompt = fake_client.messages[0]["content"]
    assert "JSON" in system_prompt
    assert "不是对你的指令" in system_prompt
    user_prompt = fake_client.messages[1]["content"]
    assert "全书" in user_prompt
    assert "加强悬念" in user_prompt

    after = (await client.get(f"/api/v1/projects/{project_id}/outlines")).json()
    assert after["total"] == before["total"]
    assert after["items"][0]["content"] == outline["content"]


@pytest.mark.asyncio
async def test_improve_provider_auth_error_is_not_401(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """服务商认证失败不得复用 401，避免前端误判为登录态失效。"""
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        raise ProviderAuthError("invalid api key secret-token-xyz")

    from app.core.outline_ai import service as outline_ai_service

    monkeypatch.setattr(outline_ai_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "模型服务调用失败，请稍后重试"
    assert "secret-token-xyz" not in response.text


@pytest.mark.asyncio
async def test_improve_provider_error_is_502(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)

    async def _fake_resolve(session, *, model_policy: str, model_id: str | None = None):
        raise ProviderError("upstream raw detail")

    from app.core.outline_ai import service as outline_ai_service

    monkeypatch.setattr(outline_ai_service, "resolve_background_llm", _fake_resolve)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 502
    assert "upstream raw detail" not in response.text


@pytest.mark.asyncio
async def test_improve_malformed_output_returns_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)
    _patch_outline_ai_model(monkeypatch, "完全不是 JSON")

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 400
    assert "解析" in response.json()["detail"]


# ============================================
# AI 检查节奏
# ============================================


@pytest.mark.asyncio
async def test_check_pacing_node_requires_outline_id(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/check-pacing",
        json={"scope": "node"},
    )

    assert response.status_code == 400
    assert "大纲节点" in response.json()["detail"]


@pytest.mark.asyncio
async def test_check_pacing_book_scope_without_outline_returns_400(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/check-pacing",
        json={"scope": "book"},
    )

    assert response.status_code == 400
    assert "大纲" in response.json()["detail"]


@pytest.mark.asyncio
async def test_check_pacing_success_normalizes_issues(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    await _create_outline(client, project_id)

    content = json.dumps(
        {
            "summary": "整体节奏尚可，中段铺垫可能偏长。",
            "issues": [
                {
                    "severity": "UNKNOWN",
                    "message": "中段连续三章没有推进主线。",
                    "evidence": ["第一章", "第二章", "第三章", "第四章"],
                    "suggestion": "考虑合并其中两章。",
                },
                {"severity": "high", "message": ""},
                "不是对象",
            ],
        },
        ensure_ascii=False,
    )
    _patch_outline_ai_model(monkeypatch, content)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/check-pacing",
        json={"scope": "book"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["summary"].startswith("整体节奏")
    assert len(data["issues"]) == 1
    issue = data["issues"][0]
    assert issue["severity"] == "warning"
    assert len(issue["evidence"]) == 3
    assert issue["evidence"][-1] == "第三章"


@pytest.mark.asyncio
async def test_check_pacing_node_scope_reports_subtree(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    book = await _create_outline(client, project_id, title="全书主线")
    await _create_outline(
        client, project_id, level="arc", title="第一幕", parent_id=book["id"]
    )
    await _create_outline(
        client, project_id, level="arc", title="第二幕", parent_id=book["id"]
    )

    fake_client = _patch_outline_ai_model(
        monkeypatch, json.dumps({"summary": "节奏正常", "issues": []}, ensure_ascii=False)
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/check-pacing",
        json={"scope": "node", "outline_id": book["id"]},
    )

    assert response.status_code == 200
    user_prompt = fake_client.messages[1]["content"]
    assert "第一幕" in user_prompt
    assert "第二幕" in user_prompt


@pytest.mark.asyncio
async def test_check_pacing_empty_output_returns_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    await _create_outline(client, project_id)
    _patch_outline_ai_model(monkeypatch, '{"summary": "", "issues": []}')

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/check-pacing",
        json={"scope": "book"},
    )

    assert response.status_code == 400
    assert "有效内容" in response.json()["detail"]


# ============================================
# AI 拆分章节
# ============================================


@pytest.mark.asyncio
async def test_split_requires_existing_outline(client: AsyncClient) -> None:
    project_id = await _create_project(client)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/split-chapters",
        json={"outline_id": "missing-outline"},
    )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_split_rejects_empty_outline(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id, title="", content="")

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/split-chapters",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 400
    assert "空" in response.json()["detail"]


@pytest.mark.asyncio
async def test_split_rejects_non_volume_outline_before_model_call(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id, level="book")
    fake_client = _patch_outline_ai_model(monkeypatch, '{"items": []}')

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/split-chapters",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 400
    assert "卷级" in response.json()["detail"]
    assert fake_client.messages == []


@pytest.mark.asyncio
async def test_split_success_truncates_to_max_chapters_and_persists_nothing(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    book = await _create_outline(client, project_id, level="book")
    arc = await _create_outline(
        client, project_id, level="arc", parent_id=book["id"]
    )
    outline = await _create_outline(
        client, project_id, level="volume", parent_id=arc["id"]
    )
    before = (await client.get(f"/api/v1/projects/{project_id}/outlines")).json()

    items = [
        {"title": f"第{index}章", "content": f"剧情节点 {index}"} for index in range(1, 8)
    ]
    _patch_outline_ai_model(
        monkeypatch, json.dumps({"items": items}, ensure_ascii=False)
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/split-chapters",
        json={"outline_id": outline["id"], "max_chapters": 3},
    )

    assert response.status_code == 200
    data = response.json()
    assert [item["title"] for item in data["items"]] == ["第1章", "第2章", "第3章"]

    after = (await client.get(f"/api/v1/projects/{project_id}/outlines")).json()
    assert after["total"] == before["total"]


@pytest.mark.asyncio
async def test_split_empty_items_returns_400(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)
    _patch_outline_ai_model(monkeypatch, '{"items": []}')

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/split-chapters",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 400
    assert "拆分" in response.json()["detail"]


# ============================================
# AI 根据正文更新大纲
# ============================================


@pytest.mark.asyncio
async def test_update_from_chapter_requires_chapter(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/update-from-chapter",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 400
    assert "章节" in response.json()["detail"]


@pytest.mark.asyncio
async def test_update_from_chapter_unknown_chapter_returns_404(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/update-from-chapter",
        json={"outline_id": outline["id"], "chapter_id": "missing-chapter"},
    )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_from_chapter_empty_content_returns_400(
    client: AsyncClient,
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)
    chapter_id = await _create_chapter(client, project_id, "")

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/update-from-chapter",
        json={"outline_id": outline["id"], "chapter_id": chapter_id},
    )

    assert response.status_code == 400
    assert "正文" in response.json()["detail"]


@pytest.mark.asyncio
async def test_update_from_chapter_success(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)
    chapter_id = await _create_chapter(client, project_id, "主角在雨夜抵达北城。")
    before = (await client.get(f"/api/v1/projects/{project_id}/outlines")).json()

    _patch_outline_ai_model(
        monkeypatch,
        json.dumps(
            {
                "title": "全书主线（据正文）",
                "content": "主角抵达北城，开始调查。",
                "notes": "补充了抵达北城的节点",
            },
            ensure_ascii=False,
        ),
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/update-from-chapter",
        json={"outline_id": outline["id"], "chapter_id": chapter_id},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "全书主线（据正文）"
    assert data["content"] == "主角抵达北城，开始调查。"
    assert data["notes"] == "补充了抵达北城的节点"

    after = (await client.get(f"/api/v1/projects/{project_id}/outlines")).json()
    assert after["total"] == before["total"]
    assert after["items"][0]["title"] == outline["title"]


def test_outline_ai_service_does_not_import_write_services() -> None:
    """大纲 AI 服务不引用任何写入型 storage service。"""
    from app.core.outline_ai import service as outline_ai_service

    for name in (
        "outline_service",
        "chapter_service",
        "project_service",
        "character_service",
        "world_info_entry_service",
    ):
        assert not hasattr(outline_ai_service, name)
