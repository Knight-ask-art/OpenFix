import json

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel

from app.agent_runtime.persistence.model import AgentAttachment
from app.agent_runtime.persistence import repo as message_repo
from app.storage.models.chapter import Chapter
from app.storage.models.character import Character
from app.storage.models.note import Note, NoteCategory
from app.storage.models.project import Project
from app.storage.models.revision_chapter_snapshot import RevisionChapterSnapshot
from app.storage.models.task import Task
from app.storage.models.volume import Volume
from app.storage.models.world_info import WorldInfo
from app.storage.models.world_info_entry import WorldInfoEntry
from tests.model_registry import register_sqlmodel_models


@pytest_asyncio.fixture
async def revision_db(monkeypatch):
    register_sqlmodel_models()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    async with factory() as session:
        session.add(Project(id="proj-1", title="测试项目"))
        session.add(
            Volume(
                id="vol-1",
                project_id="proj-1",
                title="第一卷",
                order=1,
                chapter_count=2,
            )
        )
        session.add(
            Chapter(
                id="chap-1",
                project_id="proj-1",
                volume_id="vol-1",
                title="第一章",
                content="旧内容一",
                word_count=4,
                order=1,
            )
        )
        session.add(
            Chapter(
                id="chap-2",
                project_id="proj-1",
                volume_id="vol-1",
                title="第二章",
                content="旧内容二",
                word_count=4,
                order=2,
            )
        )
        session.add(
            Task(
                id="task-1",
                project_id="proj-1",
                title="Agent Session",
                mode="agent",
                agent_session_id="sess-1",
            )
        )
        session.add(
            WorldInfo(
                id="world-1",
                project_id="proj-1",
                name="测试世界书",
            )
        )
        session.add(
            WorldInfoEntry(
                id="entry-1",
                world_info_id="world-1",
                uid=1,
                name="已有条目",
                order=1,
                content="原始设定",
                token_count=4,
                is_enabled=True,
            )
        )
        session.add(
            Character(
                id="char-1",
                project_id="proj-1",
                name="已有角色",
                description="原始角色描述",
                is_favorited=False,
            )
        )
        session.add(
            NoteCategory(
                id="cat-1",
                project_id="proj-1",
                title="设定",
            )
        )
        session.add(
            Note(
                id="note-1",
                project_id="proj-1",
                category_id="cat-1",
                title="已有笔记",
                content="原始内容",
            )
        )
        await session.commit()

    async def create_test_session():
        return factory()

    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.chapter.write_chapter.create_session",
        create_test_session,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.chapter.delete_chapter.create_session",
        create_test_session,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.note.write_note.create_session",
        create_test_session,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.note.edit_note.create_session",
        create_test_session,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.note.delete_note.create_session",
        create_test_session,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.note.move_note.create_session",
        create_test_session,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.note.create_note_category.create_session",
        create_test_session,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.context.world_entry.create_session",
        create_test_session,
    )
    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.context.character.create_session",
        create_test_session,
    )

    yield factory
    await engine.dispose()


@pytest.mark.asyncio
async def test_write_chapter_records_current_revision_and_structured_result(revision_db):
    from app.agent_runtime.revisions import begin_user_revision
    from app.agent_runtime.tools.impls.chapter.write_chapter import WriteChapterTool
    from app.storage.repos import commit_repo, revision_chapter_snapshot_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="插入一个章节",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 插入一个章节",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = WriteChapterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = await tool.ainvoke(
        {
            "volume_ref": {"type": "order", "value": 1},
            "title": "插入章",
            "content": "新内容",
            "chapter_ref": {"type": "order", "value": 2},
        }
    )

    payload = json.loads(result)
    chapter_diff = payload["metadata"]["chapter_diff"]
    assert payload["success"] is True
    assert payload["word_count"] == 3
    assert chapter_diff["chapter_title"] == "插入章"
    assert chapter_diff["order"] == 2

    async with revision_db() as session:
        chapters = await session.execute(
            Chapter.__table__.select().where(Chapter.project_id == "proj-1")
        )
        rows = chapters.mappings().all()
        inserted_row = next(row for row in rows if row["title"] == "插入章")
        commits = await commit_repo.list_by_revision(session, revision.id)
        snapshots = await revision_chapter_snapshot_repo.list_by_revision(
            session, revision.id
        )
    inserted_id = chapter_diff["chapter_id"]
    assert inserted_row["order"] == 2
    assert {(item.chapter_id, item.operation) for item in commits} == {
        (inserted_id, "create"),
        ("chap-2", "update"),
    }
    assert {(item.chapter_id, item.exists) for item in snapshots} == {
        (inserted_id, False),
        ("chap-2", True),
    }


