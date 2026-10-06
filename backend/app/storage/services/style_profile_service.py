"""Compile confirmed project style notes into a bounded runtime card.

Notes remain the only persistence owner. Manuscripts and raw samples never
enter this context through the profile path.
"""

from dataclasses import dataclass
import html
import json
import re
from typing import Any
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.utils.tiktoken import count_tokens
from app.storage.repos import note_repo

STYLE_PROFILE_NOTE_TITLE = "项目文风档案"
STYLE_PROFILE_SKILL_ID = "builtin-skill--style-profile"
MAX_RUNTIME_STYLE_TOKENS = 800
MAX_PROFILE_CHARS = 32_000
# The note editor keeps the profile as rich text and re-serializes it as
# Markdown, escaping a wider punctuation set than JSON does. Undo exactly those
# escapes (including the backslash that introduces them) so the round-trip
# stays parseable; JSON escapes such as \n and \" are left untouched.
_MARKDOWN_ESCAPE = re.compile(r"\\([\\`*_\[\]~])")
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


class _ProfileRejected(Exception):
    """Rejection signal carrying the stage that dropped a profile."""

    def __init__(self, stage: str) -> None:
        super().__init__(stage)
        self.stage = stage


def _short_value(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    # The editor serializes text as HTML, so literal "<", ">" and "&" come back
    # as entities. Decode once here; the context part escapes the card itself.
    normalized = " ".join(html.unescape(value).split())
    return normalized if 0 < len(normalized) <= 64 else None


def _recover_profile(content: str) -> Any:
    """Parse the note editor's bounded Markdown/quote serialization damage."""
    normalized = _MARKDOWN_ESCAPE.sub(r"\1", content)
    try:
        return json.loads(normalized)
    except (ValueError, RecursionError):
        pass

    # Tiptap can leave literal quotes inside a JSON string unescaped. Repair
    # only that observed shape: a quote inside a string is data when the next
    # non-space character cannot legally follow a closing JSON quote. All
    # other malformed JSON must remain rejected rather than being guessed
    # into an executable profile.
    repaired: list[str] = []
    in_string = False
    escaped = False
    for index, char in enumerate(normalized):
        if not in_string:
            repaired.append(char)
            if char == '"':
                in_string = True
            continue
        if escaped:
            repaired.append(char)
            escaped = False
            continue
        if char == "\\":
            repaired.append(char)
            escaped = True
            continue
        if char != '"':
            repaired.append(char)
            continue
        next_non_space = next(
            (item for item in normalized[index + 1 :] if not item.isspace()), None
        )
        if next_non_space is not None and next_non_space not in ":,}]":
            repaired.append('\\"')
            continue
        repaired.append(char)
        in_string = False

    try:
        return json.loads("".join(repaired))
    except (ValueError, RecursionError) as exc:
        raise _ProfileRejected("parse") from exc


def _parse_profile(content: str) -> dict[str, Any]:
    if len(content) > MAX_PROFILE_CHARS:
        raise _ProfileRejected("size")
    try:
        parsed = json.loads(content)
    except RecursionError as exc:
        raise _ProfileRejected("parse") from exc
    except ValueError:
        parsed = _recover_profile(content)
    if not isinstance(parsed, dict):
        raise _ProfileRejected("parse")
    return parsed


def _compile_runtime_style_card(content: str) -> str:
    profile = _parse_profile(content)
    if type(profile.get("schema_version")) is not int or profile["schema_version"] != 1:
        raise _ProfileRejected("schema")
    if profile.get("status") != "confirmed":
        raise _ProfileRejected("status")

    lines: list[str] = []
    for category, fields in _FIELDS.items():
        values = profile.get(category, {})
        if not isinstance(values, dict):
            raise _ProfileRejected("fields")
        pairs: list[str] = []
        for field in fields:
            if field not in values:
                continue
            value = _short_value(values[field])
            if value is None:
                raise _ProfileRejected("fields")
            pairs.append(f"{field}={value}")
        if pairs:
            lines.append(f"{category}: " + "; ".join(pairs))

    patterns = profile.get("anti_patterns", [])
    if not isinstance(patterns, list) or len(patterns) > 6:
        raise _ProfileRejected("anti_patterns")
    normalized_patterns: list[str] = []
    for pattern in patterns:
        value = _short_value(pattern)
        if value is None:
            raise _ProfileRejected("anti_patterns")
        if value not in normalized_patterns:
            normalized_patterns.append(value)
    if normalized_patterns:
        lines.append("anti_patterns: " + "; ".join(normalized_patterns))
    if not lines:
        raise _ProfileRejected("empty")
    card = "\n".join(lines)
    if count_tokens(card) > MAX_RUNTIME_STYLE_TOKENS:
        raise _ProfileRejected("budget")
    return card


def _log_rejection(stage: str, note_id: str | None) -> None:
    # Style profiles are user-authored guidance: record only the stage and the
    # note id, never the profile text.
    if note_id is None:
        logger.warning("Project style profile not applied: stage={}", stage)
    else:
        logger.warning(
            "Project style profile not applied: note_id={} stage={}", note_id, stage
        )


def compile_runtime_style_card(content: str) -> str | None:
    """Compile a confirmed profile, rejecting drafts and damage by stage."""
    try:
        return _compile_runtime_style_card(content)
    except _ProfileRejected as rejected:
        _log_rejection(rejected.stage, None)
        return None


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
    try:
        card = _compile_runtime_style_card(note.content)
    except _ProfileRejected as rejected:
        _log_rejection(rejected.stage, note.id)
        return None
    return RuntimeStyleCard(note_id=note.id, content=card, tokens=count_tokens(card))
