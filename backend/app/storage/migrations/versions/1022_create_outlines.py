"""create outlines table

Revision ID: 1022
Revises: 1021
Create Date: 2026-09-24
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1022"
down_revision: Union[str, Sequence[str], None] = "1021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the outline tree table."""
    op.create_table(
        "outlines",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("parent_id", sa.String(), nullable=True),
        sa.Column("volume_id", sa.String(), nullable=True),
        sa.Column("chapter_id", sa.String(), nullable=True),
        sa.Column("level", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["outlines.id"]),
        sa.CheckConstraint(
            "level IN ('book', 'arc', 'volume', 'chapter')", name="ck_outlines_level"
        ),
    )
    op.create_index("ix_outlines_project_id", "outlines", ["project_id"])
    op.create_index("ix_outlines_parent_id", "outlines", ["parent_id"])
    op.create_index("ix_outlines_level", "outlines", ["level"])
    op.create_index("ix_outlines_volume_id", "outlines", ["volume_id"])
    op.create_index("ix_outlines_chapter_id", "outlines", ["chapter_id"])
    op.create_index(
        "ix_outlines_project_parent_sort", "outlines", ["project_id", "parent_id", "sort_order"]
    )


def downgrade() -> None:
    """Drop the outline tree table."""
    op.drop_index("ix_outlines_project_parent_sort", table_name="outlines")
    op.drop_index("ix_outlines_chapter_id", table_name="outlines")
    op.drop_index("ix_outlines_volume_id", table_name="outlines")
    op.drop_index("ix_outlines_level", table_name="outlines")
    op.drop_index("ix_outlines_parent_id", table_name="outlines")
    op.drop_index("ix_outlines_project_id", table_name="outlines")
    op.drop_table("outlines")