@pytest.mark.asyncio
async def test_rollback_second_subagent_revision_restores_chapter_to_first_revision_content(
    revision_db,
    monkeypatch,
):
    from app.agent_runtime.revisions import begin_user_revision, rollback_revision_for_session
    from app.agent_runtime.tools.impls.chapter.edit_chapter import EditChapterTool
    from app.agent_runtime.tools.impls.chapter.write_chapter import WriteChapterTool
    from app.storage.repos import chapter_repo

    async def create_test_session():
        return revision_db()

    monkeypatch.setattr(
        "app.agent_runtime.tools.impls.chapter.edit_chapter.create_session",
        create_test_session,
    )

    async with revision_db() as session:
        first_user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="委派 subagent 创建章节",
        )
        first_revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=first_user.id,
            user_message_seq=first_user.seq,
            message="用户消息: 委派 subagent 创建章节",
            pre_run_checkpoint_id="cp-before-first",
            graph_thread_id="sess-1",
        )
        await session.commit()

    write_tool = WriteChapterTool(
        _state={
            "session_id": "sess-1:child:writer",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": first_revision.id,
        }
    )
    write_result = json.loads(
        await write_tool.ainvoke(
            {
                "volume_ref": {"type": "order", "value": 1},
                "title": "Subagent 章节",
                "content": "你好",
            }
        )
    )
    chapter_id = write_result["metadata"]["chapter_diff"]["chapter_id"]

    async with revision_db() as session:
        second_user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="通知 subagent 修改章节",
        )
        second_revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=second_user.id,
            user_message_seq=second_user.seq,
            message="用户消息: 通知 subagent 修改章节",
            pre_run_checkpoint_id="cp-before-second",
            graph_thread_id="sess-1",
        )
        await session.commit()

    edit_tool = EditChapterTool(
        _state={
            "session_id": "sess-1:child:writer",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": second_revision.id,
        }
    )
    edit_result = json.loads(
        await edit_tool.ainvoke(
            {
                "volume_ref": {"type": "order", "value": 1},
                "chapter_ref": {"type": "title", "value": "Subagent 章节"},
                "old_content": "你好",
                "new_content": "Hello",
            }
        )
    )
    assert edit_result.get("success") is True, edit_result

    async with revision_db() as session:
        edited = await chapter_repo.get_by_id(session, chapter_id)
        assert edited is not None
        assert edited.content == "Hello"
        await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=second_revision.id,
        )
        await session.commit()

    async with revision_db() as session:
        restored = await chapter_repo.get_by_id(session, chapter_id)

    assert restored is not None
    assert restored.content == "你好"


@pytest.mark.asyncio
async def test_rollback_revision_restores_chapters_and_messages(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.chapter.write_chapter import WriteChapterTool
    from app.storage.repos import revision_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="插入一个章节",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 插入一个章节",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = WriteChapterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(
        await tool.ainvoke(
            {
                "volume_ref": {"type": "order", "value": 1},
                "title": "插入章",
                "content": "新内容",
                "chapter_ref": {"type": "order", "value": 2},
            }
        )
    )
    assert result["success"] is True
    inserted_id = result["metadata"]["chapter_diff"]["chapter_id"]

    async with revision_db() as session:
        await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="assistant",
            status="complete",
            content="已插入",
        )
        await session.commit()

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert rollback_result.restored_message_content == "插入一个章节"
    assert set(rollback_result.affected_chapters) == {inserted_id, "chap-2"}

    async with revision_db() as session:
        chapters = await session.execute(
            Chapter.__table__.select().where(Chapter.project_id == "proj-1")
        )
        rows = sorted(chapters.mappings().all(), key=lambda row: row["order"])
        messages = await message_repo.list_by_session(session, "sess-1")
        rolled_back = await revision_repo.get_by_id(session, revision.id)
        task = await session.get(Task, "task-1")

    assert [(row["id"], row["order"]) for row in rows] == [("chap-1", 1), ("chap-2", 2)]
    assert inserted_id not in {row["id"] for row in rows}
    assert messages == []
    assert rolled_back is not None
    assert rolled_back.status == "rolled_back"
    assert task is not None


@pytest.mark.asyncio
async def test_rollback_preserves_target_message_attachments_for_resending(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )

    attachment_metadata = {
        "id": "attachment-1",
        "storage_name": "sess-1/attachment-1.png",
        "file_name": "reference.png",
        "mime_type": "image/png",
        "size_bytes": 12,
        "width": 2,
        "height": 3,
        "url": "/agent-attachments/sess-1/attachment-1.png",
    }
    async with revision_db() as session:
        session.add(
            AgentAttachment(
                id="attachment-1",
                session_id="sess-1",
                task_id="task-1",
                project_id="proj-1",
                storage_name="sess-1/attachment-1.png",
                file_name="reference.png",
                mime_type="image/png",
                size_bytes=12,
                width=2,
                height=3,
            )
        )
        user_message = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="请参考图片",
            metadata={"attachments": [attachment_metadata]},
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user_message.id,
            user_message_seq=user_message.seq,
            message="用户消息: 请参考图片",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    async with revision_db() as session:
        result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert result.restored_message_content == "请参考图片"
    assert result.restored_attachments == [attachment_metadata]

    async with revision_db() as session:
        assert await session.get(AgentAttachment, "attachment-1") is not None


@pytest.mark.asyncio
async def test_rollback_rejects_oversized_chapter_snapshot_before_mutating(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.storage.repos import chapter_repo, revision_chapter_snapshot_repo, revision_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="恢复超限章节",
        )
        target_revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 恢复超限章节",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await revision_chapter_snapshot_repo.create(
            session,
            RevisionChapterSnapshot(
                revision_id=target_revision.id,
                chapter_id="chap-1",
                project_id="proj-1",
                exists=True,
                title="第一章",
                content="\n".join("超限内容" for _ in range(2001)),
                word_count=0,
                chapter_order=1,
            ),
        )
        chapter = await chapter_repo.get_by_id(session, "chap-1")
        assert chapter is not None
        chapter.content = "回滚前内容"
        await chapter_repo.update_chapter(session, chapter)
        await session.commit()

    async with revision_db() as session:
        with pytest.raises(ValueError, match="内容超出限制"):
            await rollback_revision_for_session(
                session,
                agent_session_id="sess-1",
                revision_id=target_revision.id,
            )
        await session.commit()

    async with revision_db() as session:
        chapter = await chapter_repo.get_by_id(session, "chap-1")
        target_after = await revision_repo.get_by_id(session, target_revision.id)
        revisions = await revision_repo.list_by_agent_session_from_seq(
            session,
            "sess-1",
            target_revision.user_message_seq,
        )

    assert chapter is not None
    assert chapter.content == "回滚前内容"
    assert target_after is not None
    assert target_after.status != "rolled_back"
    assert all(revision.revision_type != "rollback" for revision in revisions)


