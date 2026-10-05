from unittest.mock import AsyncMock, patch

import pytest

from app.core.editor_content_limits import EditorContentLimitError
from app.storage.services.world_info_entry_service import (
    WorldInfoImportEntry,
    import_entries,
    create_entry,
    update_entry,
)
from app.storage.models.world_info_entry import WorldInfoEntry


@pytest.mark.asyncio
async def test_create_derives_token_count_from_content():
    with (
        patch('app.storage.services.world_info_entry_service.get_world_info', AsyncMock()),
        patch('app.storage.services.world_info_entry_service._get_existing_entry_names', AsyncMock(return_value=set())),
        patch('app.storage.services.world_info_entry_service.world_info_entry_repo.get_max_uid', AsyncMock(return_value=0)),
        patch('app.storage.services.world_info_entry_service.world_info_entry_repo.get_max_order', AsyncMock(return_value=0)),
        patch('app.storage.services.world_info_entry_service.world_info_entry_repo.create', AsyncMock(side_effect=lambda session, entry: entry)),
        patch('app.storage.services.world_info_entry_service._calculate_token_count', return_value=42),
    ):
        entry = await create_entry(AsyncMock(), 'world', 'Example', content='Actual content', token_count=0)
        assert entry.token_count == 42


@pytest.mark.asyncio
async def test_update_recalculates_tokens_without_caller_count():
    entry = WorldInfoEntry(world_info_id='world', uid=1, name='Example', content='old', token_count=1, order=1)
    with (
        patch('app.storage.services.world_info_entry_service.get_entry', AsyncMock(return_value=entry)),
        patch('app.storage.services.world_info_entry_service.world_info_entry_repo.update_entry', AsyncMock(side_effect=lambda session, value: value)),
        patch('app.storage.services.world_info_entry_service._calculate_token_count', return_value=52),
    ):
        result = await update_entry(AsyncMock(), entry.id, content='New content')
        assert result.token_count == 52


@pytest.mark.asyncio
async def test_overwrite_import_validates_all_entries_before_deleting_existing_entries() -> None:
    session = AsyncMock()
    entries = [
        WorldInfoImportEntry(
            uid=1,
            name="超限条目",
            content="\n".join("内容" for _ in range(2001)),
            is_enabled=True,
            order=1,
        )
    ]

    with (
        patch(
            "app.storage.services.world_info_entry_service.get_world_info",
            AsyncMock(),
        ),
        patch(
            "app.storage.services.world_info_entry_service.world_info_entry_repo.delete_by_world_info",
            AsyncMock(),
        ) as delete_entries,
    ):
        with pytest.raises(EditorContentLimitError, match="内容超出限制"):
            await import_entries(session, "world-1", entries, mode="overwrite")

    delete_entries.assert_not_awaited()

