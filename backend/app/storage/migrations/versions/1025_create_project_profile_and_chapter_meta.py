"""create project profile and chapter meta extension tables

Revision ID: 1025
Revises: 1024
Create Date: 2026-10-02
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1025"
down_revision: Union[str, Sequence[str], None] = "1024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create project_profiles and chapter_meta extension tables."""
    op.create_table(
        "project_profiles",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("genre", sa.String(length=50), nullable=False, server_default=""),
        sa.Column("synopsis", sa.Text(), nullable=False, server_default=""),
        sa.Column("target_word_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("daily_word_goal", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "status", sa.String(length=30), nullable=False, server_default="drafting"
        ),
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
        sa.UniqueConstraint("project_id", name="uq_project_profiles_project"),
    )
    op.create_index("ix_project_profiles_project_id", "project_profiles", ["project_id"])

    op.create_table(
        "chapter_meta",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("chapter_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        sa.Column("target_word_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_ai_check_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(["chapter_id"], ["chapters.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.UniqueConstraint("chapter_id", name="uq_chapter_meta_chapter"),
    )
    op.create_index("ix_chapter_meta_chapter_id", "chapter_meta", ["chapter_id"])
    op.create_index("ix_chapter_meta_project_id", "chapter_meta", ["project_id"])
    op.create_index("ix_chapter_meta_status", "chapter_meta", ["status"])


def downgrade() -> None:
    """Drop project profile and chapter meta tables."""
    op.drop_index("ix_chapter_meta_status", table_name="chapter_meta")
    op.drop_index("ix_chapter_meta_project_id", table_name="chapter_meta")
    op.drop_index("ix_chapter_meta_chapter_id", table_name="chapter_meta")
    op.drop_table("chapter_meta")
    op.drop_index("ix_project_profiles_project_id", table_name="project_profiles")
    op.drop_table("project_profiles")
