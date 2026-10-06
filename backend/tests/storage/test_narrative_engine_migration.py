# -*- coding: utf-8 -*-
"""1032 迁移测试：Narrative Engine 四张扩展表的升级与降级。

迁移只新建表，不修改核心表。旧库升级后既有数据必须原样保留，降级必须只删除本次
新增的表，同样不影响旧数据。
"""

import importlib
from pathlib import Path

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

migration = importlib.import_module(
    "app.storage.migrations.versions.1032_create_narrative_engine_tables"
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]

NARRATIVE_TABLES = ("world_facts", "character_beliefs", "plotlines", "scene_plans")

# 四张表共享的溯源与确认列。
PROVENANCE_COLUMNS = (
    "source_type",
    "source_id",
    "source_chapter_id",
    "quote_anchor",
    "created_by",
    "confidence",
    "confirmation",
    "confirmed_at",
    "confirmed_by",
)


def _create_legacy_schema(connection) -> None:
    """升级前就存在的核心表（只保留本迁移会引用到的列）。"""
    connection.execute(
        text("CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
    )
    connection.execute(
        text(
            "CREATE TABLE chapters ("
            "id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL)"
        )
    )
    connection.execute(
        text(
            "CREATE TABLE characters ("
            "id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL)"
        )
    )
    connection.execute(
        text(
            "CREATE TABLE outlines ("
            "id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL)"
        )
    )


def _insert_legacy_rows(connection) -> None:
    connection.execute(
        text("INSERT INTO projects (id, title) VALUES ('proj-1', '旧项目')")
    )
    connection.execute(
        text(
            "INSERT INTO chapters (id, project_id, title) "
            "VALUES ('chap-1', 'proj-1', '旧章节')"
        )
    )
    connection.execute(
        text(
            "INSERT INTO characters (id, project_id, name) "
            "VALUES ('char-1', 'proj-1', '旧人物')"
        )
    )
    connection.execute(
        text(
            "INSERT INTO outlines (id, project_id, title) "
            "VALUES ('outline-1', 'proj-1', '旧大纲')"
        )
    )


def _run(connection, direction: str) -> None:
    migration_context = MigrationContext.configure(connection)
    with Operations.context(migration_context):
        getattr(migration, direction)()


def _legacy_snapshot(connection) -> dict[str, list[tuple]]:
    return {
        table: connection.execute(
            text(f"SELECT * FROM {table} ORDER BY id")
        ).all()
        for table in ("projects", "chapters", "characters", "outlines")
    }


def test_upgrade_creates_tables_and_preserves_existing_rows() -> None:
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _create_legacy_schema(connection)
            _insert_legacy_rows(connection)
            before = _legacy_snapshot(connection)

            _run(connection, "upgrade")

            inspector = inspect(connection)
            tables = set(inspector.get_table_names())
            for table in NARRATIVE_TABLES:
                assert table in tables

            for table in NARRATIVE_TABLES:
                columns = {column["name"] for column in inspector.get_columns(table)}
                for column in PROVENANCE_COLUMNS:
                    assert column in columns, f"{table} 缺少溯源列 {column}"
                assert "project_id" in columns
                assert "created_at" in columns
                assert "updated_at" in columns

            # 新表在升级后必须为空，不能凭空生成叙事数据。
            for table in NARRATIVE_TABLES:
                assert (
                    connection.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar_one()
                    == 0
                )

            # 旧数据原样保留。
            assert _legacy_snapshot(connection) == before
    finally:
        engine.dispose()


def test_upgrade_makes_project_scoped_indexes_available() -> None:
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _create_legacy_schema(connection)
            _run(connection, "upgrade")

            inspector = inspect(connection)
            for table in NARRATIVE_TABLES:
                index_columns = {
                    tuple(index["column_names"])
                    for index in inspector.get_indexes(table)
                }
                assert ("project_id",) in index_columns
                assert ("confirmation",) in index_columns

            scene_unique = inspector.get_unique_constraints("scene_plans")
            assert any(
                set(constraint["column_names"]) == {"chapter_id", "scene_index"}
                for constraint in scene_unique
            )
    finally:
        engine.dispose()


def test_downgrade_drops_only_narrative_tables() -> None:
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _create_legacy_schema(connection)
            _insert_legacy_rows(connection)
            before = _legacy_snapshot(connection)

            _run(connection, "upgrade")
            _run(connection, "downgrade")

            tables = set(inspect(connection).get_table_names())
            for table in NARRATIVE_TABLES:
                assert table not in tables

            assert _legacy_snapshot(connection) == before
    finally:
        engine.dispose()


def test_migration_revision_chain_points_at_1031() -> None:
    assert migration.revision == "1032"
    assert migration.down_revision == "1031"

    config = Config()
    config.set_main_option(
        "script_location", str(BACKEND_ROOT / "app" / "storage" / "migrations")
    )
    script = ScriptDirectory.from_config(config)
    assert script.get_heads() == ["1032"]
