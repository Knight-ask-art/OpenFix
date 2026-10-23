"""Runtime observation: bounded style/model metadata without prompt content."""

import hashlib
import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.agent_runtime.agents.definitions import get_default_agent_definition
from app.agent_runtime.context.build_context import _finalize_style_receipt
from app.agent_runtime.context.parts.style_profile import build_style_profile
from app.agent_runtime.context.source_snapshot import (
    MAX_RUNTIME_LABEL_LENGTH,
    MAX_RUNTIME_NOTE_ID_LENGTH,
    MAX_RUNTIME_TOKEN_VALUE,
    RUNTIME_STYLE_SKIP_REASONS,
    sanitize_agent_context_runtime,
)
from app.agent_runtime.persistence.persister import MessagePersister
from app.agent_runtime.persistence.task_projection import _project_rows
from app.agent_runtime.persistence.types import PersistedMessage
from app.core.utils.tiktoken import count_tokens
from app.storage.services.style_profile_service import MAX_RUNTIME_STYLE_TOKENS

_STYLE_PROFILE_PATCHES = "app.agent_runtime.context.parts.style_profile"


def _patch_style_dependencies(
    monkeypatch, *, definition=None, card=None, skill_error=False
):
    if skill_error:
        monkeypatch.setattr(
            f"{_STYLE_PROFILE_PATCHES}.load_agent_definition",
            AsyncMock(side_effect=KeyError("missing")),
        )
    else:
        monkeypatch.setattr(
            f"{_STYLE_PROFILE_PATCHES}.load_agent_definition",
            AsyncMock(
                return_value=definition or get_default_agent_definition("writer")
            ),
        )
    monkeypatch.setattr(
        f"{_STYLE_PROFILE_PATCHES}.skill_service.list_enabled_skills_by_ids",
        AsyncMock(return_value=[object()]),
    )
    monkeypatch.setattr(
        f"{_STYLE_PROFILE_PATCHES}.style_profile_service.load_runtime_style_card",
        AsyncMock(return_value=card),
    )


@pytest.mark.asyncio
async def test_loaded_receipt_reports_exact_hash_tokens_and_stays_content_free(
    monkeypatch,
):
    body = "narration: person=third_limited\ndialogue: subtext=high"
    _patch_style_dependencies(
        monkeypatch,
        card=SimpleNamespace(note_id="note-1", content=body, tokens=7),
    )

    receipt: dict[str, object] = {
        "status": "stale",
        "content": "SECRET_PROMPT_TEXT",
        "prompt": "SECRET_PROMPT_TEXT",
    }
    message = await build_style_profile(AsyncMock(), "project-1", "writer", receipt)

    assert message is not None
    assert receipt == {
        "status": "loaded",
        "noteId": "note-1",
        "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "tokens": count_tokens(message.content),
        "budget": MAX_RUNTIME_STYLE_TOKENS,
    }
    assert set(receipt) == {"status", "noteId", "sha256", "tokens", "budget"}
    assert "SECRET_PROMPT_TEXT" not in json.dumps(receipt)

    # Old three-argument callers remain compatible.
    legacy = await build_style_profile(AsyncMock(), "project-1", "writer")
    assert legacy is not None
    assert legacy.metadata["part"] == "style_profile"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reason",
    [
        "no_project",
        "agent_unavailable",
        "agent_disabled",
        "note_read_disabled",
        "skill_disabled",
        "no_valid_confirmed_card",
        "token_budget",
    ],
)
async def test_style_skips_report_fixed_reason_without_fake_message(
    monkeypatch, reason
):
    project_id: str | None = "project-1"
    card = SimpleNamespace(
        note_id="note-1", content="narration: person=third_limited", tokens=5
    )
    definition = get_default_agent_definition("writer")

    if reason == "no_project":
        project_id = None
    elif reason == "agent_disabled":
        definition = replace(definition, enabled=False)
    elif reason == "note_read_disabled":
        definition = replace(definition, enabled_tool_categories=())
    elif reason == "skill_disabled":
        definition = replace(definition, enabled_skills=())
    elif reason == "no_valid_confirmed_card":
        card = None
    elif reason == "token_budget":
        card = SimpleNamespace(note_id="note-1", content="x" * 100_000, tokens=1)

    _patch_style_dependencies(
        monkeypatch,
        definition=definition,
        card=card,
        skill_error=reason == "agent_unavailable",
    )

    receipt: dict[str, object] = {"content": "SECRET_PROMPT_TEXT"}
    message = await build_style_profile(
        AsyncMock(), project_id, "writer", receipt
    )

    assert message is None
    assert receipt["status"] == "skipped"
    assert receipt["reason"] == reason
    assert reason in RUNTIME_STYLE_SKIP_REASONS
    assert "SECRET_PROMPT_TEXT" not in json.dumps(receipt)
    if reason == "token_budget":
        assert receipt["tokens"] > receipt["budget"] == MAX_RUNTIME_STYLE_TOKENS
    else:
        assert set(receipt) == {"status", "reason"}