@pytest.mark.asyncio
async def test_rollback_revision_deletes_compactions_intersecting_deleted_messages(
    revision_db,
):
    from app.agent_runtime.persistence import compaction_repo
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )

    async with revision_db() as session:
        await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="第一轮",
        )
        await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="assistant",
            status="complete",
            content="第一轮回复",
        )
        await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="assistant",
            status="complete",
            content="第二轮前置回复",
        )
        target_user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="回滚目标",
        )
        target_revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=target_user.id,
            user_message_seq=target_user.seq,
            message="用户消息: 回滚目标",
            pre_run_checkpoint_id="cp-before-target",
            graph_thread_id="sess-1",
        )
        await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="assistant",
            status="complete",
            content="将被删除的回复",
        )
        await compaction_repo.insert_compaction(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            start_seq=0,
            end_seq=1,
            summary="保留的压缩",
            trigger="manual",
        )
        await compaction_repo.insert_compaction(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            start_seq=2,
            end_seq=4,
            summary="与回滚删除范围相交的压缩",
            trigger="manual",
        )
        await session.commit()

    async with revision_db() as session:
        await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=target_revision.id,
        )
        await session.commit()

    async with revision_db() as session:
        rows = await compaction_repo.list_by_session(session, "sess-1")

    assert [(row.start_seq, row.end_seq, row.summary) for row in rows] == [
        (0, 1, "保留的压缩"),
    ]


@pytest.mark.asyncio
async def test_write_note_records_revision_snapshot(revision_db):
    from app.agent_runtime.revisions import begin_user_revision
    from app.agent_runtime.tools.impls.note.write_note import WriteNoteTool
    from app.storage.repos import revision_note_snapshot_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="创建一个笔记",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 创建一个笔记",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = WriteNoteTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(
        await tool.ainvoke(
            {"title": "新笔记", "content": "新内容", "category_ref": {"id": "cat-1"}}
        )
    )
    assert result["success"] is True
    created_id = result["metadata"]["note_diff"]["note_id"]

    async with revision_db() as session:
        snapshots = await revision_note_snapshot_repo.list_by_revision(
            session, revision.id
        )

    assert {(item.note_id, item.exists) for item in snapshots} == {
        (created_id, False),
    }


@pytest.mark.asyncio
async def test_rollback_revision_restores_notes(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.note.delete_note import DeleteNoteTool
    from app.agent_runtime.tools.impls.note.edit_note import EditNoteTool
    from app.agent_runtime.tools.impls.note.write_note import WriteNoteTool
    from app.storage.repos import note_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="操作笔记",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 操作笔记",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    state = {
        "session_id": "sess-1",
        "task_id": "task-1",
        "project_id": "proj-1",
        "current_revision_id": revision.id,
    }

    write_tool = WriteNoteTool(_state=state)
    write_result = json.loads(
        await write_tool.ainvoke(
            {"title": "临时笔记", "content": "将被回滚删除", "category_ref": {"id": "cat-1"}}
        )
    )
    assert write_result["success"] is True
    created_id = write_result["metadata"]["note_diff"]["note_id"]

    edit_tool = EditNoteTool(_state=state)
    edit_result = json.loads(
        await edit_tool.ainvoke(
            {
                "note_ref": {"id": "note-1"},
                "old_content": "原始内容",
                "new_content": "被修改的内容",
            }
        )
    )
    assert edit_result["success"] is True

    delete_tool = DeleteNoteTool(_state=state)
    delete_result = json.loads(
        await delete_tool.ainvoke({"note_ref": {"id": "note-1"}})
    )
    assert delete_result["success"] is True

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_notes) == {created_id, "note-1"}

    async with revision_db() as session:
        created_after = await note_repo.get_by_id(session, created_id)
        original_after = await note_repo.get_by_id(session, "note-1")
        all_notes = await note_repo.list_by_project(session, "proj-1")

    assert created_after is None
    assert original_after is not None
    assert original_after.title == "已有笔记"
    assert original_after.content == "原始内容"
    assert {n.id for n in all_notes} == {"note-1"}


@pytest.mark.asyncio
async def test_rollback_revision_restores_moved_note(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.note.move_note import MoveNoteTool
    from app.storage.repos import note_repo

    async with revision_db() as session:
        session.add(
            NoteCategory(
                id="cat-2",
                project_id="proj-1",
                title="角色",
            )
        )
        await session.commit()

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="移动笔记",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 移动笔记",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    move_tool = MoveNoteTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    move_result = json.loads(
        await move_tool.ainvoke(
            {"note_ref": {"id": "note-1"}, "target_category_ref": {"id": "cat-2"}}
        )
    )
    assert move_result["success"] is True

    async with revision_db() as session:
        await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    async with revision_db() as session:
        note = await note_repo.get_by_id(session, "note-1")

    assert note is not None
    assert note.category_id == "cat-1"


@pytest.mark.asyncio
async def test_create_note_category_records_revision_snapshot(revision_db):
    from app.agent_runtime.revisions import begin_user_revision
    from app.agent_runtime.tools.impls.note.create_note_category import (
        CreateNoteCategoryTool,
    )
    from app.storage.repos import revision_note_snapshot_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="创建一个分类",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 创建一个分类",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = CreateNoteCategoryTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(
        await tool.ainvoke({"title": "新分类", "parent_ref": {"id": "cat-1"}})
    )
    assert result["success"] is True
    created_id = result["metadata"]["category"]["id"]

    async with revision_db() as session:
        snapshots = (
            await revision_note_snapshot_repo.list_category_snapshots_by_revision(
                session, revision.id
            )
        )

    assert {(item.category_id, item.exists) for item in snapshots} == {
        (created_id, False),
    }


