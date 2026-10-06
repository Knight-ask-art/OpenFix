# -*- coding: utf-8 -*-
"""回归测试：story memory rebuild 不得在嵌入/原生索引期间持有 SQLite 写事务。

审计结论（backend/.venv/novel-acceptance/claude-index-lock-audit.txt）：rebuild
通过 on_status_change 写入 building 状态后只 flush 不 commit，SQLite 写事务被
持有到嵌入 HTTP 请求和 LanceDB 重建结束，其他写入方（heartbeat、审计队列、
agent session）会拿到 database is locked。

这里使用真实临时 SQLite 文件库 + 两个独立 engine/session 复现竞争：嵌入被
阻塞期间，第二个 session 必须仍能完成读取和写入。mock session 无法覆盖该缺陷。
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    create_async_engine,
)
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel

from app.retrieval.internal.common.naming import make_table_name
from app.retrieval.internal.contracts.index_contracts import build_index_create_kwargs
from app.retrieval.service import OpenFicRetrievalService
from app.retrieval.types import (
    FilterableField,
    FilterableFieldType,
    IndexDocument,
    RetrievalIndexContract,
)
from app.storage.models.retrieval_index import RetrievalIndex
from app.storage.models.setting import Setting
from app.storage.repos import retrieval_index_repo
from tests.model_registry import register_sqlmodel_models

INDEX_KEY = "story_memory:project-1"
EMBEDDING_MODEL_ID = "test-embedding"
EMBEDDING_DIMENSIONS = 3

# 真实库默认 busy_timeout 为 30s。这里压到毫秒级：修复后嵌入期间没有任何写锁，
# 第二个 session 无需等待；未修复时会快速失败而不是把测试拖成超时。
BUSY_TIMEOUT_MS = 200


@dataclass
class _FakeEmbeddingConfig:
    model_id: str
    dimensions: int | None


@dataclass
class _FakeEmbeddingResponse:
    embeddings: list[list[float]]
    model: str
    usage: None = None


class _BlockingEmbeddingClient:
    """嵌入请求挂起直到测试放行，用于把 rebuild 停在网络请求中间。"""

    def __init__(self, *, fail_on_release: bool = False) -> None:
        self.config = _FakeEmbeddingConfig(
            model_id=EMBEDDING_MODEL_ID,
            dimensions=EMBEDDING_DIMENSIONS,
        )
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.fail_on_release = fail_on_release

    async def embed(self, texts: list[str]) -> _FakeEmbeddingResponse:
        self.started.set()
        await self.release.wait()
        if self.fail_on_release:
            raise RuntimeError("embedding failed")
        return _FakeEmbeddingResponse(
            embeddings=[[float(index), 1.0, 0.0] for index, _ in enumerate(texts)],
            model=self.config.model_id,
        )

    async def embed_single(self, text: str) -> list[float]:
        return [float(len(text)), 1.0, 0.0]


@dataclass
class _RebuildDb:
    base_dir: Path
    rebuild_session: AsyncSession
    contender_session: AsyncSession


def _create_file_engine(db_path: Path) -> AsyncEngine:
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{db_path.as_posix()}",
        future=True,
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _set_pragmas(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        cursor.close()

    return engine


def _make_contract() -> RetrievalIndexContract:
    return RetrievalIndexContract(
        embedding_model_ref_id="model-1",
        embedding_model_id_snapshot=EMBEDDING_MODEL_ID,
        embedding_dimensions_snapshot=EMBEDDING_DIMENSIONS,
        distance_metric="cosine",
        chunker_type="recursive_character",
        chunk_size=64,
        chunk_overlap=8,
        filterable_fields=[
            FilterableField(name="project_id", field_type=FilterableFieldType.STRING),
            FilterableField(
                name="chapter_order", field_type=FilterableFieldType.INTEGER
            ),
        ],
        vector_index_type="ivf_hnsw_sq",
        vector_index_params={"m": 8, "ef_construction": 64},
        fts_index_params={"language": "English", "stem": True},
        schema_version=1,
    )


def _make_document() -> IndexDocument:
    return IndexDocument(
        document_id="character:1",
        text="人物：测试角色，来自北方王国。",
        attributes={"project_id": "project-1", "chapter_order": 1},
    )


async def _seed_index(session: AsyncSession) -> None:
    await retrieval_index_repo.create(
        session,
        **build_index_create_kwargs(
            index_key=INDEX_KEY,
            table_name=make_table_name(INDEX_KEY),
            contract=_make_contract(),
        ),
    )
    await session.commit()


async def _assert_second_session_can_write(session: AsyncSession) -> None:
    """嵌入挂起期间，第二个独立 session 必须能完成一次写入并提交。"""
    session.add(Setting(key=f"rebuild-probe-{uuid4().hex}", value="1"))
    try:
        await session.commit()
    except OperationalError as exc:  # pragma: no cover - 未修复时走到这里
        await session.rollback()
        pytest.fail(
            "second session blocked while rebuild held the SQLite write lock: "
            f"{exc}"
        )


async def _assert_second_session_sees(session: AsyncSession, status: str) -> None:
    await session.rollback()
    result = await session.execute(
        select(RetrievalIndex).where(RetrievalIndex.index_key == INDEX_KEY)
    )
    assert result.scalar_one().status == status


@pytest_asyncio.fixture
async def rebuild_db(tmp_path: Path) -> AsyncGenerator[_RebuildDb, None]:
    register_sqlmodel_models()
    db_path = tmp_path / "retrieval.sqlite"

    setup_engine = _create_file_engine(db_path)
    async with setup_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    await setup_engine.dispose()

    rebuild_engine = _create_file_engine(db_path)
    contender_engine = _create_file_engine(db_path)
    rebuild_session = sessionmaker(
        rebuild_engine, class_=AsyncSession, expire_on_commit=False
    )()
    contender_session = sessionmaker(
        contender_engine, class_=AsyncSession, expire_on_commit=False
    )()
    try:
        yield _RebuildDb(
            base_dir=tmp_path / "lancedb",
            rebuild_session=rebuild_session,
            contender_session=contender_session,
        )
    finally:
        await rebuild_session.close()
        await contender_session.close()
        await rebuild_engine.dispose()
        await contender_engine.dispose()


async def _run_rebuild_while_blocked(
    rebuild_db: _RebuildDb,
    embedding_client: _BlockingEmbeddingClient,
):
    """启动 rebuild，等待嵌入挂起，返回 (task, 嵌入开始前的 commit 次数)。"""
    service = OpenFicRetrievalService(base_dir=rebuild_db.base_dir)
    task = asyncio.create_task(
        service.rebuild(
            rebuild_db.rebuild_session,
            INDEX_KEY,
            [_make_document()],
            embedding_client,
        )
    )
    try:
        await asyncio.wait_for(embedding_client.started.wait(), timeout=30)
    except BaseException:
        embedding_client.release.set()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        raise
    return task


async def _finish_rebuild(task, embedding_client: _BlockingEmbeddingClient):
    embedding_client.release.set()
    try:
        return await asyncio.wait_for(task, timeout=60)
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


@pytest.mark.asyncio
async def test_rebuild_releases_sqlite_write_lock_before_embedding(
    rebuild_db: _RebuildDb,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """嵌入挂起时，第二个 session 可以读取已提交的 building 状态并写入。"""
    await _seed_index(rebuild_db.rebuild_session)

    commit_count = 0
    original_commit = rebuild_db.rebuild_session.commit

    async def counting_commit() -> None:
        nonlocal commit_count
        commit_count += 1
        await original_commit()

    monkeypatch.setattr(rebuild_db.rebuild_session, "commit", counting_commit)

    embedding_client = _BlockingEmbeddingClient()
    task = await _run_rebuild_while_blocked(rebuild_db, embedding_client)

    await _assert_second_session_can_write(rebuild_db.contender_session)
    await _assert_second_session_sees(rebuild_db.contender_session, "building")
    assert commit_count >= 1, "building 状态必须在嵌入请求前提交"

    result = await _finish_rebuild(task, embedding_client)

    assert result.succeeded_count == 1
    assert result.failed_count == 0

    # 终态仍属于调用方事务：rebuild 返回时第二个 session 还只能看到 building。
    await _assert_second_session_sees(rebuild_db.contender_session, "building")

    # 模拟 background handler 的最终提交（story_memory_index.py）。
    await rebuild_db.rebuild_session.commit()
    await _assert_second_session_sees(rebuild_db.contender_session, "ready")


@pytest.mark.asyncio
async def test_rebuild_failure_does_not_hold_sqlite_write_lock(
    rebuild_db: _RebuildDb,
) -> None:
    """嵌入失败时同样不得持有写锁，failed 终态仍由调用方提交。"""
    await _seed_index(rebuild_db.rebuild_session)

    embedding_client = _BlockingEmbeddingClient(fail_on_release=True)
    task = await _run_rebuild_while_blocked(rebuild_db, embedding_client)

    await _assert_second_session_can_write(rebuild_db.contender_session)
    await _assert_second_session_sees(rebuild_db.contender_session, "building")

    result = await _finish_rebuild(task, embedding_client)

    assert result.failed_count == 1

    await _assert_second_session_sees(rebuild_db.contender_session, "building")

    await rebuild_db.rebuild_session.commit()
    await _assert_second_session_sees(rebuild_db.contender_session, "failed")