def test_dropped_style_receipt_is_fixed_reason_and_clears_loaded_fields():
    receipt = {
        "status": "loaded",
        "noteId": "note-1",
        "sha256": "a" * 64,
        "tokens": 10,
        "budget": MAX_RUNTIME_STYLE_TOKENS,
        "content": "SECRET_PROMPT_TEXT",
    }

    _finalize_style_receipt(receipt, [])

    assert receipt == {"status": "skipped", "reason": "dropped"}
    assert "SECRET_PROMPT_TEXT" not in json.dumps(receipt)


def test_sanitizer_keeps_only_bounded_runtime_observation_fields():
    secret = "SECRET_PROMPT_TEXT"
    sha256 = "a" * 64
    note_id = "n" * 200
    hostile = {
        "text": secret,
        "content": secret,
        "prompt": secret,
        "api_key": "sk-secret",
        "base_url": "https://provider.invalid",
        "headers": {"Authorization": "Bearer secret"},
        "endpoint": "/v1/chat/completions",
        "custom": {"nested": secret},
    }
    value = {
        "model": {
            "id": "  guard   model  ",
            "recordId": "   ",
            **hostile,
        },
        "style": {
            "status": "loaded",
            "noteId": note_id,
            "sha256": sha256,
            "tokens": 10,
            "budget": MAX_RUNTIME_STYLE_TOKENS,
            **hostile,
        },
        **hostile,
    }

    sanitized = sanitize_agent_context_runtime(value)

    assert sanitized == {
        "model": {"id": "guard model", "recordId": None},
        "style": {
            "status": "loaded",
            "noteId": "n" * MAX_RUNTIME_NOTE_ID_LENGTH,
            "sha256": sha256,
            "tokens": 10,
            "budget": MAX_RUNTIME_STYLE_TOKENS,
        },
    }
    dumped = json.dumps(sanitized)
    for marker in (
        secret,
        "sk-secret",
        "provider.invalid",
        "Authorization",
        "/v1/chat/completions",
    ):
        assert marker not in dumped


def test_model_labels_are_bounded_to_the_label_limit():
    sanitized = sanitize_agent_context_runtime(
        {"model": {"id": "m" * 200, "recordId": "r" * 200}}
    )

    assert sanitized == {
        "model": {
            "id": "m" * MAX_RUNTIME_LABEL_LENGTH,
            "recordId": "r" * MAX_RUNTIME_LABEL_LENGTH,
        }
    }


def test_skip_reason_contract_is_fixed_and_budget_counts_are_bounded():
    for reason in RUNTIME_STYLE_SKIP_REASONS:
        sanitized = sanitize_agent_context_runtime(
            {
                "style": {
                    "status": "skipped",
                    "reason": reason,
                    "tokens": 900,
                    "budget": 800,
                    "text": "SECRET_PROMPT_TEXT",
                }
            }
        )
        expected_style = {"status": "skipped", "reason": reason}
        if reason == "token_budget":
            expected_style.update(tokens=900, budget=800)
        assert sanitized == {"style": expected_style}

    assert (
        sanitize_agent_context_runtime(
            {"style": {"status": "skipped", "reason": "free_form_reason"}}
        )
        is None
    )
    assert sanitize_agent_context_runtime(
        {
            "style": {
                "status": "skipped",
                "reason": "token_budget",
                "tokens": MAX_RUNTIME_TOKEN_VALUE + 1,
                "budget": MAX_RUNTIME_TOKEN_VALUE + 1,
            }
        }
    ) == {"style": {"status": "skipped", "reason": "token_budget"}}


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        "runtime",
        {"text": "SECRET_PROMPT_TEXT"},
        {"style": {"status": "unknown", "reason": "no_project"}},
        {"style": {"status": "skipped"}},
        {"style": {"status": "skipped", "reason": 1}},
        {"style": {"status": "loaded", "noteId": "n", "sha256": "A" * 64,
                   "tokens": 1, "budget": 2}},
        {"style": {"status": "loaded", "noteId": "n", "sha256": "a" * 63,
                   "tokens": 1, "budget": 2}},
        {"style": {"status": "loaded", "noteId": 5, "sha256": "a" * 64,
                   "tokens": 1, "budget": 2}},
        {"style": {"status": "loaded", "noteId": "n", "sha256": "a" * 64,
                   "tokens": True, "budget": 2}},
        {"style": {"status": "loaded", "noteId": "n", "sha256": "a" * 64,
                   "tokens": -1, "budget": 2}},
        {"style": {"status": "loaded", "noteId": "n", "sha256": "a" * 64,
                   "tokens": 1, "budget": MAX_RUNTIME_TOKEN_VALUE + 1}},
        {"model": {"id": 5, "recordId": None}},
        {"model": {"id": "", "recordId": "   "}},
    ],
)
def test_sanitizer_rejects_malformed_runtime(value):
    assert sanitize_agent_context_runtime(value) is None


