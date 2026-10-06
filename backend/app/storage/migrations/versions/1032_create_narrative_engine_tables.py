"""create narrative engine foundation tables

Revision ID: 1032
Revises: 1031
Create Date: 2026-10-06

新增 Narrative Engine v1 基础层的四张扩展表：世界事实 / 人物信念 / 情节线 / 场景计划。

四张表彼此独立，共用同一组溯源与确认列（`source_type` ... `confirmed_by`），
不使用多态孤儿表：确认一条记录就是对该行的一次 UPDATE。

本迁移只新建表，不修改 `projects` / `chapters` / `characters` / `outlines` /
`world_info_entries` / `revisions` 等核心表；所有非空列都带 `server_default`，
旧库升级与降级都不影响既有数据。
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "1032"
down_revision: Union[str, Sequence[str], None] = "1031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


EMPTY_SCENE_RESULT_JSON = (
    '{"fact_changes": [], "belief_changes": [], "relationship_changes": [],'
    ' "state_changes": [], "plotline_changes": []}'
)


def _provenance_columns() -> list[sa.Column]:
    """四张表共享的溯源与确认列。"""
    return [
        sa.Column(
            "source_type", sa.String(length=30), nullable=False, server_default="user"
        ),
        sa.Column("source_id", sa.String(length=64), nullable=True),
        sa.Column("source_chapter_id", sa.String(length=64), nullable=True),
        sa.Column(
            "quote_anchor", sa.String(length=200), nullable=False, server_default=""
        ),
        sa.Column("created_by", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column(
            "confirmation",
            sa.String(length=20),
            nullable=False,
            server_default="candidate",
        ),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("confirmed_by", sa.String(length=100), nullable=True),
    ]


def _timestamps() -> list[sa.Column]:
    return [
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
    ]


def upgrade() -> None:
    """Create the four narrative engine extension tables."""
    op.create_table(
        "world_facts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("statement", sa.Text(), nullable=False, server_default=""),
        sa.Column("subject_ref", sa.String(length=200), nullable=False, server_default=""),
        sa.Column(
            "status", sa.String(length=20), nullable=False, server_default="uncertain"
        ),
        sa.Column("superseded_by_id", sa.String(length=64), nullable=True),
        *_provenance_columns(),
        *_timestamps(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["source_chapter_id"], ["chapters.id"]),
        sa.ForeignKeyConstraint(["superseded_by_id"], ["world_facts.id"]),
    )
    op.create_index("ix_world_facts_project_id", "world_facts", ["project_id"])
    op.create_index("ix_world_facts_status", "world_facts", ["status"])
    op.create_index("ix_world_facts_source_type", "world_facts", ["source_type"])
    op.create_index(
        "ix_world_facts_source_chapter_id", "world_facts", ["source_chapter_id"]
    )
    op.create_index("ix_world_facts_confirmation", "world_facts", ["confirmation"])
    op.create_index(
        "ix_world_facts_superseded_by_id", "world_facts", ["superseded_by_id"]
    )

    op.create_table(
        "character_beliefs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("character_id", sa.String(), nullable=False),
        sa.Column("proposition", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "belief_state", sa.String(length=20), nullable=False, server_default="believed"
        ),
        sa.Column("learned_at_chapter_id", sa.String(length=64), nullable=True),
        sa.Column("superseded_by_id", sa.String(length=64), nullable=True),
        sa.Column("invalidated_at", sa.DateTime(timezone=True), nullable=True),
        *_provenance_columns(),
        *_timestamps(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["character_id"], ["characters.id"]),
        sa.ForeignKeyConstraint(["learned_at_chapter_id"], ["chapters.id"]),
        sa.ForeignKeyConstraint(["source_chapter_id"], ["chapters.id"]),
        sa.ForeignKeyConstraint(["superseded_by_id"], ["character_beliefs.id"]),
    )
    op.create_index(
        "ix_character_beliefs_project_id", "character_beliefs", ["project_id"]
    )
    op.create_index(
        "ix_character_beliefs_character_id", "character_beliefs", ["character_id"]
    )
    op.create_index(
        "ix_character_beliefs_belief_state", "character_beliefs", ["belief_state"]
    )
    op.create_index(
        "ix_character_beliefs_source_type", "character_beliefs", ["source_type"]
    )
    op.create_index(
        "ix_character_beliefs_source_chapter_id",
        "character_beliefs",
        ["source_chapter_id"],
    )
    op.create_index(
        "ix_character_beliefs_confirmation", "character_beliefs", ["confirmation"]
    )
    op.create_index(
        "ix_character_beliefs_learned_at_chapter_id",
        "character_beliefs",
        ["learned_at_chapter_id"],
    )
    op.create_index(
        "ix_character_beliefs_superseded_by_id",
        "character_beliefs",
        ["superseded_by_id"],
    )

    op.create_table(
        "plotlines",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("current_question", sa.Text(), nullable=False, server_default=""),
        sa.Column("payoff", sa.Text(), nullable=False, server_default=""),
        sa.Column("state", sa.String(length=20), nullable=False, server_default="open"),
        sa.Column("introduced_chapter_id", sa.String(length=64), nullable=True),
        sa.Column("advanced_chapter_id", sa.String(length=64), nullable=True),
        sa.Column(
            "related_character_ids_json", sa.Text(), nullable=False, server_default="[]"
        ),
        sa.Column(
            "related_outline_ids_json", sa.Text(), nullable=False, server_default="[]"
        ),
        *_provenance_columns(),
        *_timestamps(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["introduced_chapter_id"], ["chapters.id"]),
        sa.ForeignKeyConstraint(["advanced_chapter_id"], ["chapters.id"]),
        sa.ForeignKeyConstraint(["source_chapter_id"], ["chapters.id"]),
    )
    op.create_index("ix_plotlines_project_id", "plotlines", ["project_id"])
    op.create_index("ix_plotlines_state", "plotlines", ["state"])
    op.create_index("ix_plotlines_source_type", "plotlines", ["source_type"])
    op.create_index(
        "ix_plotlines_source_chapter_id", "plotlines", ["source_chapter_id"]
    )
    op.create_index("ix_plotlines_confirmation", "plotlines", ["confirmation"])
    op.create_index(
        "ix_plotlines_introduced_chapter_id", "plotlines", ["introduced_chapter_id"]
    )
    op.create_index(
        "ix_plotlines_advanced_chapter_id", "plotlines", ["advanced_chapter_id"]
    )

    op.create_table(
        "scene_plans",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("chapter_id", sa.String(length=64), nullable=False),
        sa.Column("scene_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("goal", sa.Text(), nullable=False, server_default=""),
        sa.Column("pov_character_id", sa.String(length=64), nullable=True),
        sa.Column("location", sa.String(length=200), nullable=False, server_default=""),
        sa.Column("tone", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("preconditions_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("participants_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("character_goals_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column(
            "known_information_json", sa.Text(), nullable=False, server_default="[]"
        ),
        sa.Column(
            "hidden_information_json", sa.Text(), nullable=False, server_default="[]"
        ),
        sa.Column(
            "active_plotline_ids_json", sa.Text(), nullable=False, server_default="[]"
        ),
        sa.Column(
            "world_constraints_json", sa.Text(), nullable=False, server_default="[]"
        ),
        sa.Column("expected_changes_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column(
            "result_json",
            sa.Text(),
            nullable=False,
            server_default=EMPTY_SCENE_RESULT_JSON,
        ),
        *_provenance_columns(),
        *_timestamps(),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["chapter_id"], ["chapters.id"]),
        sa.ForeignKeyConstraint(["pov_character_id"], ["characters.id"]),
        sa.ForeignKeyConstraint(["source_chapter_id"], ["chapters.id"]),
        sa.UniqueConstraint(
            "chapter_id", "scene_index", name="uq_scene_plans_chapter_index"
        ),
    )
    op.create_index("ix_scene_plans_project_id", "scene_plans", ["project_id"])
    op.create_index("ix_scene_plans_chapter_id", "scene_plans", ["chapter_id"])
    op.create_index("ix_scene_plans_scene_index", "scene_plans", ["scene_index"])
    op.create_index(
        "ix_scene_plans_pov_character_id", "scene_plans", ["pov_character_id"]
    )
    op.create_index("ix_scene_plans_source_type", "scene_plans", ["source_type"])
    op.create_index(
        "ix_scene_plans_source_chapter_id", "scene_plans", ["source_chapter_id"]
    )
    op.create_index("ix_scene_plans_confirmation", "scene_plans", ["confirmation"])


def downgrade() -> None:
    """Drop the narrative engine extension tables."""
    op.drop_index("ix_scene_plans_confirmation", table_name="scene_plans")
    op.drop_index("ix_scene_plans_source_chapter_id", table_name="scene_plans")
    op.drop_index("ix_scene_plans_source_type", table_name="scene_plans")
    op.drop_index("ix_scene_plans_pov_character_id", table_name="scene_plans")
    op.drop_index("ix_scene_plans_scene_index", table_name="scene_plans")
    op.drop_index("ix_scene_plans_chapter_id", table_name="scene_plans")
    op.drop_index("ix_scene_plans_project_id", table_name="scene_plans")
    op.drop_table("scene_plans")

    op.drop_index("ix_plotlines_advanced_chapter_id", table_name="plotlines")
    op.drop_index("ix_plotlines_introduced_chapter_id", table_name="plotlines")
    op.drop_index("ix_plotlines_confirmation", table_name="plotlines")
    op.drop_index("ix_plotlines_source_chapter_id", table_name="plotlines")
    op.drop_index("ix_plotlines_source_type", table_name="plotlines")
    op.drop_index("ix_plotlines_state", table_name="plotlines")
    op.drop_index("ix_plotlines_project_id", table_name="plotlines")
    op.drop_table("plotlines")

    op.drop_index(
        "ix_character_beliefs_superseded_by_id", table_name="character_beliefs"
    )
    op.drop_index(
        "ix_character_beliefs_learned_at_chapter_id", table_name="character_beliefs"
    )
    op.drop_index("ix_character_beliefs_confirmation", table_name="character_beliefs")
    op.drop_index(
        "ix_character_beliefs_source_chapter_id", table_name="character_beliefs"
    )
    op.drop_index("ix_character_beliefs_source_type", table_name="character_beliefs")
    op.drop_index("ix_character_beliefs_belief_state", table_name="character_beliefs")
    op.drop_index("ix_character_beliefs_character_id", table_name="character_beliefs")
    op.drop_index("ix_character_beliefs_project_id", table_name="character_beliefs")
    op.drop_table("character_beliefs")

    op.drop_index("ix_world_facts_superseded_by_id", table_name="world_facts")
    op.drop_index("ix_world_facts_confirmation", table_name="world_facts")
    op.drop_index("ix_world_facts_source_chapter_id", table_name="world_facts")
    op.drop_index("ix_world_facts_source_type", table_name="world_facts")
    op.drop_index("ix_world_facts_status", table_name="world_facts")
    op.drop_index("ix_world_facts_project_id", table_name="world_facts")
    op.drop_table("world_facts")
