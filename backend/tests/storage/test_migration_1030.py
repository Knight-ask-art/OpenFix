"""SQLite compatibility check for the per-agent reasoning migration."""

import importlib

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect


def test_1030_migration_adds_inherit_default_and_drops_on_sqlite() -> None:
    migration = importlib.import_module(
        "app.storage.migrations.versions.1030_add_agent_reasoning_effort"
    )
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE TABLE agent_definitions (id TEXT PRIMARY KEY)"
            )
            migration_context = MigrationContext.configure(connection)
            with Operations.context(migration_context):
                migration.upgrade()

            column = next(
                column
                for column in inspect(connection).get_columns("agent_definitions")
                if column["name"] == "reasoning_effort"
            )
            assert column["nullable"] is False
            assert column["default"].strip("'") == "inherit"

            with Operations.context(migration_context):
                migration.downgrade()
            assert [
                column["name"]
                for column in inspect(connection).get_columns("agent_definitions")
            ] == ["id"]
    finally:
        engine.dispose()
