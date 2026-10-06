import json
from typing import Any

from pydantic import BaseModel

from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.errors import ToolFailure, serialize_tool_failure
from app.agent_runtime.tools.registry import ToolRegistry
from app.background.jobs import service as background_service
from app.background.jobs.constants import JOB_TYPE_STORY_MEMORY_REBUILD
from app.background.jobs.states import JOB_STATUS_PENDING, JOB_STATUS_RUNNING
from app.retrieval.chapter_index import (
    enqueue_project_index_update,
    get_index_settings,
    is_project_index_enabled,
    resolve_index_embedding_model,
)
from app.retrieval.index_status import schedule_emit_index_status
from app.retrieval.story_memory import (
    enqueue_story_memory_rebuild,
    story_memory_index_is_fresh,
)
from app.storage.database import create_session

# 索引更新结果状态：区分「已入队」与「已最新」，排队不等于已经可以检索。
INDEX_STATUS_QUEUED = "queued"
INDEX_STATUS_FRESH = "fresh"
INDEX_STATUS_ALREADY_QUEUED = "already_queued"
INDEX_STATUS_DISABLED = "disabled"
INDEX_STATUS_UNAVAILABLE = "unavailable"

QUEUED_NOTE = "索引更新任务已入队，尚未完成；后台任务完成前检索仍可能返回旧结果。"


class UpdateIndexInput(BaseModel):
    pass


@ToolRegistry.register
class UpdateIndexTool(AgentTool):
    name: str = "update_index"
    description: str = (
        "更新当前项目的检索索引：把未就绪或过期的章节索引，以及人物、世界设定、"
        "大纲、笔记的故事记忆索引加入后台重建队列。适用于索引非最新时主动更新；"
        "返回 queued 表示任务刚入队，索引尚未就绪，需等待后台任务完成"
    )
    access_level: str = "write"
    args_schema: type[BaseModel] = UpdateIndexInput

    async def _execute(self) -> str:
        session = await create_session()
        try:
            config = await get_index_settings(session)
            model = await resolve_index_embedding_model(session, config)
            if model is None:
                # 没有可用嵌入模型时两个索引都无法更新，保持与整体状态一致的阻塞语义。
                return serialize_tool_failure(
                    ToolFailure(
                        code="dependency_unavailable",
                        message="当前项目未配置可用的嵌入模型，无法更新检索索引。",
                        trace={"source": "retrieval_index"},
                    )
                )

            chapter_index = await self._update_chapter_index(session, config)
            story_memory_index = await self._update_story_memory_index(session)

            queued = (
                chapter_index["status"] == INDEX_STATUS_QUEUED
                or story_memory_index["status"] == INDEX_STATUS_QUEUED
            )
            # 章节索引入库过程本身也可能改动章节状态与索引行，因此只要它执行过就推送。
            if chapter_index["status"] != INDEX_STATUS_DISABLED or queued:
                schedule_emit_index_status(session, self.project_id)
            await background_service.commit_and_notify(session)

            payload: dict[str, Any] = {
                "success": True,
                "chapter_index": chapter_index,
                "story_memory_index": story_memory_index,
            }
            if queued:
                payload["note"] = QUEUED_NOTE
            return json.dumps(payload, ensure_ascii=False)
        except Exception:
            await background_service.rollback_and_discard(session)
            raise
        finally:
            await session.close()

    async def _update_chapter_index(self, session, config) -> dict[str, Any]:
        if not is_project_index_enabled(config, self.project_id):
            return {
                "status": INDEX_STATUS_DISABLED,
                "enqueued_count": 0,
                "message": "当前项目未启用章节索引，已跳过章节索引更新。",
            }

        result = await enqueue_project_index_update(
            session,
            project_id=self.project_id,
        )
        if result is None:
            # 配置在本次调用期间变化时仍按不可用上报，不谎称已更新。
            return {
                "status": INDEX_STATUS_UNAVAILABLE,
                "enqueued_count": 0,
                "message": "章节索引未能更新：项目未启用索引或未配置可用的嵌入模型。",
            }
        if result.enqueued_count == 0:
            return {
                "status": INDEX_STATUS_FRESH,
                "enqueued_count": 0,
                "skipped_count": result.skipped_count,
                "message": "章节索引已是最新，无需更新。",
            }
        return {
            "status": INDEX_STATUS_QUEUED,
            "enqueued_count": result.enqueued_count,
            "skipped_count": result.skipped_count,
            "message": f"章节索引已开始更新，共 {result.enqueued_count} 个章节在排队索引。",
        }

    async def _update_story_memory_index(self, session) -> dict[str, Any]:
        # 已有重建任务时不再提交，否则每次调用都会排队一份重复的全量重建。
        active_jobs = await background_service.list_jobs(
            session,
            subject_type="project",
            subject_id=self.project_id,
            statuses={JOB_STATUS_PENDING, JOB_STATUS_RUNNING},
            job_type=JOB_TYPE_STORY_MEMORY_REBUILD,
            limit=1,
            offset=0,
        )
        if active_jobs:
            return {
                "status": INDEX_STATUS_ALREADY_QUEUED,
                "job_id": active_jobs[0].id,
                "message": "故事记忆索引已有重建任务在队列中，未重复提交。",
            }

        if await story_memory_index_is_fresh(session, project_id=self.project_id):
            return {
                "status": INDEX_STATUS_FRESH,
                "job_id": None,
                "message": "故事记忆索引已是最新，无需重建。",
            }

        job_id = await enqueue_story_memory_rebuild(
            session,
            project_id=self.project_id,
        )
        if job_id is None:
            return {
                "status": INDEX_STATUS_UNAVAILABLE,
                "job_id": None,
                "message": "故事记忆索引未能重建：未配置可用的嵌入模型。",
            }
        return {
            "status": INDEX_STATUS_QUEUED,
            "job_id": job_id,
            "message": (
                "故事记忆索引已加入重建队列，完成后才能检索到最新的人物、"
                "世界设定、大纲与笔记。"
            ),
        }
