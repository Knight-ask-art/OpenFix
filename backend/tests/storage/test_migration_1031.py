# -*- coding: utf-8 -*-
"""1031 迁移测试：按正文重算章节字数与项目聚合字数。

迁移只能改缓存的字数统计：正文、章节状态、时间戳和写作活动记录必须原样保留，
不得发起模型调用。迁移内的计数口径是冻结副本，必须与共享 fixture
（fixtures/word-count-cases.json）以及运行时 app.core.word_count 完全一致。
"""

import importlib
import json
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection

from app.core.word_count import count_words

migration = importlib.import_module(
    "app.storage.migrations.versions.1031_recount_chapter_word_counts"
)

FIXTURE_PATH = Path(__file__).resolve().parents[3] / "fixtures" / "word-count-cases.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
CASES = FIXTURE["cases"]


def _case_text(case: dict) -> str:
    """用例正文：给出 text，或给出 codePoints（控制字符、组合音标、emoji 等）。"""
    if "codePoints" in case:
        return "".join(chr(code_point) for code_point in case["codePoints"])
    return case["text"]


def _create_schema(connection: Connection) -> None:
    """升级前的相关表：计数读写的列，加上必须保持不变的列。"""
    connection.execute(
        text(
            "CREATE TABLE projects ("
            "id TEXT PRIMARY KEY, "
            "word_count INTEGER NOT NULL, "
            "chapter_count INTEGER NOT NULL, "
            "updated_at TEXT NOT NULL)"
        )
    )
    connection.execute(
        text(
            "CREATE TABLE chapters ("
            "id TEXT PRIMARY KEY, "
            "project_id TEXT NOT NULL, "
            "title TEXT NOT NULL, "
            "content TEXT NOT NULL, "
            "word_count INTEGER NOT NULL, "
            "updated_at TEXT NOT NULL)"
        )
    )
    connection.execute(
        text(
            "CREATE TABLE chapter_meta ("
            "chapter_id TEXT PRIMARY KEY, status TEXT NOT NULL)"
        )
    )
    connection.execute(
        text(
            "CREATE TABLE writing_activity_events ("
            "id TEXT PRIMARY KEY, "
            "chapter_id TEXT NOT NULL, "
            "old_word_count INTEGER NOT NULL, "
            "new_word_count INTEGER NOT NULL)"
        )
    )


def _insert_chapter(
    connection: Connection,
    *,
    chapter_id: str,
    project_id: str,
    content: str,
    word_count: int,
    title: str = "章节",
    updated_at: str = "2026-01-01 10:00:00",
) -> None:
    connection.execute(
        text(
            "INSERT INTO chapters "
            "(id, project_id, title, content, word_count, updated_at) "
            "VALUES (:chapter_id, :project_id, :title, :content, :word_count, :updated_at)"
        ),
        {
            "chapter_id": chapter_id,
            "project_id": project_id,
            "title": title,
            "content": content,
            "word_count": word_count,
            "updated_at": updated_at,
        },
    )


def _run_upgrade(connection: Connection) -> None:
    migration_context = MigrationContext.configure(connection)
    with Operations.context(migration_context):
        migration.upgrade()


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_frozen_counter_matches_shared_fixture(case: dict) -> None:
    text_value = _case_text(case)

    assert migration._count_words(text_value) == case["words"]
    assert migration._count_words(text_value) == count_words(text_value)


def test_frozen_cjk_ranges_match_shared_fixture() -> None:
    assert [
        [start, end] for start, end in migration._FROZEN_CJK_RANGES
    ] == FIXTURE["cjkRanges"]