@pytest.mark.asyncio
async def test_rollback_revision_restores_note_categories(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.note.create_note_category import (
        CreateNoteCategoryTool,
    )
    from app.storage.repos import note_category_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="创建分类",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 创建分类",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    state = {
        "session_id": "sess-1",
        "task_id": "task-1",
        "project_id": "proj-1",
        "current_revision_id": revision.id,
    }

    create_tool = CreateNoteCategoryTool(_state=state)
    create_result = json.loads(
        await create_tool.ainvoke({"title": "临时分类", "parent_ref": {"id": "cat-1"}})
    )
    assert create_result["success"] is True
    created_id = create_result["metadata"]["category"]["id"]

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_note_categories) == {created_id}

    async with revision_db() as session:
        created_after = await note_category_repo.get_by_id(session, created_id)
        all_cats = await note_category_repo.list_by_project(session, "proj-1")

    assert created_after is None
    assert {c.id for c in all_cats} == {"cat-1"}


@pytest.mark.asyncio
async def test_rollback_restores_nested_category_before_note(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.note.create_note_category import (
        CreateNoteCategoryTool,
    )
    from app.agent_runtime.tools.impls.note.write_note import WriteNoteTool
    from app.storage.repos import note_category_repo, note_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="创建嵌套分类和笔记",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 创建嵌套分类和笔记",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    state = {
        "session_id": "sess-1",
        "task_id": "task-1",
        "project_id": "proj-1",
        "current_revision_id": revision.id,
    }

    cat_tool = CreateNoteCategoryTool(_state=state)
    cat_result = json.loads(
        await cat_tool.ainvoke({"title": "新父分类"})
    )
    assert cat_result["success"] is True
    new_cat_id = cat_result["metadata"]["category"]["id"]

    sub_cat_tool = CreateNoteCategoryTool(_state=state)
    sub_cat_result = json.loads(
        await sub_cat_tool.ainvoke(
            {"title": "子分类", "parent_ref": {"id": new_cat_id}}
        )
    )
    assert sub_cat_result["success"] is True
    sub_cat_id = sub_cat_result["metadata"]["category"]["id"]

    write_tool = WriteNoteTool(_state=state)
    write_result = json.loads(
        await write_tool.ainvoke(
            {"title": "嵌套笔记", "content": "内容", "category_ref": {"id": sub_cat_id}}
        )
    )
    assert write_result["success"] is True
    note_id = write_result["metadata"]["note_diff"]["note_id"]

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_note_categories) == {
        new_cat_id,
        sub_cat_id,
    }
    assert set(rollback_result.affected_notes) == {note_id}

    async with revision_db() as session:
        new_cat_after = await note_category_repo.get_by_id(session, new_cat_id)
        sub_cat_after = await note_category_repo.get_by_id(session, sub_cat_id)
        note_after = await note_repo.get_by_id(session, note_id)
        all_cats = await note_category_repo.list_by_project(session, "proj-1")

    assert new_cat_after is None
    assert sub_cat_after is None
    assert note_after is None
    assert {c.id for c in all_cats} == {"cat-1"}


@pytest.mark.asyncio
async def test_rollback_revision_restores_created_world_entries(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.context.world_entry import CreateWorldEntryTool
    from app.storage.repos import world_info_entry_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="创建世界书条目",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 创建世界书条目",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = CreateWorldEntryTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(
        await tool.ainvoke({"title": "临时条目", "content": "临时设定"})
    )
    assert result["success"] is True
    entry_id = result["metadata"]["world_entry_diff"]["entry_id"]

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_world_entries) == {entry_id}

    async with revision_db() as session:
        entry_after = await world_info_entry_repo.get_by_id(session, entry_id)

    assert entry_after is None


@pytest.mark.asyncio
async def test_rollback_revision_restores_edited_world_entries(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.context.world_entry import EditWorldEntryTool
    from app.storage.repos import world_info_entry_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="编辑世界书条目",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 编辑世界书条目",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = EditWorldEntryTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(
        await tool.ainvoke(
            {
                "title": "已有条目",
                "new_title": "改名条目",
                "old_content": "原始",
                "new_content": "更新",
            }
        )
    )
    assert result["success"] is True

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_world_entries) == {"entry-1"}

    async with revision_db() as session:
        entry_after = await world_info_entry_repo.get_by_id(session, "entry-1")

    assert entry_after is not None
    assert entry_after.name == "已有条目"
    assert entry_after.content == "原始设定"


@pytest.mark.asyncio
async def test_rollback_revision_restores_deleted_world_entries(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.context.world_entry import DeleteWorldEntryTool
    from app.storage.repos import world_info_entry_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="删除世界书条目",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 删除世界书条目",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = DeleteWorldEntryTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(await tool.ainvoke({"title": "已有条目"}))
    assert result["success"] is True

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_world_entries) == {"entry-1"}

    async with revision_db() as session:
        entry_after = await world_info_entry_repo.get_by_id(session, "entry-1")

    assert entry_after is not None
    assert entry_after.name == "已有条目"
    assert entry_after.content == "原始设定"


