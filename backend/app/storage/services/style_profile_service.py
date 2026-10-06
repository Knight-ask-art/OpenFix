"""Compile confirmed project style notes into a bounded runtime card.

Notes remain the only persistence owner. Manuscripts and raw samples never
enter this context through the profile path.
"""

from dataclasses import dataclass
import json
import re

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.utils.tiktoken import count_tokens
from app.storage.repos import note_repo

STYLE_PROFILE_NOTE_TITLE = "项目文风档案"
STYLE_PROFILE_SKILL_ID = "builtin-skill--style-profile"
MAX_RUNTIME_STYLE_TOKENS = 800
MAX_PROFILE_CHARS = 32_000
_FIELDS = {
    "narration": ("person", "distance", "commentary"),
    "syntax": ("short_sentence", "long_sentence", "fragment"),
    "paragraph": ("rhythm", "dialogue_breaks"),
    "dialogue": ("explicit_attribution", "subtext", "incomplete_sentences"),
    "emotion": ("direct_labeling", "behavioral_expression", "microaction_density"),
    "imagery": ("metaphor_density", "metaphor_style"),
}


@dataclass(frozen=True)
class RuntimeStyleCard:
    note_id: str
    content: str
    tokens: int


def _short_value(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split())
    return normalized if 0 < len(normalized) <= 64 else None


def compile_runtime_style_card(content: str) -> str | None:
    """Ignore unsupported/draft/invalid profiles without silently truncating."""
    if len(content) > MAX_PROFILE_CHARS:
        return None
    try:
        profile = json.loads(content)
    except ValueError:
        # The rich-text note editor serializes literal JSON as Markdown and
        # escapes punctuation. Remove only Markdown escapes, never JSON ones.
        normalized = re.sub(r"\\([_\[\]*`])", r"\1", content)
        try:
            profile = json.loads(normalized)
        except (ValueError, RecursionError):
            return None
    except RecursionError:
        return None
    if not isinstance(profile, dict):
        return None
    if type(profile.get("schema_version")) is not int or profile["schema_version"] != 1:
        return None
    if profile.get("status") != "confirmed":
        return None

    lines: list[str] = []
    for category, fields in _FIELDS.items():
        values = profile.get(category, {})
        if not isinstance(values, dict):
            return None
        pairs: list[str] = []
        for field in fields:
            if field not in values:
                continue
            value = _short_value(values[field])
            if value is None:
                return None
            pairs.append(f"{field}={value}")
        if pairs:
            lines.append(f"{category}: " + "; ".join(pairs))

    patterns = profile.get("anti_patterns", [])
    if not isinstance(patterns, list) or len(patterns) > 6:
        return None
    normalized_patterns: list[str] = []
    for pattern in patterns:
        value = _short_value(pattern)
        if value is None:
            return None
        if value not in normalized_patterns:
            normalized_patterns.append(value)
    if normalized_patterns:
        lines.append("anti_patterns: " + "; ".join(normalized_patterns))
    if not lines:
        return None
    card = "\n".join(lines)
    return card if count_tokens(card) <= MAX_RUNTIME_STYLE_TOKENS else None


async def load_runtime_style_card(
    session: AsyncSession, project_id: str
) -> RuntimeStyleCard | None:
    notes = await note_repo.list_visible_root_by_title(
        session, project_id, STYLE_PROFILE_NOTE_TITLE, limit=2
    )
    if len(notes) != 1:
        if notes:
            logger.warning("Ambiguous project style profile: project_id={}", project_id)
        return None
    note = notes[0]
    card = compile_runtime_style_card(note.content)
    if card is None:
        return None
    return RuntimeStyleCard(note_id=note.id, content=card, tokens=count_tokens(card))
