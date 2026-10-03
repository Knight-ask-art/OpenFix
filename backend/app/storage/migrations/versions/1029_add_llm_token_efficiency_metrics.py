"""add token efficiency metrics to LLM audit logs

Revision ID: 1029
Revises: 1028
Create Date: 2026-10-04
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1029"
down_revision: Union[str, Sequence[str], None] = "1028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_INTEGER_COLUMNS = (
    "token_cache_write",
    "tokens_input_uncached",
    "tokens_input_total",
    "tokens_reasoning",
    "context_tokens_estimated",
    "tool_schema_tokens_estimated",
    "context_budget_tokens",
    "tokens_pruned",
    "tokens_compacted",
    "tool_result_tokens",
)


def upgrade() -> None:
    """Add aggregate-only context and provider usage measurements."""
    for column_name in _INTEGER_COLUMNS:
        op.add_column(
            "agent_audit_logs",
            sa.Column(column_name, sa.Integer(), nullable=False, server_default="0"),
        )
    op.add_column(
        "agent_audit_logs",
        sa.Column("cache_hit_rate", sa.Float(), nullable=False, server_default="0"),
    )
    op.add_column(
        "agent_audit_logs",
        sa.Column("context_fingerprint", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "agent_audit_logs",
        sa.Column(
            "context_token_breakdown",
            sa.Text(),
            nullable=False,
            server_default="{}",
        ),
    )


def downgrade() -> None:
    """Remove the additive token efficiency columns."""
    for column_name in (
        "context_token_breakdown",
        "context_fingerprint",
        "cache_hit_rate",
        *_INTEGER_COLUMNS[::-1],
    ):
        op.drop_column("agent_audit_logs", column_name)
