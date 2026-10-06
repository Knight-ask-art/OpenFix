from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from app.storage.models.character_belief import CharacterBelief
from app.storage.models.plotline import Plotline
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.world_fact import WorldFact
from app.storage.repos import narrative_repo
from tests.api.test_narrative_engine import (
    _create_character,
    _create_chapter,
    _create_project,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("collection", "model", "getter_name", "text_field"),
    [
        ("world-facts", WorldFact, "get_world_fact", "statement"),
        ("character-beliefs", CharacterBelief, "get_character_belief", "proposition"),
        ("plotlines", Plotline, "get_plotline", "title"),
        ("scene-plans", ScenePlan, "get_scene_plan", "goal"),
    ],
)
async def test_confirmation_rejects_change_between_read_and_write(
    client, monkeypatch, collection, model, getter_name, text_field,
):
    project_id = await _create_project(client)
    payload = {text_field: "等待确认的内容"}
    if model is CharacterBelief:
        payload["character_id"] = await _create_character(client, project_id)
    elif model is ScenePlan:
        payload["chapter_id"] = await _create_chapter(client, project_id)
    base = f"/api/v1/projects/{project_id}/narrative/{collection}"
    response = await client.post(base, json=payload)
    assert response.status_code == 201
    created = response.json()
    getter = getattr(narrative_repo, getter_name)
    changed = False

    async def get_then_change(session, scoped_project_id, item_id):
        nonlocal changed
        row = await getter(session, scoped_project_id, item_id)
        if row is not None and not changed:
            changed = True
            # Deterministic interleaving: keep the read object stale while a later
            # committed SQL write changes the persisted candidate before confirmation.
            await session.execute(
                update(model)
                .where(model.id == item_id, model.project_id == scoped_project_id)
                .values(**{
                    text_field: "读取后被修改的内容",
                    "updated_at": datetime.now(UTC) + timedelta(seconds=1),
                })
                .execution_options(synchronize_session=False)
            )
            await session.commit()
        return row

    monkeypatch.setattr(narrative_repo, getter_name, get_then_change)
    confirmed = await client.post(
        f"{base}/{created['id']}/confirm",
        json={"expected_updated_at": created["updated_at"]},
    )
    assert confirmed.status_code == 409
    current = (await client.get(f"{base}/{created['id']}")).json()
    assert current["confirmation"] == "candidate"
    assert current[text_field] == "读取后被修改的内容"
