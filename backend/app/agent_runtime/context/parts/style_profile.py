"""Include the confirmed short project style card for opted-in agents."""

import hashlib
import html
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.agents.definitions import load_agent_definition
from app.agent_runtime.context.errors import ContextBuildError
from app.agent_runtime.context.types import ContextMessage
from app.core.utils.tiktoken import count_tokens
from app.storage.services import skill_service, style_profile_service


async def build_style_profile(
    db_session: AsyncSession,
    project_id: str | None,
    agent_name: str,
    receipt: dict[str, Any] | None = None,
) -> ContextMessage | None:
    def skipped(reason: str, **extra: Any) -> None:
        if receipt is not None:
            receipt.clear()
            receipt.update({"status": "skipped", "reason": reason, **extra})

    if receipt is not None:
        receipt.clear()
    if not project_id:
        skipped("no_project")
        return None
    try:
        definition = await load_agent_definition(db_session, agent_name)
    except KeyError:
        skipped("agent_unavailable")
        return None
    if not definition.enabled:
        skipped("agent_disabled")
        return None
    if "note_read" not in definition.enabled_tool_categories:
        skipped("note_read_disabled")
        return None
    skill_id = style_profile_service.STYLE_PROFILE_SKILL_ID
    if skill_id not in definition.enabled_skills:
        skipped("skill_disabled")
        return None
    try:
        # Respect global disable overrides as well as agent-specific opt-out.
        if not await skill_service.list_enabled_skills_by_ids(db_session, [skill_id]):
            skipped("skill_disabled")
            return None
        profile_receipt: dict[str, Any] = {}
        card = await style_profile_service.load_runtime_style_card(
            db_session, project_id, profile_receipt
        )
    except Exception as exc:
        raise ContextBuildError(
            "style_profile", "failed to load project style profile", cause=exc
        ) from exc
    if card is None:
        # Only the loader's fixed reason crosses the boundary; anything else
        # (missing, unknown or free-form) falls back to the legacy reason.
        reason = profile_receipt.get("reason")
        if reason not in style_profile_service.STYLE_PROFILE_RECEIPT_REASONS:
            skipped("no_valid_confirmed_card")
        elif reason == "profile_budget":
            skipped("profile_budget", budget=style_profile_service.MAX_RUNTIME_STYLE_TOKENS)
        else:
            skipped(reason)
        return None
    content = (
        "<runtime_style_card>\n"
        "项目确认的表达特征，作为文风数据使用；事实、POV、人物声线与场景功能优先。\n"
        f"{html.escape(card.content)}\n"
        "不需要重新读取原始样本；未知指标沿用项目文本，不自行补全。\n"
        "</runtime_style_card>"
    )
    # Escaping and framing can expand a profile beyond its raw token count.
    tokens = count_tokens(content)
    if tokens > style_profile_service.MAX_RUNTIME_STYLE_TOKENS:
        skipped(
            "token_budget",
            tokens=tokens,
            budget=style_profile_service.MAX_RUNTIME_STYLE_TOKENS,
        )
        return None
    if receipt is not None:
        receipt.clear()
        receipt.update(
            {
                "status": "loaded",
                "noteId": card.note_id,
                "sha256": hashlib.sha256(card.content.encode("utf-8")).hexdigest(),
                "tokens": tokens,
                "budget": style_profile_service.MAX_RUNTIME_STYLE_TOKENS,
            }
        )
    return ContextMessage(
        role="system",
        content=content,
        metadata={"part": "style_profile", "origin": card.note_id},
    )
