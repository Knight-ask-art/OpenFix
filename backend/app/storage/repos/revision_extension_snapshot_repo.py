# -*- coding: utf-8 -*-
"""Revision extension snapshot repositories."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.storage.models.revision_extension_snapshot import RevisionExtensionSnapshot


async def create(
    session: AsyncSession,
    snapshot: RevisionExtensionSnapshot,
) -> RevisionExtensionSnapshot:
    session.add(snapshot)
    await session.flush()
    await session.refresh(snapshot)
    return snapshot


async def list_by_revision(
    session: AsyncSession,
    revision_id: str,
) -> list[RevisionExtensionSnapshot]:
    result = await session.execute(
        select(RevisionExtensionSnapshot)
        .where(col(RevisionExtensionSnapshot.revision_id) == revision_id)
        .order_by(col(RevisionExtensionSnapshot.created_at).asc())
    )
    return list(result.scalars().all())
