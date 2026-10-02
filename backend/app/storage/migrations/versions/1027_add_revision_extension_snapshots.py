"""create revision extension snapshot table

Revision ID: 1027
Revises: 1026
Create Date: 2026-10-02
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1027"
down_revision: Union[str, Sequence[str], None] = "1026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create revision_extension_snapshots table."""
    op.create_table(
        "revision_extension_snapshots",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("revision_id", sa.String(), nullable=False),
        sa.Column("entity_type", sa.String(length=20), nullable=False),
        sa.Column("entity_id", sa.String(), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["revision_id"], ["revisions.id"]),
        sa.UniqueConstraint(
            "revision_id",
            "entity_type",
            "entity_id",
            name="uq_revision_extension_snapshot",
        ),
    )
    op.create_index(
        "ix_revision_extension_snapshots_revision_id",
        "revision_extension_snapshots",
        ["revision_id"],
    )
    op.create_index(
        "ix_revision_extension_snapshots_entity_type",
        "revision_extension_snapshots",
        ["entity_type"],
    )
    op.create_index(
        "ix_revision_extension_snapshots_entity_id",
        "revision_extension_snapshots",
        ["entity_id"],
    )


def downgrade() -> None:
    """Drop revision_extension_snapshots table."""
    op.drop_index(
        "ix_revision_extension_snapshots_entity_id",
        table_name="revision_extension_snapshots",
    )
    op.drop_index(
        "ix_revision_extension_snapshots_entity_type",
        table_name="revision_extension_snapshots",
    )
    op.drop_index(
        "ix_revision_extension_snapshots_revision_id",
        table_name="revision_extension_snapshots",
    )
    op.drop_table("revision_extension_snapshots")