@pytest.mark.asyncio
async def test_rollback_revision_restores_created_characters(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.context.character import CreateCharacterTool
    from app.storage.repos import character_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="创建角色",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 创建角色",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = CreateCharacterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(await tool.ainvoke({"name": "临时角色", "description": "临时描述"}))
    assert result["success"] is True
    character_id = result["metadata"]["character_diff"]["character_id"]

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_characters) == {character_id}

    async with revision_db() as session:
        character_after = await character_repo.get_by_id(session, character_id)

    assert character_after is None


@pytest.mark.asyncio
async def test_rollback_revision_restores_edited_characters(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.context.character import EditCharacterTool
    from app.storage.repos import character_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="编辑角色",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 编辑角色",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = EditCharacterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(
        await tool.ainvoke(
            {
                "name": "已有角色",
                "new_name": "改名角色",
                "old_description": "原始",
                "new_description": "更新",
            }
        )
    )
    assert result["success"] is True

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_characters) == {"char-1"}

    async with revision_db() as session:
        character_after = await character_repo.get_by_id(session, "char-1")

    assert character_after is not None
    assert character_after.name == "已有角色"
    assert character_after.description == "原始角色描述"
    assert character_after.is_favorited is False


@pytest.mark.asyncio
async def test_rollback_revision_restores_deleted_characters(revision_db):
    from app.agent_runtime.revisions import (
        begin_user_revision,
        rollback_revision_for_session,
    )
    from app.agent_runtime.tools.impls.context.character import DeleteCharacterTool
    from app.storage.repos import character_repo

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content="删除角色",
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message="用户消息: 删除角色",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()

    tool = DeleteCharacterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    result = json.loads(await tool.ainvoke({"name": "已有角色"}))
    assert result["success"] is True

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()

    assert set(rollback_result.affected_characters) == {"char-1"}

    async with revision_db() as session:
        character_after = await character_repo.get_by_id(session, "char-1")

    assert character_after is not None
    assert character_after.name == "已有角色"
    assert character_after.description == "原始角色描述"


async def _begin_revision(revision_db, *, content: str):
    """插入一条用户消息并开启对应的 agent revision。"""
    from app.agent_runtime.revisions import begin_user_revision

    async with revision_db() as session:
        user = await message_repo.insert_message(
            session,
            session_id="sess-1",
            task_id="task-1",
            project_id="proj-1",
            role="user",
            status="sent",
            content=content,
        )
        revision = await begin_user_revision(
            session,
            project_id="proj-1",
            task_id="task-1",
            agent_session_id="sess-1",
            user_message_id=user.id,
            user_message_seq=user.seq,
            message=f"用户消息: {content}",
            pre_run_checkpoint_id="cp-before",
            graph_thread_id="sess-1",
        )
        await session.commit()
    return revision


async def _rollback(revision_db, revision_id: str):
    from app.agent_runtime.revisions import rollback_revision_for_session

    async with revision_db() as session:
        result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision_id,
        )
        await session.commit()
    return result


@pytest.mark.asyncio
async def test_rollback_deleted_character_restores_extension_data(revision_db):
    """回滚 Agent 删除人物时，作者扩展字段 / 状态 / 条目关联一并恢复。"""
    from app.agent_runtime.tools.impls.context.character import DeleteCharacterTool
    from app.storage.repos import (
        character_extension_repo,
        character_repo,
        world_entry_meta_repo,
    )

    async with revision_db() as session:
        await character_extension_repo.upsert_profile(
            session, "char-1", {"identity": "记者", "goal": "查清真相"}
        )
        await character_extension_repo.upsert_state(
            session,
            "char-1",
            "proj-1",
            "chap-1",
            {"location": "北城", "mental_state": "怀疑身边的人"},
        )
        await world_entry_meta_repo.upsert(
            session,
            entry_id="entry-1",
            project_id="proj-1",
            entry_type="location",
            tags=["地理"],
            linked_character_ids=["char-1"],
            linked_chapter_ids=["chap-1"],
            ai_visible=False,
        )
        await session.commit()

    revision = await _begin_revision(revision_db, content="删除角色")

    tool = DeleteCharacterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    delete_result = json.loads(await tool.ainvoke({"name": "已有角色"}))
    assert delete_result["success"] is True

    async with revision_db() as session:
        assert await character_repo.get_by_id(session, "char-1") is None
        assert await character_extension_repo.get_profile(session, "char-1") is None
        assert await character_extension_repo.list_states(session, "char-1") == []
        meta_after_delete = await world_entry_meta_repo.get_by_entry_id(session, "entry-1")

    assert meta_after_delete is not None
    assert world_entry_meta_repo.get_linked_character_ids(meta_after_delete) == []

    await _rollback(revision_db, revision.id)

    async with revision_db() as session:
        character_after = await character_repo.get_by_id(session, "char-1")
        profile_after = await character_extension_repo.get_profile(session, "char-1")
        states_after = await character_extension_repo.list_states(session, "char-1")
        meta_after = await world_entry_meta_repo.get_by_entry_id(session, "entry-1")

    assert character_after is not None
    assert profile_after is not None
    assert profile_after.identity == "记者"
    assert profile_after.goal == "查清真相"
    assert [(state.chapter_id, state.location, state.mental_state) for state in states_after] == [
        ("chap-1", "北城", "怀疑身边的人")
    ]
    assert meta_after is not None
    assert world_entry_meta_repo.get_linked_character_ids(meta_after) == ["char-1"]


