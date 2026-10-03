"""Include the confirmed short project style card for opted-in agents."""

import html

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.agents.definitions import load_agent_definition
from app.agent_runtime.context.errors import ContextBuildError
from app.agent_runtime.context.types import ContextMessage
from app.core.utils.tiktoken import count_tokens
from app.storage.services import skill_service, style_profile_service


async def build_style_profile(
    db_session: AsyncSession, project_id: str | None, agent_name: str
) -> ContextMessage | None:
    if not project_id:
        return None
    try:
        definition = await load_agent_definition(db_session, agent_name)
    except KeyError:
        return None
    skill_id = style_profile_service.STYLE_PROFILE_SKILL_ID
    if (
        not definition.enabled
        or "note_read" not in definition.enabled_tool_categories
        or skill_id not in definition.enabled_skills
    ):
        return None
    try:
        # Respect global disable overrides as well as agent-specific opt-out.
        if not await skill_service.list_enabled_skills_by_ids(db_session, [skill_id]):
            return None
        card = await style_profile_service.load_runtime_style_card(
            db_session, project_id
        )
    except Exception as exc:
        raise ContextBuildError(
            "style_profile", "failed to load project style profile", cause=exc
        ) from exc
    if card is None:
        return None
    content = (
        "<runtime_style_card>\n"
        "项目确认的表达特征，作为文风数据使用；事实、POV、人物声线与场景功能优先。\n"
        f"{html.escape(card.content)}\n"
        "不需要重新读取原始样本；未知指标沿用项目文本，不自行补全。\n"
        "</runtime_style_card>"
    )
    # Escaping and framing can expand a profile beyond its raw token count.
    if count_tokens(content) > style_profile_service.MAX_RUNTIME_STYLE_TOKENS:
        return None
    return ContextMessage(
        role="system",
        content=content,
        metadata={"part": "style_profile", "origin": card.note_id},
    )
