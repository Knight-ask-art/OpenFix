"""SQLite compatibility check for the additive audit-metrics migration."""

import importlib

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect


def test_1029_migration_adds_and_drops_metrics_on_sqlite() -> None:
    migration = importlib.import_module(
        "app.storage.migrations.versions.1029_add_llm_token_efficiency_metrics"
    )
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE TABLE agent_audit_logs (id TEXT PRIMARY KEY)"
            )
            migration_context = MigrationContext.configure(connection)
            with Operations.context(migration_context):
                migration.upgrade()

            columns = {
                column["name"]: column
                for column in inspect(connection).get_columns("agent_audit_logs")
            }
            assert "token_cache_write" in columns
            assert columns["token_cache_write"]["default"].strip("'") == "0"
            assert columns["context_token_breakdown"]["default"] == "'{}'"

            with Operations.context(migration_context):
                migration.downgrade()
            assert [
                column["name"]
                for column in inspect(connection).get_columns("agent_audit_logs")
            ] == ["id"]
    finally:
        engine.dispose()