@pytest.mark.asyncio
async def test_rollback_created_character_leaves_no_orphan_extension_rows(revision_db):
    """回滚 Agent 新建人物时，创建后补写的扩展行不能留下孤立记录。"""
    from app.agent_runtime.tools.impls.context.character import CreateCharacterTool
    from app.storage.repos import (
        character_extension_repo,
        character_repo,
        world_entry_meta_repo,
    )

    revision = await _begin_revision(revision_db, content="创建一个临时角色")

    tool = CreateCharacterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    create_result = json.loads(await tool.ainvoke({"name": "临时角色", "description": "临时描述"}))
    assert create_result["success"] is True
    character_id = create_result["metadata"]["character_diff"]["character_id"]

    async with revision_db() as session:
        await character_extension_repo.upsert_profile(
            session, character_id, {"identity": "路人"}
        )
        await character_extension_repo.upsert_state(
            session, character_id, "proj-1", None, {"location": "东城"}
        )
        await world_entry_meta_repo.upsert(
            session,
            entry_id="entry-1",
            project_id="proj-1",
            linked_character_ids=[character_id],
        )
        await session.commit()

    await _rollback(revision_db, revision.id)

    async with revision_db() as session:
        assert await character_repo.get_by_id(session, character_id) is None
        assert await character_extension_repo.get_profile(session, character_id) is None
        assert await character_extension_repo.list_states(session, character_id) == []
        meta_after = await world_entry_meta_repo.get_by_entry_id(session, "entry-1")

    assert meta_after is not None
    assert world_entry_meta_repo.get_linked_character_ids(meta_after) == []


@pytest.mark.asyncio
async def test_rollback_deleted_world_entry_restores_extension_meta(revision_db):
    """回滚 Agent 删除世界设定条目时，类型 / 标签 / 关联 / AI 可见性一并恢复。"""
    from app.agent_runtime.tools.impls.context.world_entry import DeleteWorldEntryTool
    from app.storage.repos import world_entry_meta_repo, world_info_entry_repo

    async with revision_db() as session:
        await world_entry_meta_repo.upsert(
            session,
            entry_id="entry-1",
            project_id="proj-1",
            entry_type="organization",
            tags=["势力", "北境"],
            linked_character_ids=["char-1"],
            linked_chapter_ids=["chap-1"],
            ai_visible=True,
            custom_type_label="自定义类型",
        )
        await session.commit()

    revision = await _begin_revision(revision_db, content="删除世界书条目")

    tool = DeleteWorldEntryTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    delete_result = json.loads(await tool.ainvoke({"title": "已有条目"}))
    assert delete_result["success"] is True

    async with revision_db() as session:
        assert await world_info_entry_repo.get_by_id(session, "entry-1") is None
        assert await world_entry_meta_repo.get_by_entry_id(session, "entry-1") is None

    await _rollback(revision_db, revision.id)

    async with revision_db() as session:
        entry_after = await world_info_entry_repo.get_by_id(session, "entry-1")
        meta_after = await world_entry_meta_repo.get_by_entry_id(session, "entry-1")

    assert entry_after is not None
    assert meta_after is not None
    assert meta_after.entry_type == "organization"
    assert world_entry_meta_repo.get_tags(meta_after) == ["势力", "北境"]
    assert world_entry_meta_repo.get_linked_character_ids(meta_after) == ["char-1"]
    assert world_entry_meta_repo.get_linked_chapter_ids(meta_after) == ["chap-1"]
    assert meta_after.ai_visible is True
    assert meta_after.custom_type_label == "自定义类型"


@pytest.mark.asyncio
async def test_world_entry_extension_round_trip_keeps_ai_visible_false(revision_db):
    """扩展负载的捕获 / 删除 / 恢复往返要保留 ai_visible=False 这类非默认值。

    删除工具会拒绝删除未向 AI 开放的条目，所以这条路径直接用扩展辅助函数验证。
    """
    from app.agent_runtime.revision_extensions import (
        capture_world_entry_extensions,
        delete_world_entry_extensions,
        restore_world_entry_extensions,
    )
    from app.storage.repos import world_entry_meta_repo

    async with revision_db() as session:
        await world_entry_meta_repo.upsert(
            session,
            entry_id="entry-1",
            project_id="proj-1",
            entry_type="custom",
            tags=["隐秘"],
            ai_visible=False,
            custom_type_label="隐秘设定",
        )
        await session.commit()

    async with revision_db() as session:
        payload = await capture_world_entry_extensions(session, entry_id="entry-1")
        await delete_world_entry_extensions(session, entry_id="entry-1")
        await session.commit()

    async with revision_db() as session:
        assert await world_entry_meta_repo.get_by_entry_id(session, "entry-1") is None
        await restore_world_entry_extensions(
            session, project_id="proj-1", entry_id="entry-1", payload=payload
        )
        await session.commit()

    async with revision_db() as session:
        meta_after = await world_entry_meta_repo.get_by_entry_id(session, "entry-1")

    assert meta_after is not None
    assert meta_after.entry_type == "custom"
    assert world_entry_meta_repo.get_tags(meta_after) == ["隐秘"]
    assert meta_after.ai_visible is False
    assert meta_after.custom_type_label == "隐秘设定"


@pytest.mark.asyncio
async def test_rollback_created_world_entry_leaves_no_orphan_extension_meta(revision_db):
    """回滚 Agent 新建世界设定条目时，创建后补写的扩展行不能留下孤立记录。"""
    from app.agent_runtime.tools.impls.context.world_entry import CreateWorldEntryTool
    from app.storage.repos import world_entry_meta_repo, world_info_entry_repo

    revision = await _begin_revision(revision_db, content="新增世界书条目")

    tool = CreateWorldEntryTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    create_result = json.loads(
        await tool.ainvoke({"title": "新条目", "content": "新设定内容"})
    )
    assert create_result["success"] is True
    entry_id = create_result["metadata"]["world_entry_diff"]["entry_id"]

    async with revision_db() as session:
        await world_entry_meta_repo.upsert(
            session,
            entry_id=entry_id,
            project_id="proj-1",
            entry_type="rule",
            tags=["规则"],
        )
        await session.commit()

    await _rollback(revision_db, revision.id)

    async with revision_db() as session:
        assert await world_info_entry_repo.get_by_id(session, entry_id) is None
        assert await world_entry_meta_repo.get_by_entry_id(session, entry_id) is None


