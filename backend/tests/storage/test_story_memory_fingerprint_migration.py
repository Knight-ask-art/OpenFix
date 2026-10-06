# -*- coding: utf-8 -*-
"""1026 迁移测试：Story Memory 源快照指纹列与迁移链连续性。

迁移必须向后兼容：旧数据库里的 retrieval_indexes 行在升级后保留，
新增列为可空且默认 NULL（NULL 表示索引早于指纹机制，不能视为最新）。
"""

import importlib
from pathlib import Path
from unittest.mock import patch

from alembic.config import Config
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

migration = importlib.import_module(
    "app.storage.migrations.versions.1026_add_story_memory_source_fingerprint"
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _create_retrieval_index_schema(connection) -> None:
    """升级前的 retrieval_indexes 只有指纹出现之前就存在的列。"""
    connection.execute(
        text(
            "CREATE TABLE retrieval_indexes ("
            "id TEXT PRIMARY KEY, "
            "index_key TEXT NOT NULL, "
            "status TEXT NOT NULL, "
            "last_error TEXT"
            ")"
        )
    )


def test_upgrade_adds_nullable_fingerprint_and_preserves_existing_rows() -> None:
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        _create_retrieval_index_schema(connection)
        connection.execute(
            text(
                "INSERT INTO retrieval_indexes (id, index_key, status, last_error) "
                "VALUES ('row-1', 'story_memory:project-1', 'ready', NULL)"
            )
        )

        operations = Operations(MigrationContext.configure(connection))
        with patch.object(migration, "op", operations):
            migration.upgrade()

        columns = {
            column["name"]: column
            for column in inspect(connection).get_columns("retrieval_indexes")
        }
        assert "source_fingerprint" in columns
        assert columns["source_fingerprint"]["nullable"] is True

        row = (
            connection.execute(
                text(
                    "SELECT index_key, status, source_fingerprint "
                    "FROM retrieval_indexes WHERE id = 'row-1'"
                )
            )
            .mappings()
            .one()
        )
        assert row["index_key"] == "story_memory:project-1"
        assert row["status"] == "ready"
        # 旧索引没有指纹：必须保持 NULL，由新鲜度检查判定为过期。
        assert row["source_fingerprint"] is None

    engine.dispose()


def test_downgrade_drops_fingerprint_column() -> None:
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        _create_retrieval_index_schema(connection)
        operations = Operations(MigrationContext.configure(connection))
        with patch.object(migration, "op", operations):
            migration.upgrade()
            migration.downgrade()

        columns = {
            column["name"]
            for column in inspect(connection).get_columns("retrieval_indexes")
        }
        assert "source_fingerprint" not in columns

    engine.dispose()


def test_migration_chain_is_continuous_with_a_single_head() -> None:
    assert migration.revision == "1026"
    assert migration.down_revision == "1025"
    extension_migration = importlib.import_module(
        "app.storage.migrations.versions.1027_add_revision_extension_snapshots"
    )
    assert extension_migration.revision == "1027"
    assert extension_migration.down_revision == "1026"
    chapter_snapshot_migration = importlib.import_module(
        "app.storage.migrations.versions.1028_add_revision_chapter_snapshot_volume_id"
    )
    assert chapter_snapshot_migration.revision == "1028"
    assert chapter_snapshot_migration.down_revision == "1027"
    token_metrics_migration = importlib.import_module(
        "app.storage.migrations.versions.1029_add_llm_token_efficiency_metrics"
    )
    assert token_metrics_migration.revision == "1029"
    assert token_metrics_migration.down_revision == "1028"
    agent_reasoning_migration = importlib.import_module(
        "app.storage.migrations.versions.1030_add_agent_reasoning_effort"
    )
    assert agent_reasoning_migration.revision == "1030"
    assert agent_reasoning_migration.down_revision == "1029"
    word_count_migration = importlib.import_module(
        "app.storage.migrations.versions.1031_recount_chapter_word_counts"
    )
    assert word_count_migration.revision == "1031"
    assert word_count_migration.down_revision == "1030"
    narrative_migration = importlib.import_module(
        "app.storage.migrations.versions.1032_create_narrative_engine_tables"
    )
    assert narrative_migration.revision == "1032"
    assert narrative_migration.down_revision == "1031"

    config = Config()
    config.set_main_option(
        "script_location", str(BACKEND_ROOT / "app" / "storage" / "migrations")
    )
    script = ScriptDirectory.from_config(config)

    assert script.get_heads() == ["1032"]

    # 从最新迁移沿 down_revision 回溯，每一步都必须能在仓库里找到对应迁移。
    revisions = {revision.revision: revision for revision in script.walk_revisions()}
    current: str | None = "1032"
    visited: list[str] = []
    while current is not None:
        assert current in revisions, f"缺失迁移版本: {current}"
        visited.append(current)
        down = revisions[current].down_revision
        current = down if isinstance(down, str) else None
    assert visited[0] == "1032"
    assert visited[-1] == "1001"
