"""add per-agent reasoning effort

Revision ID: 1030
Revises: 1029
Create Date: 2026-10-05
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1030"
down_revision: Union[str, Sequence[str], None] = "1029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Keep existing agent definitions inheriting the active session effort."""
    op.add_column(
        "agent_definitions",
        sa.Column(
            "reasoning_effort",
            sa.String(length=20),
            nullable=False,
            server_default="inherit",
        ),
    )


def downgrade() -> None:
    """Remove the per-agent override."""
    op.drop_column("agent_definitions", "reasoning_effort")