@pytest.mark.asyncio
async def test_rollback_deleted_chapter_restores_extension_data(revision_db):
    """回滚 Agent 删除章节时，章节附加信息 / 章节内人物状态 / 条目关联一并恢复。"""
    from app.agent_runtime.tools.impls.chapter.delete_chapter import DeleteChapterTool
    from app.storage.repos import (
        chapter_meta_repo,
        chapter_repo,
        character_extension_repo,
        world_entry_meta_repo,
    )

    async with revision_db() as session:
        await chapter_meta_repo.upsert(
            session,
            chapter_id="chap-1",
            project_id="proj-1",
            values={"status": "writing", "target_word_count": 3000},
        )
        await character_extension_repo.upsert_state(
            session,
            "char-1",
            "proj-1",
            "chap-1",
            {"location": "北城"},
        )
        await world_entry_meta_repo.upsert(
            session,
            entry_id="entry-1",
            project_id="proj-1",
            linked_chapter_ids=["chap-1"],
        )
        await session.commit()

    revision = await _begin_revision(revision_db, content="删除章节")

    tool = DeleteChapterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    delete_result = json.loads(
        await tool.ainvoke(
            {
                "volume_ref": {"type": "order", "value": 1},
                "chapter_ref": {"type": "order", "value": 1},
            }
        )
    )
    assert delete_result["success"] is True

    async with revision_db() as session:
        assert await chapter_repo.get_by_id(session, "chap-1") is None
        assert await chapter_meta_repo.get_by_chapter_id(session, "chap-1") is None
        assert await character_extension_repo.list_states_by_chapter(session, "chap-1") == []
        meta_after_delete = await world_entry_meta_repo.get_by_entry_id(session, "entry-1")

    assert meta_after_delete is not None
    assert world_entry_meta_repo.get_linked_chapter_ids(meta_after_delete) == []

    await _rollback(revision_db, revision.id)

    async with revision_db() as session:
        chapter_after = await chapter_repo.get_by_id(session, "chap-1")
        meta_after = await chapter_meta_repo.get_by_chapter_id(session, "chap-1")
        states_after = await character_extension_repo.list_states_by_chapter(session, "chap-1")
        entry_meta_after = await world_entry_meta_repo.get_by_entry_id(session, "entry-1")

    assert chapter_after is not None
    assert meta_after is not None
    assert meta_after.status == "writing"
    assert meta_after.target_word_count == 3000
    assert [(state.character_id, state.chapter_id, state.location) for state in states_after] == [
        ("char-1", "chap-1", "北城")
    ]
    assert entry_meta_after is not None
    assert world_entry_meta_repo.get_linked_chapter_ids(entry_meta_after) == ["chap-1"]


@pytest.mark.asyncio
async def test_rollback_created_chapter_leaves_no_orphan_extension_rows(revision_db):
    """回滚 Agent 新建章节时，创建后补写的附加信息不能留下孤立记录。"""
    from app.agent_runtime.tools.impls.chapter.write_chapter import WriteChapterTool
    from app.storage.repos import chapter_meta_repo, chapter_repo

    revision = await _begin_revision(revision_db, content="插入一个章节")

    tool = WriteChapterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": revision.id,
        }
    )
    write_result = json.loads(
        await tool.ainvoke(
            {
                "volume_ref": {"type": "order", "value": 1},
                "title": "插入章",
                "content": "新内容",
                "chapter_ref": {"type": "order", "value": 2},
            }
        )
    )
    assert write_result["success"] is True
    chapter_id = write_result["metadata"]["chapter_diff"]["chapter_id"]

    async with revision_db() as session:
        await chapter_meta_repo.upsert(
            session,
            chapter_id=chapter_id,
            project_id="proj-1",
            values={"status": "done", "target_word_count": 5000},
        )
        await session.commit()

    await _rollback(revision_db, revision.id)

    async with revision_db() as session:
        assert await chapter_repo.get_by_id(session, chapter_id) is None
        assert await chapter_meta_repo.get_by_chapter_id(session, chapter_id) is None


@pytest.mark.asyncio
async def test_rollback_uses_earliest_character_snapshot_extension_payload(revision_db):
    """更早的 revision 已经带过扩展负载时，回滚到它仍能恢复后续被删除的扩展数据。"""
    from app.agent_runtime.tools.impls.context.character import (
        DeleteCharacterTool,
        EditCharacterTool,
    )
    from app.storage.repos import character_extension_repo, character_repo

    async with revision_db() as session:
        await character_extension_repo.upsert_profile(
            session, "char-1", {"identity": "记者"}
        )
        await session.commit()

    first_revision = await _begin_revision(revision_db, content="编辑角色")
    edit_tool = EditCharacterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": first_revision.id,
        }
    )
    edit_result = json.loads(
        await edit_tool.ainvoke(
            {
                "name": "已有角色",
                "new_name": "改名角色",
                "old_description": "原始",
                "new_description": "更新",
            }
        )
    )
    assert edit_result["success"] is True

    second_revision = await _begin_revision(revision_db, content="删除角色")
    delete_tool = DeleteCharacterTool(
        _state={
            "session_id": "sess-1",
            "task_id": "task-1",
            "project_id": "proj-1",
            "current_revision_id": second_revision.id,
        }
    )
    delete_result = json.loads(await delete_tool.ainvoke({"name": "改名角色"}))
    assert delete_result["success"] is True

    await _rollback(revision_db, first_revision.id)

    async with revision_db() as session:
        character_after = await character_repo.get_by_id(session, "char-1")
        profile_after = await character_extension_repo.get_profile(session, "char-1")

    assert character_after is not None
    assert character_after.name == "已有角色"
    assert profile_after is not None
    assert profile_after.identity == "记者"


