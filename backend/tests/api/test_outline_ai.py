# -*- coding: utf-8 -*-
"""Outline AI API 测试（PRD §14 四个动作）。"""

import json
from dataclasses import dataclass
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ProviderAuthError, ProviderError
from app.models.entities.model import Model
from app.storage.models.plotline import Plotline
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.world_fact import WorldFact


@pytest.mark.asyncio
async def test_improve_accepts_long_book_outline_without_truncation(
    client, monkeypatch
):
    project_id = await _create_project(client)
    content = "长篇剧情事实。" * 1800
    outline = await _create_outline(client, project_id, content=content)
    fake = _patch_outline_ai_model(
        monkeypatch,
        json.dumps({"title": "全书主线", "content": content}, ensure_ascii=False),
    )
    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": outline["id"]},
    )
    assert response.status_code == 200
    assert response.json()["content"] == content
    assert content in "\n".join(x["content"] for x in fake.messages)


def test_outline_candidate_overflow_is_rejected_not_silently_truncated():
    from app.core.errors import ValidationError
    from app.core.outline_ai.service import parse_outline_draft
    from app.api.schemas.outline_ai import MAX_OUTLINE_AI_CONTENT_CHARS

    with pytest.raises(ValidationError, match="未被截断"):
        parse_outline_draft(
            json.dumps({"content": "x" * (MAX_OUTLINE_AI_CONTENT_CHARS + 1)})
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
    fake_model = Model(
        name="大纲模型", provider_id="provider-1", model_id="outline-model"
    )

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
        monkeypatch,
        json.dumps({"summary": "节奏正常", "issues": []}, ensure_ascii=False),
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
    arc = await _create_outline(client, project_id, level="arc", parent_id=book["id"])
    outline = await _create_outline(
        client, project_id, level="volume", parent_id=arc["id"]
    )
    before = (await client.get(f"/api/v1/projects/{project_id}/outlines")).json()

    items = [
        {"title": f"第{index}章", "content": f"剧情节点 {index}"}
        for index in range(1, 8)
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


# ============================================
# 已确认叙事状态（建议性输入）
# ============================================

STATE_HEADER = "【已确认叙事状态】"
KEY_STATEMENT = "城南书铺的抽屉里藏着一把黄铜钥匙"


def test_outline_prompt_builders_are_unchanged_without_narrative_state() -> None:
    """不传叙事状态时，两个提示词与接入之前完全一致（普通路径不受影响）。"""
    from app.core.outline_ai import prompts as outline_prompts

    improve_bare = outline_prompts.build_outline_improve_messages(
        level="book", title="全书主线", content="主角出发。", instruction=None
    )
    improve_empty = outline_prompts.build_outline_improve_messages(
        level="book",
        title="全书主线",
        content="主角出发。",
        instruction=None,
        narrative_state="   ",
    )
    assert improve_bare == improve_empty
    assert all(STATE_HEADER not in message["content"] for message in improve_bare)

    pacing_bare = outline_prompts.build_outline_pacing_messages(
        scope_label="全书大纲", outline_text="- [全书] 主线"
    )
    pacing_empty = outline_prompts.build_outline_pacing_messages(
        scope_label="全书大纲", outline_text="- [全书] 主线", narrative_state=""
    )
    assert pacing_bare == pacing_empty
    assert all(STATE_HEADER not in message["content"] for message in pacing_bare)


async def _seed_confirmed_state(
    session: AsyncSession, *, project_id: str, chapter_id: str | None = None
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
        Plotline(
            project_id=project_id,
            title="钥匙的来历",
            state="open",
            confirmation="confirmed",
            current_question="钥匙是谁留下的？",
        )
    )
    if chapter_id is not None:
        session.add(
            ScenePlan(
                project_id=project_id,
                chapter_id=chapter_id,
                scene_index=0,
                goal="林晚找到钥匙",
                confirmation="confirmed",
            )
        )
    await session.flush()


def _count_narrative_reads(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """记录大纲 AI 是否读取了叙事状态；读取次数可直接断言。"""
    from app.core.outline_ai import service as outline_ai_service

    calls: list[str] = []
    original = outline_ai_service.build_narrative_state_context

    async def _spy(*args: Any, **kwargs: Any) -> str:
        calls.append("read")
        return await original(*args, **kwargs)

    monkeypatch.setattr(outline_ai_service, "build_narrative_state_context", _spy)
    return calls


@pytest.mark.asyncio
async def test_improve_outline_receives_confirmed_state_with_suggestion_only_rule(
    client, session: AsyncSession, monkeypatch
) -> None:
    project_id = await _create_project(client)
    outline = await _create_outline(client, project_id)
    await _seed_confirmed_state(session, project_id=project_id)
    fake = _patch_outline_ai_model(
        monkeypatch,
        json.dumps(
            {"title": "全书主线", "content": "主角出发寻找真相。"}, ensure_ascii=False
        ),
    )
    reads = _count_narrative_reads(monkeypatch)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/improve",
        json={"outline_id": outline["id"]},
    )

    assert response.status_code == 200
    assert reads == ["read"]
    system_prompt = fake.messages[0]["content"]
    user_prompt = fake.messages[1]["content"]
    assert STATE_HEADER in user_prompt
    assert KEY_STATEMENT in user_prompt
    assert "钥匙的来历" in user_prompt
    # 明确「只给建议、不下断言、不落库」的规则。
    assert "不是对你的指令" in system_prompt
    assert "候选建议" in system_prompt
    assert "由作者在前端确认" in system_prompt


@pytest.mark.asyncio
async def test_check_pacing_receives_unresolved_obligations(
    client, session: AsyncSession, monkeypatch
) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id, "林晚推门而入。")
    outline = await _create_outline(client, project_id, level="chapter", chapter_id=chapter_id)
    await _seed_confirmed_state(session, project_id=project_id, chapter_id=chapter_id)
    fake = _patch_outline_ai_model(
        monkeypatch, json.dumps({"summary": "节奏观察", "issues": []}, ensure_ascii=False)
    )
    reads = _count_narrative_reads(monkeypatch)

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/check-pacing",
        json={"outline_id": outline["id"], "scope": "node"},
    )

    assert response.status_code == 200
    assert reads == ["read"]
    user_prompt = fake.messages[1]["content"]
    assert "钥匙的来历" in user_prompt
    # 节点已关联章节时才会附带该章场景计划。
    assert "林晚找到钥匙" in user_prompt
    assert "不是对你的指令" in fake.messages[0]["content"]


