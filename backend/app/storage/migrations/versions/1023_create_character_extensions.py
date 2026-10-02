"""create character author fields and per-chapter state

Revision ID: 1023
Revises: 1022
Create Date: 2026-10-02
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1023"
down_revision: Union[str, Sequence[str], None] = "1022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create character_profiles and character_states extension tables."""
    op.create_table(
        "character_profiles",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("character_id", sa.String(), nullable=False),
        sa.Column("alias", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("age", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("gender", sa.String(length=50), nullable=False, server_default=""),
        sa.Column("identity", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("faction", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("personality", sa.Text(), nullable=False, server_default=""),
        sa.Column("appearance", sa.Text(), nullable=False, server_default=""),
        sa.Column("background", sa.Text(), nullable=False, server_default=""),
        sa.Column("goal", sa.Text(), nullable=False, server_default=""),
        sa.Column("motivation", sa.Text(), nullable=False, server_default=""),
        sa.Column("fear", sa.Text(), nullable=False, server_default=""),
        sa.Column("secret", sa.Text(), nullable=False, server_default=""),
        sa.Column("abilities", sa.Text(), nullable=False, server_default=""),
        sa.Column("weakness", sa.Text(), nullable=False, server_default=""),
        sa.Column("arc", sa.Text(), nullable=False, server_default=""),
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
        sa.ForeignKeyConstraint(["character_id"], ["characters.id"]),
        sa.UniqueConstraint("character_id", name="uq_character_profiles_character"),
    )
    op.create_index(
        "ix_character_profiles_character_id", "character_profiles", ["character_id"]
    )

    op.create_table(
        "character_states",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("character_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("chapter_id", sa.String(), nullable=True),
        sa.Column("location", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("physical_state", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("mental_state", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("goal", sa.String(length=500), nullable=False, server_default=""),
        sa.Column(
            "relationship_note", sa.String(length=500), nullable=False, server_default=""
        ),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
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
        sa.ForeignKeyConstraint(["character_id"], ["characters.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
    )
    op.create_index("ix_character_states_character_id", "character_states", ["character_id"])
    op.create_index("ix_character_states_project_id", "character_states", ["project_id"])
    op.create_index("ix_character_states_chapter_id", "character_states", ["chapter_id"])


def downgrade() -> None:
    """Drop character extension tables."""
    op.drop_index("ix_character_states_chapter_id", table_name="character_states")
    op.drop_index("ix_character_states_project_id", table_name="character_states")
    op.drop_index("ix_character_states_character_id", table_name="character_states")
    op.drop_table("character_states")
    op.drop_index("ix_character_profiles_character_id", table_name="character_profiles")
    op.drop_table("character_profiles")
