"""Compaction prefers the configured light model and has an active-model fallback."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import HumanMessage, SystemMessage

from app.agent_runtime.context.compaction import service
from app.background.llm.resolver import BackgroundModelUnavailableError


@pytest.mark.asyncio
async def test_compaction_uses_configured_light_model(monkeypatch) -> None:
    response = SimpleNamespace(content="summary", usage={"input_tokens": 20})
    client = SimpleNamespace(generate=AsyncMock(return_value=response))
    monkeypatch.setattr(
        service,
        "resolve_background_llm",
        AsyncMock(return_value=SimpleNamespace(client=client)),
    )
    messages = [
        SystemMessage(content="compress faithfully"),
        HumanMessage(content="story transcript"),
    ]

    actual = await service._invoke_compaction_model(
        AsyncMock(),
        messages,
        {"provider_type": "openai-compatible", "model_id": "writer-model"},
    )

    assert actual is response
    client.generate.assert_awaited_once_with(
        [
            {"role": "system", "content": "compress faithfully"},
            {"role": "user", "content": "story transcript"},
        ]
    )


@pytest.mark.asyncio
async def test_compaction_falls_back_when_no_light_model_is_configured(
    monkeypatch,
) -> None:
    from langchain_core.messages import AIMessage

    response = AIMessage(content="summary")
    model = SimpleNamespace(ainvoke=AsyncMock(return_value=response))
    monkeypatch.setattr(
        service,
        "resolve_background_llm",
        AsyncMock(side_effect=BackgroundModelUnavailableError("not configured")),
    )
    monkeypatch.setattr(service, "create_chat_model", lambda _config: model)

    actual = await service._invoke_compaction_model(
        AsyncMock(),
        [HumanMessage(content="story transcript")],
        {
            "provider_type": "openai-compatible",
            "base_url": "https://example.invalid/v1",
            "api_key": "test-only",
            "model_id": "writer-model",
            "max_context_tokens": 16_000,
        },
    )

    assert actual is response
    model.ainvoke.assert_awaited_once()