def test_upgrade_recounts_chapters_and_project_total_only() -> None:
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _create_schema(connection)
            connection.execute(
                text(
                    "INSERT INTO projects (id, word_count, chapter_count, updated_at) "
                    "VALUES ('proj-1', 999, 3, '2025-12-31 09:00:00')"
                )
            )
            # 没有章节的项目必须落到 0，而不是 NULL。
            connection.execute(
                text(
                    "INSERT INTO projects (id, word_count, chapter_count, updated_at) "
                    "VALUES ('proj-2', 12, 0, '2025-12-31 09:00:00')"
                )
            )
            _insert_chapter(
                connection,
                chapter_id="chap-1",
                project_id="proj-1",
                title="第一章",
                content="Hello, world! 你好。",
                word_count=7,
            )
            _insert_chapter(
                connection,
                chapter_id="chap-2",
                project_id="proj-1",
                content="don't",
                word_count=1,
                updated_at="2026-01-02 11:00:00",
            )
            _insert_chapter(
                connection,
                chapter_id="chap-3",
                project_id="proj-1",
                content="abc123",
                word_count=1,
                updated_at="2026-01-03 12:00:00",
            )
            _insert_chapter(
                connection,
                chapter_id="chap-4",
                project_id="proj-1",
                content="",
                word_count=3,
                updated_at="2026-01-04 13:00:00",
            )
            connection.execute(
                text(
                    "INSERT INTO chapter_meta (chapter_id, status) "
                    "VALUES ('chap-1', 'writing')"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO writing_activity_events "
                    "(id, chapter_id, old_word_count, new_word_count) "
                    "VALUES ('event-1', 'chap-1', 0, 7)"
                )
            )

            _run_upgrade(connection)

            chapters = {
                row["id"]: row
                for row in connection.execute(
                    text(
                        "SELECT id, title, content, word_count, updated_at FROM chapters"
                    )
                )
                .mappings()
                .all()
            }
            projects = {
                row["id"]: row
                for row in connection.execute(
                    text("SELECT id, word_count, chapter_count, updated_at FROM projects")
                )
                .mappings()
                .all()
            }
            meta = connection.execute(
                text("SELECT status FROM chapter_meta WHERE chapter_id = 'chap-1'")
            ).scalar_one()
            events = connection.execute(
                text(
                    "SELECT chapter_id, old_word_count, new_word_count "
                    "FROM writing_activity_events"
                )
            ).mappings().all()

        assert chapters["chap-1"]["word_count"] == 4
        assert chapters["chap-2"]["word_count"] == 2
        assert chapters["chap-3"]["word_count"] == 1
        assert chapters["chap-4"]["word_count"] == 0
        # 正文、标题和时间戳都不是统计值，必须原样保留。
        assert chapters["chap-1"]["content"] == "Hello, world! 你好。"
        assert chapters["chap-1"]["title"] == "第一章"
        assert chapters["chap-1"]["updated_at"] == "2026-01-01 10:00:00"
        assert chapters["chap-2"]["updated_at"] == "2026-01-02 11:00:00"
        # 项目聚合等于重算后的章节之和；无章节的项目归零。
        assert projects["proj-1"]["word_count"] == 7
        assert projects["proj-2"]["word_count"] == 0
        assert projects["proj-1"]["chapter_count"] == 3
        assert projects["proj-1"]["updated_at"] == "2025-12-31 09:00:00"
        assert meta == "writing"
        assert [
            (row["chapter_id"], row["old_word_count"], row["new_word_count"])
            for row in events
        ] == [("chap-1", 0, 7)]
    finally:
        engine.dispose()


def test_upgrade_paginates_and_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(migration, "_BATCH_SIZE", 1)
    engine = create_engine("sqlite:///:memory:")
    try:
        with engine.begin() as connection:
            _create_schema(connection)
            connection.execute(
                text(
                    "INSERT INTO projects (id, word_count, chapter_count, updated_at) "
                    "VALUES ('proj-1', 0, 3, '2025-12-31 09:00:00')"
                )
            )
            for index in range(1, 4):
                _insert_chapter(
                    connection,
                    chapter_id=f"chap-{index}",
                    project_id="proj-1",
                    content="Hello, world! 你好。",
                    word_count=7,
                )

            _run_upgrade(connection)
            first_pass = connection.execute(
                text("SELECT id, word_count FROM chapters ORDER BY id")
            ).all()
            _run_upgrade(connection)
            second_pass = connection.execute(
                text("SELECT id, word_count FROM chapters ORDER BY id")
            ).all()
            project_total = connection.execute(
                text("SELECT word_count FROM projects WHERE id = 'proj-1'")
            ).scalar_one()

        assert first_pass == [("chap-1", 4), ("chap-2", 4), ("chap-3", 4)]
        assert second_pass == first_pass
        assert project_total == 12
    finally:
        engine.dispose()