def test_runtime_count_boundaries_accept_int_range_only():
    valid = sanitize_agent_context_runtime(
        {
            "style": {
                "status": "loaded",
                "noteId": "n",
                "sha256": "a" * 64,
                "tokens": 0,
                "budget": MAX_RUNTIME_TOKEN_VALUE,
            }
        }
    )
    assert valid == {
        "style": {
            "status": "loaded",
            "noteId": "n",
            "sha256": "a" * 64,
            "tokens": 0,
            "budget": MAX_RUNTIME_TOKEN_VALUE,
        }
    }

    for bad in (True, False, -1, MAX_RUNTIME_TOKEN_VALUE + 1, 1.5, "1", None):
        assert (
            sanitize_agent_context_runtime(
                {
                    "style": {
                        "status": "loaded",
                        "noteId": "n",
                        "sha256": "a" * 64,
                        "tokens": bad,
                        "budget": 2,
                    }
                }
            )
            is None
        )


@pytest.mark.asyncio
async def test_persister_and_projector_roundtrip_sanitized_runtime(monkeypatch):
    live_payload = {
        "session_id": "session-1",
        "agent_id": "writer",
        "context_sources": [
            {
                "id": "chapter:guard-1",
                "category": "chapter",
                "title": "第一章",
                "sourceTypes": ["chapterBody"],
                "content": "SECRET_PROMPT_TEXT",
            }
        ],
        "context_runtime": {
            "model": {
                "id": "live-model",
                "recordId": "record-1",
                "api_key": "sk-secret",
                "base_url": "https://provider.invalid",
                "endpoint": "/v1/chat/completions",
            },
            "style": {
                "status": "loaded",
                "noteId": "note-1",
                "sha256": "b" * 64,
                "tokens": 12,
                "budget": MAX_RUNTIME_STYLE_TOKENS,
                "content": "SECRET_PROMPT_TEXT",
                "prompt": "SECRET_PROMPT_TEXT",
            },
            "text": "SECRET_PROMPT_TEXT",
            "custom": {"nested": "SECRET_PROMPT_TEXT"},
        },
    }
    expected_runtime = sanitize_agent_context_runtime(
        live_payload["context_runtime"]
    )
    assert expected_runtime is not None

    persister = MessagePersister("session-1", "task-1", "project-1", lambda: None)
    captured: dict = {}

    async def fake_write(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(persister, "_write", fake_write)
    await persister.persist_context_snapshot(live_payload)

    assert captured["message_type"] == "context_snapshot"
    assert captured["metadata"]["context_runtime"] == expected_runtime

    row = PersistedMessage(
        id="snapshot-1",
        session_id="session-1",
        task_id="task-1",
        project_id="project-1",
        role="system",
        agent_id="writer",
        content="",
        reasoning=None,
        reasoning_duration_ms=None,
        tool_calls=None,
        tool_call_id=None,
        tool_name=None,
        status="complete",
        message_type="context_snapshot",
        display_channel="hidden",
        llm_visibility="hidden",
        seq=1,
        metadata=captured["metadata"],
    )

    projected = _project_rows([row])

    assert len(projected) == 1
    assert projected[0].payload["context_runtime"] == expected_runtime
    projected_json = json.dumps(projected[0].payload, ensure_ascii=False)
    assert "SECRET_PROMPT_TEXT" not in projected_json
    assert "api_key" not in projected_json
    assert "provider.invalid" not in projected_json
