# -*- coding: utf-8 -*-
"""LLM Audit Log Repository - 审计记录的存储层级联删除。

审计记录的运行期写入与查询在 ``app.audit.repo.LLMAuditLogRepo``；本模块只提供
项目删除需要的窄接口，让 storage 层不必反向依赖 audit 层。
"""

from sqlalchemy import delete as sql_delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.storage.models.llm_audit_log import LLMAuditLog


async def delete_by_project(session: AsyncSession, project_id: str) -> None:
    """删除项目内全部 LLM 审计记录。"""
    await session.execute(
        sql_delete(LLMAuditLog).where(col(LLMAuditLog.project_id) == project_id)
    )
    await session.flush()