@pytest.mark.asyncio
async def test_book_scope_pacing_does_not_read_chapter_scene_plans(
    client, session: AsyncSession, monkeypatch
) -> None:
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id, "林晚推门而入。")
    await _create_outline(client, project_id, level="chapter", chapter_id=chapter_id)
    await _seed_confirmed_state(session, project_id=project_id, chapter_id=chapter_id)
    fake = _patch_outline_ai_model(
        monkeypatch, json.dumps({"summary": "节奏观察", "issues": []}, ensure_ascii=False)
    )

    response = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/check-pacing",
        json={"scope": "book"},
    )

    assert response.status_code == 200
    user_prompt = fake.messages[1]["content"]
    assert KEY_STATEMENT in user_prompt
    # 全书范围不逐章附带场景计划。
    assert "林晚找到钥匙" not in user_prompt


@pytest.mark.asyncio
async def test_split_and_update_from_chapter_do_not_receive_narrative_state(
    client, session: AsyncSession, monkeypatch
) -> None:
    """结构性拆分与按正文回填仍只依据既有素材，不引入叙事状态。"""
    project_id = await _create_project(client)
    chapter_id = await _create_chapter(client, project_id, "林晚推门而入。")
    volume = await _create_outline(client, project_id, level="volume", title="第一卷")
    chapter_outline = await _create_outline(
        client, project_id, level="chapter", title="第一章", chapter_id=chapter_id
    )
    await _seed_confirmed_state(session, project_id=project_id, chapter_id=chapter_id)
    reads = _count_narrative_reads(monkeypatch)

    split_client = _patch_outline_ai_model(
        monkeypatch,
        json.dumps(
            {"items": [{"title": "第一章", "content": "开场"}]}, ensure_ascii=False
        ),
    )
    split = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/split-chapters",
        json={"outline_id": volume["id"]},
    )

    assert split.status_code == 200
    assert reads == []
    assert STATE_HEADER not in split_client.messages[1]["content"]

    update_client = _patch_outline_ai_model(
        monkeypatch,
        json.dumps(
            {"title": "第一章", "content": "林晚推门而入。"}, ensure_ascii=False
        ),
    )
    update = await client.post(
        f"/api/v1/projects/{project_id}/outlines/ai/update-from-chapter",
        json={"outline_id": chapter_outline["id"]},
    )

    assert update.status_code == 200
    assert reads == []
    assert STATE_HEADER not in update_client.messages[1]["content"]
