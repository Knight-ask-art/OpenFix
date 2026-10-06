"""Markdown 导出的真实 API、任务写入和下载接缝；只使用合成 SQLite 数据。"""

from dataclasses import dataclass
from datetime import UTC, datetime
import json
from pathlib import Path
from urllib.parse import unquote

from httpx import AsyncClient
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.background.events.publisher import BackgroundEventPublisher
from app.background.jobs import service as background_service
from app.background.jobs.definitions.chapter_export import ChapterExportInput
from app.background.runtime.context import JobCancelledError, JobContext
from app.background.runtime.dispatcher import dispatch_job
from app.chapter_export import service as export_service
from app.storage.repos import chapter_repo


LOCAL_DATE = "2026-10-03"
FIRST_BODY = (
    "MD-A **粗体**\r\n\r\n[链接](https://example.invalid/a)\r"
    "> 引用\r\n行末  \r\n下一行"
)
LAST_BODY = "# Body stays\n\n```text\nMD-C 中文 sentinel\n```\n\n尾段"
FIRST_HEADING = "甲 \\*醒来\\* \\# 后续"
LAST_HEADING = "丙 \\`夜色\\` \\&amp\\; \\<tag\\>"
FIRST_VOLUME_HEADING = "第一卷 晨光 \\& \\<黎明\\> \\# 一"


# 字数由服务端按正文重算，客户端字数不再入库：下面两个常量是合成正文的真实字数。
FIRST_BODY_WORDS = 17
LAST_BODY_WORDS = 10


@dataclass(frozen=True)
class SyntheticBook:
    project_id: str
    first_volume: str
    last_volume: str
    chapter_ids: list[str]


