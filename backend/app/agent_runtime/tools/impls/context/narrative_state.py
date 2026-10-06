# -*- coding: utf-8 -*-
"""只读工具：读取当前项目中「已确认」的结构化叙事状态。

数据来源是 `app/core/narrative_context.py` 的只读适配层（世界事实 / 人物信念 /
情节线 / 场景计划四类扩展表），不新建第二套读取逻辑，也不做检索：不依赖
embedding 模型，也不依赖故事记忆索引是否就绪。

范围一律显式解析，绝不从正文里猜：

* 项目来自当前 Agent 会话的 `project_id`，不接受模型传参；
* 章节只在模型显式给出 `volume_ref` + `chapter_ref` 时按项目内实际的卷与章节解析，
  解析不到就直接报错，不退回「大概是这一章」；
* 没有显式章节时只返回项目级记录，不附带任何章节的场景计划。

只读：全程只有查询，不写入、不修改正文、大纲、人物或设定。
"""

import json
from textwrap import dedent
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.chapter.refs import (
    ChapterRef,
    VolumeRef,
    resolve_chapter_from_list,
    resolve_volume_from_list,
)
from app.agent_runtime.tools.registry import ToolRegistry
from app.core.narrative_context import build_narrative_state_context
from app.storage.database import create_session
from app.storage.repos import chapter_repo, volume_repo


class ReadNarrativeStateInput(BaseModel):
    volume_ref: VolumeRef | None = Field(
        default=None,
        description=(
            "可选：要附带场景计划的章节所在卷。必须与 chapter_ref 同时提供，"
            "只传其中一个按参数错误处理"
        ),
    )
    chapter_ref: ChapterRef | None = Field(
        default=None,
        description=(
            "可选：要附带场景计划的章节（卷内序号或精确标题）。"
            "不传时只返回项目级的世界事实、人物信念与情节线"
        ),
    )


class ReadNarrativeStateOutput(BaseModel):
    has_confirmed_state: bool
    state_text: str
    chapter_scope: str | None


def _scope_args(
    volume_ref: dict[str, Any] | None,
    chapter_ref: dict[str, Any] | None,
) -> tuple[VolumeRef, ChapterRef] | None:
    """校验章节范围参数：两个都给才解析，只给一个视为错误。"""
    if volume_ref is None and chapter_ref is None:
        return None
    if volume_ref is None or chapter_ref is None:
        raise ToolExecutionError(
            "附带章节场景计划时 volume_ref 与 chapter_ref 必须同时提供"
        )
    return VolumeRef.model_validate(volume_ref), ChapterRef.model_validate(chapter_ref)


async def _resolve_chapter_scope(
    session: AsyncSession,
    *,
    project_id: str,
    scope: tuple[VolumeRef, ChapterRef],
) -> Any:
    """把显式的卷 / 章节定位解析成当前项目内的章节；解析不到就报错。"""
    volume_ref, chapter_ref = scope
    volumes = await volume_repo.list_by_project(session, project_id)
    resolved_volume = resolve_volume_from_list(volumes, volume_ref)
    matched = await chapter_repo.get_by_volume_ref(
        session,
        resolved_volume.id,
        ref_type=chapter_ref.type,
        ref_value=chapter_ref.value,
    )
    return resolve_chapter_from_list([matched] if matched is not None else [], chapter_ref)


@ToolRegistry.register
class ReadNarrativeStateTool(AgentTool):
    name: str = "read_narrative_state"
    description: str = dedent("""\
        只读读取当前项目中经过人工确认的结构化叙事状态：
        世界事实、人物信念、情节线（setup/payoff 义务），
        以及显式指定章节时的场景计划。
        未确认、已被取代、已失效或已作废的记录不会返回；
        内容有长度上限，超出的记录只汇总数量，「资料里没有记录」不等于「事实不存在」。
        人物信念只是某个人物相信的命题，可能与其把握程度不符，不能当作世界事实。""")
    access_level: str = "readonly"
    args_schema: type[BaseModel] = ReadNarrativeStateInput

    async def _execute(
        self,
        volume_ref: dict[str, Any] | None = None,
        chapter_ref: dict[str, Any] | None = None,
    ) -> str:
        scope = _scope_args(volume_ref, chapter_ref)
        session = self.get_runtime_db_session()
        owns_session = session is None
        if session is None:
            session = await create_session()
        try:
            chapter = (
                await _resolve_chapter_scope(
                    session, project_id=self.project_id, scope=scope
                )
                if scope is not None
                else None
            )
            state_text = await build_narrative_state_context(
                session,
                project_id=self.project_id,
                scene_plan_chapter_id=chapter.id if chapter is not None else None,
            )
        finally:
            if owns_session:
                await session.close()

        return json.dumps(
            ReadNarrativeStateOutput(
                has_confirmed_state=bool(state_text),
                state_text=state_text,
                chapter_scope=(
                    f"第{chapter.order}章 {chapter.title}".strip()
                    if chapter is not None
                    else None
                ),
            ).model_dump(),
            ensure_ascii=False,
        )
