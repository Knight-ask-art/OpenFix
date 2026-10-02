"""create world entry meta extension table

Revision ID: 1024
Revises: 1023
Create Date: 2026-10-02
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1024"
down_revision: Union[str, Sequence[str], None] = "1023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create world_entry_meta extension table."""
    op.create_table(
        "world_entry_meta",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("entry_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column(
            "entry_type", sa.String(length=30), nullable=False, server_default="custom"
        ),
        sa.Column("tags_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("linked_character_ids_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("linked_chapter_ids_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("ai_visible", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "custom_type_label", sa.String(length=100), nullable=False, server_default=""
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
        sa.ForeignKeyConstraint(["entry_id"], ["world_info_entries.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.UniqueConstraint("entry_id", name="uq_world_entry_meta_entry"),
    )
    op.create_index("ix_world_entry_meta_entry_id", "world_entry_meta", ["entry_id"])
    op.create_index("ix_world_entry_meta_project_id", "world_entry_meta", ["project_id"])
    op.create_index("ix_world_entry_meta_entry_type", "world_entry_meta", ["entry_type"])


def downgrade() -> None:
    """Drop world entry meta extension table."""
    op.drop_index("ix_world_entry_meta_entry_type", table_name="world_entry_meta")
    op.drop_index("ix_world_entry_meta_project_id", table_name="world_entry_meta")
    op.drop_index("ix_world_entry_meta_entry_id", table_name="world_entry_meta")
    op.drop_table("world_entry_meta")