@pytest.fixture
def markdown_storage(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(export_service.settings, "chapter_exports_dir", tmp_path)

    async def check_test_cancellation(context: JobContext) -> None:
        # JobContext 的独立生产 session 在这里改用同一内存事务；保留真实任务状态检查。
        job = await background_service.get_job(context.session, context.job_id)
        assert job is not None
        if job.status == "cancel_requested" or job.cancel_requested_at:
            raise JobCancelledError(job.cancel_reason or "合成测试取消")

    monkeypatch.setattr(JobContext, "check_cancelled", check_test_cancellation)
    return tmp_path


async def _create_project(client: AsyncClient) -> tuple[str, str]:
    created = await client.post("/api/v1/projects", data={"title": "Markdown 小说"})
    assert created.status_code == 201
    project_id = created.json()["id"]
    volumes = await client.get(f"/api/v1/projects/{project_id}/volumes")
    assert volumes.status_code == 200
    return project_id, volumes.json()[0]["id"]


async def _create_volume(client: AsyncClient, project_id: str, title: str) -> str:
    created = await client.post(f"/api/v1/projects/{project_id}/volumes", json={"title": title})
    assert created.status_code == 201
    return created.json()["id"]


async def _create_chapter(
    client: AsyncClient, project_id: str, volume_id: str, title: str, body: str,
) -> str:
    """创建章节。字数由服务端按正文重算，这里不传客户端字数。"""
    created = await client.post(
        f"/api/v1/projects/{project_id}/chapters",
        json={"volume_id": volume_id, "title": title, "content": body},
    )
    assert created.status_code == 201
    return created.json()["id"]


async def _create_book(client: AsyncClient) -> SyntheticBook:
    project_id, first_volume = await _create_project(client)
    renamed = await client.patch(
        f"/api/v1/volumes/{first_volume}", json={"title": "晨光 & <黎明>\r\n# 一"},
    )
    assert renamed.status_code == 200
    last_volume = await _create_volume(client, project_id, "暮色")
    await _create_volume(client, project_id, "空卷")
    ids = [
        await _create_chapter(client, project_id, first_volume, "甲 *醒来*\r\n# 后续", FIRST_BODY),
        await _create_chapter(client, project_id, first_volume, "乙 空章", ""),
        await _create_chapter(client, project_id, last_volume, "丙 `夜色` &amp; <tag>", LAST_BODY),
    ]
    return SyntheticBook(project_id, first_volume, last_volume, ids)


async def _create_export(
    client: AsyncClient, project_id: str, *, volumes: list[str],
    included: list[str] | None = None, excluded: list[str] | None = None,
) -> dict:
    created = await client.post(
        f"/api/v1/projects/{project_id}/chapter-exports",
        json={
            "selected_volume_ids": volumes,
            "included_chapter_ids": included or [],
            "excluded_chapter_ids": excluded or [],
            "local_date": LOCAL_DATE,
            "format": "markdown",
        },
    )
    assert created.status_code == 201
    assert created.json()["format"] == "markdown"
    assert created.json()["status"] == "pending"
    return created.json()


async def _running_context(session: AsyncSession, job_id: str) -> JobContext:
    job = await background_service.get_job(session, job_id)
    assert job is not None
    job.status = "running"
    await session.commit()
    return JobContext(session=session, job=job, publisher=BackgroundEventPublisher(None))


async def _complete_export(session: AsyncSession, job_id: str) -> tuple[JobContext, dict]:
    context = await _running_context(session, job_id)
    result = await dispatch_job(context)
    assert result is not None
    assert isinstance(context.typed_payload, ChapterExportInput)
    assert context.typed_payload.format == "markdown"
    await background_service.mark_succeeded(session, context.publisher, context.job, result=result)
    await session.commit()
    return context, result


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["full-book", "current-volume", "fragments"])
async def test_markdown_scope_reaches_dispatch_cleanup_status_and_download(
    client: AsyncClient, session: AsyncSession, markdown_storage: Path,
    monkeypatch: pytest.MonkeyPatch, scope: str,
) -> None:
    book = await _create_book(client)
    normalized_first_body = FIRST_BODY.replace("\r\n", "\n").replace("\r", "\n")
    first = f"## {FIRST_HEADING}\n\n{normalized_first_body}"
    last = f"## {LAST_HEADING}\n\n{LAST_BODY}"
    if scope == "full-book":
        selected_volumes = [book.last_volume, book.first_volume]
        included, excluded = [], []
        expected_ids = book.chapter_ids
        expected_mode, words, label = "volumes", FIRST_BODY_WORDS + LAST_BODY_WORDS, "全本"
        expected_text = (
            f"# {FIRST_VOLUME_HEADING}\n\n{first}\n\n## 乙 空章\n\n"
            f"\n\n# 第二卷 暮色\n\n{last}"
        )
    elif scope == "current-volume":
        selected_volumes = [book.last_volume]
        included, excluded = [], []
        expected_ids = [book.chapter_ids[2]]
        expected_mode, words, label = "volumes", LAST_BODY_WORDS, "暮色"
        expected_text = f"# 第二卷 暮色\n\n{last}"
    else:
        selected_volumes = [book.first_volume]
        included, excluded = [book.chapter_ids[2]], [book.chapter_ids[1]]
        expected_ids = [book.chapter_ids[0], book.chapter_ids[2]]
        expected_mode, words, label = "chapters", FIRST_BODY_WORDS + LAST_BODY_WORDS, "2个章节"
        expected_text = (
            f"# {FIRST_HEADING}\n\n{normalized_first_body}\n\n"
            f"# {LAST_HEADING}\n\n{LAST_BODY}"
        )

    async def reject_body_list(*_args, **_kwargs):
        raise AssertionError("导出规划只应读取 metadata")

    monkeypatch.setattr(chapter_repo, "list_by_project", reject_body_list)
    created = await _create_export(
        client, book.project_id, volumes=selected_volumes, included=included, excluded=excluded,
    )
    filename = f"Markdown 小说-{label}-{LOCAL_DATE}.md"
    assert created["filename"] == filename
    assert created["mode"] == expected_mode
    assert created["chapter_ids"] == expected_ids
    assert created["chapter_count"] == len(expected_ids)
    assert created["word_count"] == words
    job = await background_service.get_job(session, created["id"])
    assert job is not None
    payload = background_service.parse_json_object(job.payload_json)
    assert payload["format"] == "markdown"
    assert all("content" not in chapter for chapter in payload["chapters"])
    # 计划固定标题，dispatch 仍只分批取当前正文；后续 metadata 改名不重算范围。
    changed = await client.patch(f"/api/v1/chapters/{book.chapter_ids[2]}", json={"title": "后改标题"})
    assert changed.status_code == 200
    before = datetime.now(UTC)
    context, result = await _complete_export(session, job.id)
    after = datetime.now(UTC)
    expires_at = datetime.fromisoformat(result["expires_at"])
    assert before + export_service.EXPORT_FILE_TTL <= expires_at <= after + export_service.EXPORT_FILE_TTL
    assert result["filename"] == filename
    assert result["chapter_count"] == len(expected_ids)
    assert result["volume_count"] == (1 if scope == "current-volume" else 2)
    assert result["word_count"] == words
    assert context.input["format"] == "markdown"
    assert await export_service.cleanup_chapter_export_files(session) == 0
    part, output = export_service.export_file_paths(job.id, "markdown")
    assert not part.exists()
    assert output.name == f"chapter-export-{job.id}.md"
    assert output.read_bytes() == expected_text.encode("utf-8")
    assert not output.read_bytes().startswith(b"\xef\xbb\xbf")
    assert b"\r" not in output.read_bytes()
    status = await client.get(f"/api/v1/projects/{book.project_id}/chapter-exports/{job.id}")
    assert status.status_code == 200
    data = status.json()
    assert data["status"] == "succeeded"
    assert data["format"] == "markdown"
    assert data["filename"] == filename
    assert data["chapter_ids"] == expected_ids
    assert data["current"] == data["total"] == len(expected_ids)
    assert data["download_url"] == f"/api/v1/projects/{book.project_id}/chapter-exports/{job.id}/download"
    downloaded = await client.get(data["download_url"])
    assert downloaded.status_code == 200
    assert downloaded.headers["content-type"] == "text/markdown; charset=utf-8"
    assert filename in unquote(downloaded.headers["content-disposition"])
    assert downloaded.content == expected_text.encode("utf-8")
    assert "空卷" not in downloaded.text


