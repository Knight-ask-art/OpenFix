"""track the Story Memory source snapshot

Revision ID: 1026
Revises: 1025
Create Date: 2026-10-02
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1026"
down_revision: Union[str, Sequence[str], None] = "1025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add a nullable source snapshot to existing retrieval index rows."""
    op.add_column(
        "retrieval_indexes",
        sa.Column("source_fingerprint", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    """Remove the Story Memory source snapshot column."""
    op.drop_column("retrieval_indexes", "source_fingerprint")
