"""recount chapter word counts

Revision ID: 1031
Revises: 1030
Create Date: 2026-10-06

Chapter word counts stored before this release were written by a counter that
treated standalone punctuation as an English token, so the saved statistics
disagreed with the editor for the same manuscript text. This migration
re-derives every cached word count from the stored text and refreshes the
project total, without any model call.

Manuscript text, chapter status, timestamps and writing-activity rows are left
untouched; only the cached word_count columns change.
"""

from __future__ import annotations

from typing import Sequence, Union
import unicodedata

from alembic import op
import sqlalchemy as sa
from sqlalchemy.engine import Connection


revision: str = "1031"
down_revision: Union[str, Sequence[str], None] = "1030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Rows are read back through keyset pagination so a long manuscript never has to
# be materialized in one query.
_BATCH_SIZE = 200

# Frozen copy of app.core.word_count.CJK_RANGES as of this revision. The counting
# rules are duplicated instead of imported: a migration has to keep replaying with
# the rules that were current when it shipped, and importing the runtime counter
# would silently change its result after a later rule change.
_FROZEN_CJK_RANGES: tuple[tuple[int, int], ...] = (
    (0x1100, 0x11FF),  # Hangul Jamo
    (0x2E80, 0x2EFF),  # CJK Radicals Supplement
    (0x2F00, 0x2FDF),  # Kangxi Radicals
    (0x3005, 0x3005),  # Ideographic iteration mark
    (0x3007, 0x3007),  # Ideographic number zero
    (0x3021, 0x3029),  # Hangzhou numerals
    (0x3038, 0x303B),  # CJK strokes and vertical iteration marks
    (0x3041, 0x3096),  # Hiragana
    (0x309D, 0x309F),  # Hiragana digraphs
    (0x30A1, 0x30FA),  # Katakana
    (0x30FC, 0x30FF),  # Katakana length mark and digraphs
    (0x3105, 0x312F),  # Bopomofo
    (0x3131, 0x318E),  # Hangul Compatibility Jamo
    (0x31A0, 0x31BF),  # Bopomofo Extended
    (0x31F0, 0x31FF),  # Katakana Phonetic Extensions
    (0x3400, 0x4DBF),  # CJK Unified Ideographs Extension A
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0xA960, 0xA97F),  # Hangul Jamo Extended-A
    (0xAC00, 0xD7A3),  # Hangul Syllables
    (0xD7B0, 0xD7FB),  # Hangul Jamo Extended-B
    (0xF900, 0xFAFF),  # CJK Compatibility Ideographs
    (0xFF66, 0xFF9F),  # Halfwidth Katakana
    (0x20000, 0x2A6DF),  # CJK Unified Ideographs Extension B
    (0x2A700, 0x2EBEF),  # CJK Unified Ideographs Extensions C to F
    (0x2F800, 0x2FA1F),  # CJK Compatibility Ideographs Supplement
)

# projects.word_count is the sum of its chapter counts, matching
# chapter_repo.get_total_word_count and chapter_service._update_project_stats.
_PROJECT_WORD_COUNT_EXPRESSION = (
    "COALESCE((SELECT SUM(chapters.word_count) FROM chapters "
    "WHERE chapters.project_id = projects.id), 0)"
)


def _is_frozen_cjk_character(char: str) -> bool:
    """Return whether a single character counts as one word on its own."""
    code_point = ord(char)
    return any(start <= code_point <= end for start, end in _FROZEN_CJK_RANGES)


def _count_words(text: str) -> int:
    """Count words with the frozen rules that shipped with this revision."""
    if not text:
        return 0

    total = 0
    in_token = False
    for char in text:
        if _is_frozen_cjk_character(char):
            total += 1
            in_token = False
            continue

        category = unicodedata.category(char)
        if category.startswith("M"):
            # Combining marks belong to the previous character: they neither count
            # nor break the current token.
            continue
        if category.startswith("L") or category == "Nd":
            if not in_token:
                total += 1
                in_token = True
            continue

        in_token = False

    return total


def _recount_chapter_word_counts(bind: Connection) -> None:
    """Rewrite chapters.word_count from chapters.content only where it differs."""
    select_statement = sa.text(
        "SELECT id AS chapter_id, content AS content, word_count AS word_count "
        "FROM chapters "
        "WHERE :last_id IS NULL OR id > :last_id "
        "ORDER BY id LIMIT :batch_size"
    )
    update_statement = sa.text(
        "UPDATE chapters SET word_count = :word_count WHERE id = :chapter_id"
    )

    last_id: str | None = None
    while True:
        rows = (
            bind.execute(
                select_statement,
                {"last_id": last_id, "batch_size": _BATCH_SIZE},
            )
            .mappings()
            .all()
        )
        if not rows:
            return

        updates: list[dict[str, object]] = []
        for row in rows:
            word_count = _count_words(row["content"] or "")
            if row["word_count"] != word_count:
                updates.append(
                    {"chapter_id": row["chapter_id"], "word_count": word_count}
                )
        if updates:
            bind.execute(update_statement, updates)

        last_id = str(rows[-1]["chapter_id"])


def _recount_project_word_counts(bind: Connection) -> None:
    """Rewrite projects.word_count as the sum of its recounted chapters."""
    bind.execute(
        sa.text(
            "UPDATE projects "
            f"SET word_count = {_PROJECT_WORD_COUNT_EXPRESSION} "
            f"WHERE word_count <> {_PROJECT_WORD_COUNT_EXPRESSION}"
        )
    )


def upgrade() -> None:
    """Recompute cached word counts from the stored manuscript text."""
    bind = op.get_bind()
    _recount_chapter_word_counts(bind)
    _recount_project_word_counts(bind)


def downgrade() -> None:
    """Leave the recounted values in place.

    The superseded counter cannot be reproduced from the manuscript, and writing
    its output back would only restore the statistics drift this migration removes.
    """
