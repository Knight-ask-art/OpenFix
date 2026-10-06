from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.context import character as tools


@pytest.mark.asyncio
async def test_short_name_suggests_full_name_without_resolving_or_writing(monkeypatch):
    rows = [SimpleNamespace(name="示例甲·某姓"), SimpleNamespace(name="示例乙")]
    lookup = AsyncMock(return_value=rows)
    monkeypatch.setattr(tools, "_list_project_characters", lookup)
    session = object()
    with pytest.raises(ToolExecutionError, match="请使用完整名称") as error:
        await tools._resolve_character_by_name(session, "project-a", "示例甲")
    assert "示例甲·某姓" in str(error.value)
    assert "示例乙" not in str(error.value)
    lookup.assert_awaited_once_with(session, "project-a")


@pytest.mark.asyncio
async def test_exact_name_still_wins_over_partial_candidates(monkeypatch):
    exact = SimpleNamespace(name="示例甲")
    monkeypatch.setattr(
        tools, "_list_project_characters",
        AsyncMock(return_value=[exact, SimpleNamespace(name="示例甲·某姓")]),
    )
    assert await tools._resolve_character_by_name(object(), "project-a", " 示例甲 ") is exact


@pytest.mark.asyncio
async def test_unknown_name_does_not_dump_project_inventory(monkeypatch):
    monkeypatch.setattr(
        tools, "_list_project_characters",
        AsyncMock(return_value=[SimpleNamespace(name="示例甲")]),
    )
    with pytest.raises(ToolExecutionError, match="list_characters") as error:
        await tools._resolve_character_by_name(object(), "project-a", "无匹配名称")
    assert "示例甲" not in str(error.value)


@pytest.mark.asyncio
async def test_suggestions_are_bounded_and_ambiguous_names_stay_errors(monkeypatch):
    rows = [SimpleNamespace(name=f"示例甲·姓氏{index}") for index in range(10)]
    monkeypatch.setattr(tools, "_list_project_characters", AsyncMock(return_value=rows))
    with pytest.raises(ToolExecutionError) as error:
        await tools._resolve_character_by_name(object(), "project-a", "示例甲")
    assert "姓氏4" in str(error.value)
    assert "姓氏5" not in str(error.value)
    monkeypatch.setattr(
        tools, "_list_project_characters",
        AsyncMock(return_value=[SimpleNamespace(name="重名"), SimpleNamespace(name="重名")]),
    )
    with pytest.raises(ToolExecutionError, match="角色名称不唯一"):
        await tools._resolve_character_by_name(object(), "project-a", "重名")