@pytest.mark.asyncio
async def test_selected_empty_markdown_chapter_retains_its_heading(
    client: AsyncClient, session: AsyncSession, markdown_storage: Path,
) -> None:
    book = await _create_book(client)
    created = await _create_export(client, book.project_id, volumes=[], included=[book.chapter_ids[1]])
    await _complete_export(session, created["id"])
    downloaded = await client.get(
        f"/api/v1/projects/{book.project_id}/chapter-exports/{created['id']}/download",
    )
    assert downloaded.status_code == 200
    assert downloaded.content == "# 乙 空章\n\n".encode("utf-8")
    assert created["filename"] == f"Markdown 小说-1个章节-{LOCAL_DATE}.md"


@pytest.mark.asyncio
async def test_markdown_batches_keep_fixed_order_and_report_progress_across_volumes(
    client: AsyncClient, session: AsyncSession, markdown_storage: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_id, first_volume = await _create_project(client)
    second_volume = await _create_volume(client, project_id, "第二卷")
    ids: list[str] = []
    for index in range(23):
        ids.append(await _create_chapter(
            client, project_id, first_volume if index < 13 else second_volume,
            f"章 {index:02d}", f"BODY-{index:02d}\n\n**正文保留**",
        ))
    original_load = chapter_repo.get_by_ids
    original_progress = background_service.update_progress
    batches: list[list[str]] = []
    progress: list[tuple[int, int]] = []

    async def record_load(db, batch_ids):
        batches.append(list(batch_ids))
        return list(reversed(await original_load(db, batch_ids)))

    async def record_progress(*args, **kwargs):
        progress.append((kwargs["current"], kwargs["total"]))
        return await original_progress(*args, **kwargs)

    monkeypatch.setattr(chapter_repo, "get_by_ids", record_load)
    monkeypatch.setattr(background_service, "update_progress", record_progress)
    created = await _create_export(client, project_id, volumes=[second_volume, first_volume])
    assert batches == []
    assert created["chapter_ids"] == ids
    await _complete_export(session, created["id"])
    assert batches == [ids[:20], ids[20:]]
    assert progress == [(20, 23), (23, 23)]
    downloaded = await client.get(f"/api/v1/projects/{project_id}/chapter-exports/{created['id']}/download")
    assert downloaded.status_code == 200
    first_text = "\n\n".join(f"## 章 {i:02d}\n\nBODY-{i:02d}\n\n**正文保留**" for i in range(13))
    second_text = "\n\n".join(f"## 章 {i:02d}\n\nBODY-{i:02d}\n\n**正文保留**" for i in range(13, 23))
    assert downloaded.text == f"# 第一卷 第一卷\n\n{first_text}\n\n# 第二卷 第二卷\n\n{second_text}"
    assert await export_service.cleanup_chapter_export_files(session) == 0
    assert not export_service.export_file_paths(created["id"], "markdown")[0].exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("stop", ["cancel", "deleted-chapter"])
async def test_markdown_second_batch_cancellation_and_failure_remove_partial_output(
    client: AsyncClient, session: AsyncSession, markdown_storage: Path,
    monkeypatch: pytest.MonkeyPatch, stop: str,
) -> None:
    project_id, volume_id = await _create_project(client)
    ids = [await _create_chapter(client, project_id, volume_id, f"章 {i}", f"BODY-{i}") for i in range(21)]
    created = await _create_export(client, project_id, volumes=[volume_id])
    part, output = export_service.export_file_paths(created["id"], "markdown")
    original_load = chapter_repo.get_by_ids
    original_progress = background_service.update_progress
    batches: list[list[str]] = []
    checkpoints: list[int] = []

    async def record_load(db, batch_ids):
        batches.append(list(batch_ids))
        if len(batches) == 2:
            assert part.exists()
        return await original_load(db, batch_ids)

    async def stop_after_first_batch(*args, **kwargs):
        job = await original_progress(*args, **kwargs)
        checkpoints.append(kwargs["current"])
        assert part.exists()
        if stop == "cancel":
            job.status = "cancel_requested"
        return job

    monkeypatch.setattr(chapter_repo, "get_by_ids", record_load)
    monkeypatch.setattr(background_service, "update_progress", stop_after_first_batch)
    if stop == "deleted-chapter":
        deleted = await client.delete(f"/api/v1/chapters/{ids[-1]}")
        assert deleted.status_code == 204
    context = await _running_context(session, created["id"])
    expected_error = JobCancelledError if stop == "cancel" else RuntimeError
    with pytest.raises(expected_error):
        await dispatch_job(context)
    assert checkpoints == [20]
    assert batches == ([ids[:20]] if stop == "cancel" else [ids[:20], ids[20:]])
    assert not part.exists()
    assert not output.exists()
    if stop == "cancel":
        await background_service.mark_cancelled(session, context.publisher, context.job, reason="合成测试取消")
    else:
        await background_service.mark_failed(session, context.publisher, context.job, error_message="合成章节缺失")
    await session.commit()
    status = await client.get(f"/api/v1/projects/{project_id}/chapter-exports/{created['id']}")
    assert status.json()["status"] == ("cancelled" if stop == "cancel" else "failed")
    assert status.json()["format"] == "markdown"
    assert status.json()["download_url"] is None
    assert await export_service.cleanup_chapter_export_files(session) == 0
    assert list(markdown_storage.iterdir()) == []


@pytest.mark.asyncio
async def test_markdown_download_enforces_project_identity_and_expiry(
    client: AsyncClient, session: AsyncSession, markdown_storage: Path,
) -> None:
    book = await _create_book(client)
    created = await _create_export(client, book.project_id, volumes=[book.last_volume])
    context, result = await _complete_export(session, created["id"])
    other_project, _other_volume = await _create_project(client)
    wrong_project = await client.get(
        f"/api/v1/projects/{other_project}/chapter-exports/{created['id']}/download",
    )
    assert wrong_project.status_code == 404
    result["expires_at"] = "2000-01-01T00:00:00+00:00"
    context.job.result_json = json.dumps(result)
    await session.commit()
    expired = await client.get(f"/api/v1/projects/{book.project_id}/chapter-exports/{created['id']}/download")
    assert expired.status_code == 409
    status = await client.get(f"/api/v1/projects/{book.project_id}/chapter-exports/{created['id']}")
    assert status.json()["format"] == "markdown"
    assert status.json()["download_url"] is None
    assert await export_service.cleanup_chapter_export_files(session) == 1
    assert list(markdown_storage.iterdir()) == []
