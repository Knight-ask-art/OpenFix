# -*- coding: utf-8 -*-
"""
Project Service - 项目业务逻辑层。
"""

from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.core.storage import (
    delete_character_image,
    delete_cover_file,
    save_cover_file,
)
from app.storage.models.project import Project
from app.storage.repos import (
    agent_rule_repo,
    character_extension_repo,
    character_repo,
    chapter_meta_repo,
    chapter_repo,
    chapter_summary_repo,
    llm_audit_log_repo,
    note_category_repo,
    note_repo,
    outline_repo,
    project_profile_repo,
    project_repo,
    retrieval_chapter_index_state_repo,
    volume_repo,
    world_entry_meta_repo,
    world_info_entry_repo,
    world_info_repo,
    writing_activity_repo,
)
from app.storage.services import task_service, volume_service
from app.storage.services.revision_service import delete_revision_data_by_project


@dataclass
class ProjectListResult:
    """项目列表结果。"""

    items: list[Project]
    total: int
    page: int
    page_size: int


async def create_project(
    session: AsyncSession,
    title: str,
    description: str | None = None,
    cover_file: UploadFile | None = None,
) -> Project:
    """
    创建项目。

    Args:
        session: 数据库 session。
        title: 项目标题。
        description: 项目简介，可选。
        cover_file: 封面文件，可选。

    Returns:
        创建的项目实例。
    """
    project = Project(title=title, description=description)
    project = await project_repo.create(session, project)
    await volume_service.create_default_volume(session, project.id)

    # 如果提供了封面文件，保存封面
    if cover_file:
        cover_path = await save_cover_file(project.id, cover_file)
        project.cover_path = cover_path
        project = await project_repo.update(session, project)

    return project


async def get_project(session: AsyncSession, project_id: str) -> Project:
    """
    获取项目。

    Args:
        session: 数据库 session。
        project_id: 项目 ID。

    Returns:
        项目实例。

    Raises:
        NotFoundError: 项目不存在。
    """
    project = await project_repo.get_by_id(session, project_id)
    if project is None:
        raise NotFoundError(f"项目不存在: {project_id}")
    return project


async def list_projects(
    session: AsyncSession,
    page: int = 1,
    page_size: int = 20,
    search: str | None = None,
    sort_by: str = "updated_at",
    sort_order: str = "desc",
) -> ProjectListResult:
    """
    获取项目列表。

    Args:
        session: 数据库 session。
        page: 页码，从 1 开始。
        page_size: 每页数量。
        search: 项目标题或简介搜索词。
        sort_by: 排序字段。
        sort_order: 排序方向。

    Returns:
        项目列表结果。
    """
    offset = (page - 1) * page_size
    items = await project_repo.list_all(
        session,
        offset=offset,
        limit=page_size,
        search=search,
        sort_by=sort_by,
        sort_order=sort_order,
    )
    total = await project_repo.count(session, search=search)
    return ProjectListResult(items=items, total=total, page=page, page_size=page_size)


async def update_project(
    session: AsyncSession,
    project_id: str,
    title: str | None = None,
    description: str | None = None,
    cover_file: UploadFile | None = None,
) -> Project:
    """
    更新项目。

    Args:
        session: 数据库 session。
        project_id: 项目 ID。
        title: 新标题，可选。
        description: 新简介，可选。
        cover_file: 新封面文件，可选。

    Returns:
        更新后的项目实例。

    Raises:
        NotFoundError: 项目不存在。
    """
    project = await get_project(session, project_id)

    if title is not None:
        project.title = title
    if description is not None:
        project.description = description

    # 如果提供了新封面，替换原有封面
    if cover_file:
        # 删除旧封面（如果存在）
        if project.cover_path:
            delete_cover_file(project.id)
        # 保存新封面
        cover_path = await save_cover_file(project.id, cover_file)
        project.cover_path = cover_path

    project.updated_at = datetime.now(UTC)
    return await project_repo.update(session, project)


async def delete_project(session: AsyncSession, project_id: str) -> None:
    """
    删除项目。

    Args:
        session: 数据库 session。
        project_id: 项目 ID。

    Raises:
        NotFoundError: 项目不存在。
    """
    project = await get_project(session, project_id)

    # Story Memory 的向量文档由人物 / 世界设定 / 大纲 / 笔记源行派生，必须在这些
    # 源行删除前清理，否则文档 ID 无法再定位。清理为 best-effort，且只作用于该
    # 项目的 index_key，不影响其它项目向量。
    from app.retrieval.story_memory import delete_project_story_memory_documents

    await delete_project_story_memory_documents(session, project_id=project_id)

    # 项目私有的审计、索引状态、摘要、写作事件、大纲与项目级规则先删，
    # 它们引用任务 / 章节 / 版本 / 项目等父行，必须在父行删除前清理。
    await llm_audit_log_repo.delete_by_project(session, project_id)
    await retrieval_chapter_index_state_repo.delete_by_project(session, project_id)
    await chapter_summary_repo.delete_by_project(session, project_id)
    await writing_activity_repo.delete_by_project(session, project_id)
    await outline_repo.delete_by_project(session, project_id)
    await agent_rule_repo.delete_by_project(session, project_id)

    await task_service.delete_all_tasks(session, project_id)
    await delete_revision_data_by_project(session, project_id)

    # 先删除扩展数据，避免外键与孤立记录
    await character_extension_repo.delete_states_by_project(session, project_id)
    await character_extension_repo.delete_profiles_by_project(session, project_id)
    await world_entry_meta_repo.delete_by_project(session, project_id)

    # 删除项目下的角色，并清理角色头像文件
    characters = await character_repo.list_all_by_project(session, project_id)
    await character_repo.batch_delete(
        session, project_id, [character.id for character in characters]
    )
    for character in characters:
        if character.image_path:
            delete_character_image(character.image_path)

    # 先删笔记再删分类，避免留下引用已删除分类的笔记
    await note_repo.delete_by_project(session, project_id)
    await note_category_repo.delete_by_project(session, project_id)

    # 删除项目关联的世界书及其条目
    world_info = await world_info_repo.get_by_project_id(session, project_id)
    if world_info is not None:
        await world_info_entry_repo.delete_by_world_info(session, world_info.id)
        await world_info_repo.delete(session, world_info)

    # 删除项目下的所有章节；章节行删除前先清理检索索引中的章节向量文档，
    # 避免章节行消失后遗留无法定位的孤儿向量。索引清理为 best-effort，
    # 且只作用于该项目的 index_key，不影响其它项目向量。
    chapters = await chapter_repo.list_metadata_by_project(session, project_id)
    from app.retrieval.chapter_index import ChapterIndexIntegrationService

    await ChapterIndexIntegrationService().delete_project_index_documents(
        session,
        project_id=project_id,
        chapter_ids=[chapter.id for chapter in chapters],
    )

    await chapter_meta_repo.delete_by_project(session, project_id)
    await chapter_repo.delete_by_project(session, project_id)
    await volume_repo.delete_by_project(session, project_id)
    await project_profile_repo.delete_by_project(session, project_id)

    # 删除封面文件（如果存在）
    if project.cover_path:
        delete_cover_file(project.id)

    await project_repo.delete(session, project)
