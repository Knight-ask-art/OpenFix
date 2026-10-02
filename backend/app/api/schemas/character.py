# -*- coding: utf-8 -*-
"""Character API Schemas - 角色请求/响应模型。"""

from datetime import datetime

from pydantic import BaseModel, Field


class CharacterResponse(BaseModel):
    """角色响应。"""

    id: str = Field(description="角色 ID")
    project_id: str = Field(description="所属项目 ID")
    name: str = Field(description="角色名称")
    description: str = Field(description="角色描述")
    image_url: str | None = Field(description="角色头像 URL")
    is_favorited: bool = Field(description="是否收藏")
    created_at: datetime = Field(description="创建时间")
    updated_at: datetime = Field(description="更新时间")


class CharacterListItemResponse(BaseModel):
    """角色列表项响应。"""

    id: str = Field(description="角色 ID")
    project_id: str = Field(description="所属项目 ID")
    name: str = Field(description="角色名称")
    image_url: str | None = Field(description="角色头像 URL")
    token_count: int = Field(description="角色描述 Token 数")
    is_favorited: bool = Field(description="是否收藏")
    created_at: datetime = Field(description="创建时间")
    updated_at: datetime = Field(description="更新时间")


class CharacterListResponse(BaseModel):
    """角色列表响应。"""

    items: list[CharacterListItemResponse] = Field(description="角色列表")
    total: int = Field(description="总数")


class CharacterSearchMatch(BaseModel):
    """角色搜索匹配项。"""

    line_number: int = Field(description="匹配行号（从 1 开始）")
    line_text: str = Field(description="匹配行文本")


class CharacterSearchResult(BaseModel):
    """单个角色的搜索结果。"""

    character_id: str = Field(description="角色 ID")
    character_name: str = Field(description="角色名称")
    matches: list[CharacterSearchMatch] = Field(description="匹配项列表")


class CharacterSearchResponse(BaseModel):
    """角色搜索响应。"""

    results: list[CharacterSearchResult] = Field(description="搜索结果列表")
    total_characters: int = Field(description="匹配的角色总数")
    total_matches: int = Field(description="匹配项总数")


class CharacterBatchFavoriteRequest(BaseModel):
    """批量收藏角色请求。"""

    character_ids: list[str] = Field(min_length=1, description="要更新的角色 ID 列表")
    is_favorited: bool = Field(description="目标收藏状态")


class CharacterBatchDeleteRequest(BaseModel):
    """批量删除角色请求。"""

    character_ids: list[str] = Field(min_length=1, description="要删除的角色 ID 列表")


class CharacterBatchFavoriteResponse(BaseModel):
    """批量收藏角色响应。"""

    updated_count: int = Field(description="已更新的角色数量")


class CharacterBatchDeleteResponse(BaseModel):
    """批量删除角色响应。"""

    deleted_count: int = Field(description="已删除的角色数量")


class CharacterProfileFields(BaseModel):
    """人物作者扩展字段（全部为可选的自由文本）。"""

    alias: str = Field(default="", max_length=200, description="别名")
    age: str = Field(default="", max_length=100, description="年龄")
    gender: str = Field(default="", max_length=50, description="性别")
    identity: str = Field(default="", max_length=200, description="身份")
    faction: str = Field(default="", max_length=200, description="阵营")
    personality: str = Field(default="", description="性格")
    appearance: str = Field(default="", description="外貌")
    background: str = Field(default="", description="背景")
    goal: str = Field(default="", description="目标")
    motivation: str = Field(default="", description="动机")
    fear: str = Field(default="", description="恐惧")
    secret: str = Field(default="", description="秘密")
    abilities: str = Field(default="", description="能力")
    weakness: str = Field(default="", description="弱点")
    arc: str = Field(default="", description="人物弧")


class CharacterProfileResponse(CharacterProfileFields):
    """人物扩展字段响应。"""

    character_id: str = Field(description="角色 ID")
    updated_at: datetime = Field(description="更新时间")


class CharacterProfileUpdateRequest(CharacterProfileFields):
    """更新人物扩展字段（整体覆盖，未提供的字段清空）。"""


class CharacterStateFields(BaseModel):
    """人物动态状态字段。"""

    location: str = Field(default="", max_length=200, description="当前地点")
    physical_state: str = Field(default="", max_length=500, description="身体状态")
    mental_state: str = Field(default="", max_length=500, description="心理状态")
    goal: str = Field(default="", max_length=500, description="当前目标")
    relationship_note: str = Field(default="", max_length=500, description="当前关系变化")
    notes: str = Field(default="", description="备注")


class CharacterStateResponse(CharacterStateFields):
    """人物动态状态响应。"""

    id: str = Field(description="状态 ID")
    character_id: str = Field(description="角色 ID")
    project_id: str = Field(description="所属项目 ID")
    chapter_id: str | None = Field(default=None, description="关联章节 ID，空表示项目级最新状态")
    created_at: datetime = Field(description="创建时间")
    updated_at: datetime = Field(description="更新时间")


class CharacterStateUpdateRequest(CharacterStateFields):
    """更新角色在指定章节的状态（未提供章节则更新项目级最新状态）。"""

    chapter_id: str | None = Field(default=None, description="关联章节 ID")


class CharacterStateListResponse(BaseModel):
    """人物动态状态列表响应。"""

    items: list[CharacterStateResponse] = Field(description="状态列表")
    total: int = Field(description="总数")