@pytest.mark.asyncio
async def test_rollback_moving_chapter_into_occupied_order_parks_before_volume_change(
    revision_db,
):
    """跨卷回滚时，先暂存排序再改卷，避免触发卷内唯一约束。"""
    from app.agent_runtime.revisions import images_by_id, record_chapter_diffs
    from app.storage.repos import chapter_repo

    revision = await _begin_revision(revision_db, content="移动章节到另一卷")

    async with revision_db() as session:
        session.add(
            Volume(
                id="vol-2",
                project_id="proj-1",
                title="第二卷",
                order=2,
                chapter_count=1,
            )
        )
        session.add(
            Chapter(
                id="chap-3",
                project_id="proj-1",
                volume_id="vol-2",
                title="第三章",
                content="目标卷已有章节",
                word_count=7,
                order=1,
            )
        )
        await session.flush()

        chapter = await chapter_repo.get_by_id(session, "chap-1")
        assert chapter is not None
        before = images_by_id([chapter])
        chapter.volume_id = "vol-2"
        chapter.order = 2
        await chapter_repo.update_chapter(session, chapter)
        after = images_by_id([chapter])
        await record_chapter_diffs(
            session,
            revision_id=revision.id,
            project_id="proj-1",
            before=before,
            after=after,
        )
        await session.commit()

    await _rollback(revision_db, revision.id)

    async with revision_db() as session:
        restored = await chapter_repo.get_by_id(session, "chap-1")
        unchanged = await chapter_repo.get_by_id(session, "chap-2")
        target_chapter = await chapter_repo.get_by_id(session, "chap-3")

    assert restored is not None
    assert (restored.volume_id, restored.order) == ("vol-1", 1)
    assert unchanged is not None
    assert (unchanged.volume_id, unchanged.order) == ("vol-1", 2)
    assert target_chapter is not None
    assert (target_chapter.volume_id, target_chapter.order) == ("vol-2", 1)


@pytest.mark.asyncio
async def test_rollback_recalculates_word_count_from_snapshot_content(revision_db):
    """回滚写回章节时按正文重算字数，不能沿用快照里旧口径写下的过期字数。"""
    from app.agent_runtime.revisions import rollback_revision_for_session
    from app.storage.repos import (
        chapter_repo,
        commit_repo,
        project_repo,
        revision_chapter_snapshot_repo,
    )

    revision = await _begin_revision(revision_db, content="恢复章节正文")

    restored_content = "Hello, world! 你好。"

    async with revision_db() as session:
        await revision_chapter_snapshot_repo.create(
            session,
            RevisionChapterSnapshot(
                revision_id=revision.id,
                chapter_id="chap-1",
                project_id="proj-1",
                volume_id="vol-1",
                exists=True,
                title="第一章",
                content=restored_content,
                # 旧版本按旧口径写入：独立标点被当成英文词。
                word_count=99,
                chapter_order=1,
            ),
        )
        chapter = await chapter_repo.get_by_id(session, "chap-1")
        assert chapter is not None
        chapter.content = "回滚前的正文"
        chapter.word_count = 6
        await chapter_repo.update_chapter(session, chapter)
        await session.commit()

    async with revision_db() as session:
        rollback_result = await rollback_revision_for_session(
            session,
            agent_session_id="sess-1",
            revision_id=revision.id,
        )
        await session.commit()
        rollback_revision_id = rollback_result.rollback_revision.id

    async with revision_db() as session:
        restored = await chapter_repo.get_by_id(session, "chap-1")
        untouched = await chapter_repo.get_by_id(session, "chap-2")
        project = await project_repo.get_by_id(session, "proj-1")
        commits = await commit_repo.list_by_revision(session, rollback_revision_id)

    assert restored is not None
    assert restored.content == restored_content
    assert restored.word_count == 4
    assert untouched is not None
    assert untouched.word_count == 4
    assert project is not None
    assert project.word_count == 8
    assert project.chapter_count == 2
    rolled_back_commit = next(item for item in commits if item.chapter_id == "chap-1")
    # 回滚提交记录的是重算后的字数，不是快照里的过期值。
    assert rolled_back_commit.new_word_count == 4
    assert rolled_back_commit.snapshot_word_count == 6


@pytest.mark.asyncio
async def test_restore_character_extensions_skips_malformed_state_snapshot(revision_db):
    """结构不完整的状态快照应跳过，不得删除当前有效状态。"""
    from app.agent_runtime.revision_extensions import restore_character_extensions
    from app.storage.repos import character_extension_repo

    async with revision_db() as session:
        await character_extension_repo.upsert_state(
            session,
            "char-1",
            "proj-1",
            None,
            {"location": "当前状态"},
        )
        await session.commit()

    async with revision_db() as session:
        await restore_character_extensions(
            session,
            project_id="proj-1",
            character_id="char-1",
            payload={"states": [{"id": "state-corrupt", "location": "损坏负载"}]},
            existing_chapter_ids={"chap-1"},
        )
        await session.commit()

    async with revision_db() as session:
        states = await character_extension_repo.list_states(session, "char-1")

    assert [(state.project_id, state.location) for state in states] == [
        ("proj-1", "当前状态")
    ]
