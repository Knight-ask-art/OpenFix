"""add volume identity to revision chapter snapshots

Revision ID: 1028
Revises: 1027
Create Date: 2026-10-03
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1028"
down_revision: Union[str, Sequence[str], None] = "1027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Store the chapter volume needed to restore cross-volume moves."""
    op.add_column(
        "revision_chapter_snapshots",
        sa.Column("volume_id", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_revision_chapter_snapshots_volume_id",
        "revision_chapter_snapshots",
        ["volume_id"],
    )


def downgrade() -> None:
    """Drop the optional snapshot volume identity."""
    op.drop_index(
        "ix_revision_chapter_snapshots_volume_id",
        table_name="revision_chapter_snapshots",
    )
    op.drop_column("revision_chapter_snapshots", "volume_id")
