# -*- coding: utf-8 -*-
"""
Story Memory retrieval - 把人物、世界设定、大纲、笔记与叙事状态统一索引到独立检索表。

与章节索引共用 OpenFicRetrievalService（同一 LanceDB 引擎与 contract 机制），
只是 index_key 与文档来源不同；story memory 内容体量小，采用全量重建策略。

新鲜度判定不看正文，而是看一组「来源令牌」（文档 ID + updated_at + 可见性 /
确认状态）。这样每次检索与状态查询都不必把全部正文重新读一遍，同时仍然能
精确捕捉增删改与可见性切换：写入路径都会推进 updated_at，而可见性与确认状态
本身就是令牌的一部分。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from app.background.jobs import service as background_service
from app.background.jobs.constants import JOB_TYPE_STORY_MEMORY_REBUILD
from app.background.jobs.states import JOB_STATUS_PENDING, JOB_STATUS_RUNNING
from app.retrieval.chapter_index import (
    DEFAULT_INDEX_CHUNK_OVERLAP,
    DEFAULT_INDEX_CHUNK_SIZE,
    resolve_index_embedding_model,
    get_index_settings,
)
from app.retrieval.narrative_memory import (
    NARRATIVE_SOURCES,
    character_belief_is_retrievable,
    format_source_token,
    plotline_is_retrievable,
    render_character_belief,
    render_plotline,
    render_scene_plan,
    render_world_fact,
    scene_plan_is_retrievable,
    world_fact_is_retrievable,
)
from app.retrieval.service import OpenFicRetrievalService
from app.retrieval.types import (
    FilterableField,
    FilterableFieldType,
    IndexDocument,
    RetrievalIndexContract,
)
from app.storage.repos import (
    chapter_repo,
    character_extension_repo,
    character_repo,
    narrative_repo,
    note_repo,
    outline_repo,
    retrieval_index_repo,
    world_info_entry_repo,
    world_info_repo,
    world_entry_meta_repo,
)
from app.storage.models.character import Character
from app.storage.models.character_profile import CharacterProfile
from app.storage.models.character_state import CharacterState
from app.storage.models.character_belief import CharacterBelief
from app.storage.models.note import Note
from app.storage.models.outline import Outline
from app.storage.models.plotline import Plotline
from app.storage.models.retrieval_index import RetrievalIndex
from app.storage.models.scene_plan import ScenePlan
from app.storage.models.world_fact import WorldFact
from app.storage.models.world_info_entry import WorldInfoEntry

LEGACY_STORY_MEMORY_SOURCES = ("character", "world_entry", "outline", "note")

STORY_MEMORY_SOURCES = (*LEGACY_STORY_MEMORY_SOURCES, *NARRATIVE_SOURCES)

# 人物扩展字段中会进入 Story Memory 的字段，按「标签：值」拼接。
CHARACTER_PROFILE_LABELS: tuple[tuple[str, str], ...] = (
    ("alias", "别名"),
    ("gender", "性别"),
    ("age", "年龄"),
    ("identity", "身份"),
    ("faction", "阵营"),
    ("personality", "性格"),
    ("appearance", "外貌"),
    ("background", "背景"),
    ("goal", "目标"),
    ("motivation", "动机"),
    ("fear", "恐惧"),
    ("secret", "秘密"),
    ("abilities", "能力"),
    ("weakness", "弱点"),
    ("arc", "人物弧"),
)

CHARACTER_STATE_LABELS: tuple[tuple[str, str], ...] = (
    ("location", "当前地点"),
    ("physical_state", "身体状态"),
    ("mental_state", "心理状态"),
    ("goal", "当前目标"),
    ("relationship_note", "关系变化"),
)


def story_memory_index_key(project_id: str) -> str:
    return f"story_memory:{project_id}"


def world_entry_is_indexable(*, is_enabled: bool, ai_visible: bool) -> bool:
    """世界书条目是否进入 Story Memory：启用且对 AI 可见。"""
    return bool(is_enabled) and bool(ai_visible)


def note_is_indexable(*, is_hidden: bool) -> bool:
    """笔记是否进入 Story Memory：未被作者标记为隐藏。"""
    return not is_hidden


def story_document_id(source: str, entity_id: str) -> str:
    return f"{source}:{entity_id}"


def _join_parts(*parts: str) -> str:
    return "\n".join(part for part in parts if part.strip())


async def _hidden_world_entry_ids(session: AsyncSession, project_id: str) -> set[str]:
    metadata = await world_entry_meta_repo.list_by_project(session, project_id)
    return {item.entry_id for item in metadata if not item.ai_visible}


async def build_story_memory_documents(
    session: AsyncSession, project_id: str
) -> list[IndexDocument]:
    """收集项目内人物、世界设定、大纲、笔记与已确认的叙事状态，构建待索引文档。"""
    documents: list[IndexDocument] = []

    characters = await character_repo.list_all_by_project(session, project_id)
    character_ids = [character.id for character in characters]
    profiles = await character_extension_repo.get_profiles_by_character_ids(
        session, character_ids
    )
    states = await character_extension_repo.get_latest_project_states_by_character_ids(
        session, character_ids
    )
    for character in characters:
        profile = profiles.get(character.id)
        state = states.get(character.id)
        profile_lines: list[str] = []
        if profile is not None:
            for field, label in CHARACTER_PROFILE_LABELS:
                value = (getattr(profile, field, "") or "").strip()
                if value:
                    profile_lines.append(f"{label}：{value}")
        if state is not None:
            for field, label in CHARACTER_STATE_LABELS:
                value = (getattr(state, field, "") or "").strip()
                if value:
                    profile_lines.append(f"{label}：{value}")
        text = _join_parts(
            f"人物：{character.name}",
            character.description,
            "\n".join(profile_lines),
        )
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("character", character.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "character"},
                    metadata={"source": "character", "entity_id": character.id},
                )
            )

    world_info = await world_info_repo.get_by_project_id(session, project_id)
    if world_info is not None:
        hidden_entry_ids = await _hidden_world_entry_ids(session, project_id)
        for entry in await world_info_entry_repo.list_enabled_by_world_info(
            session, world_info.id
        ):
            if entry.id in hidden_entry_ids:
                continue
            text = _join_parts(
                f"世界设定：{entry.name}",
                entry.content,
            )
            if text.strip():
                documents.append(
                    IndexDocument(
                        document_id=story_document_id("world_entry", entry.id),
                        text=text,
                        attributes={"project_id": project_id, "source": "world_entry"},
                        metadata={"source": "world_entry", "entity_id": entry.id},
                    )
                )

    for outline in await outline_repo.list_by_project(session, project_id):
        text = _join_parts(
            f"大纲[{outline.level}]：{outline.title}",
            outline.content,
        )
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("outline", outline.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "outline"},
                    metadata={"source": "outline", "entity_id": outline.id},
                )
            )

    for note in await note_repo.list_by_project(
        session, project_id, include_hidden=False
    ):
        text = _join_parts(
            f"笔记：{note.title}",
            note.content,
        )
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("note", note.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "note"},
                    metadata={"source": "note", "entity_id": note.id},
                )
            )

    documents.extend(
        await _build_narrative_documents(
            session, project_id, characters_by_id={c.id: c for c in characters}
        )
    )

    return documents


async def _list_all_pages(fetch) -> list:
    """翻页读取全部行，避开仓储层的单页上限。"""
    items, total = await fetch(0)
    collected = list(items)
    offset = len(collected)
    while collected and offset < total:
        page, _ = await fetch(offset)
        if not page:
            break
        collected.extend(page)
        offset += len(page)
    return collected


async def _build_narrative_documents(
    session: AsyncSession,
    project_id: str,
    *,
    characters_by_id: dict[str, object],
) -> list[IndexDocument]:
    """构建叙事状态的检索文档（世界事实 / 人物信念 / 情节线 / 场景计划）。

    默认只索引**已确认**且未被取代 / 作废的记录：候选、推断、拒绝以及已退役的
    行不进入向量库，因此也不会以任何形式进入模型上下文。已确认的误解仍然作为
    「人物信念」被索引，它的文本标注会明确写出这是人物主观认知。
    """
    documents: list[IndexDocument] = []

    world_facts = await _list_all_pages(
        lambda offset: narrative_repo.list_world_facts(
            session, project_id, limit=narrative_repo.MAX_PAGE_SIZE, offset=offset
        )
    )
    for fact in world_facts:
        if not world_fact_is_retrievable(
            confirmation=fact.confirmation,
            status=fact.status,
            superseded_by_id=fact.superseded_by_id,
        ):
            continue
        text = render_world_fact(fact)
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("world_fact", fact.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "world_fact"},
                    metadata={"source": "world_fact", "entity_id": fact.id},
                )
            )

    beliefs = await _list_all_pages(
        lambda offset: narrative_repo.list_character_beliefs(
            session, project_id, limit=narrative_repo.MAX_PAGE_SIZE, offset=offset
        )
    )
    for belief in beliefs:
        if not character_belief_is_retrievable(
            confirmation=belief.confirmation,
            superseded_by_id=belief.superseded_by_id,
            invalidated_at=belief.invalidated_at,
        ):
            continue
        holder = characters_by_id.get(belief.character_id)
        text = render_character_belief(
            belief, getattr(holder, "name", None) if holder is not None else None
        )
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("character_belief", belief.id),
                    text=text,
                    attributes={
                        "project_id": project_id,
                        "source": "character_belief",
                    },
                    metadata={
                        "source": "character_belief",
                        "entity_id": belief.id,
                        "character_id": belief.character_id,
                    },
                )
            )

    plotlines = await _list_all_pages(
        lambda offset: narrative_repo.list_plotlines(
            session, project_id, limit=narrative_repo.MAX_PAGE_SIZE, offset=offset
        )
    )
    for plotline in plotlines:
        if not plotline_is_retrievable(
            confirmation=plotline.confirmation, state=plotline.state
        ):
            continue
        text = render_plotline(plotline)
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("open_plotline", plotline.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "open_plotline"},
                    metadata={"source": "open_plotline", "entity_id": plotline.id},
                )
            )

    scene_plans = await _list_all_pages(
        lambda offset: narrative_repo.list_scene_plans(
            session, project_id, limit=narrative_repo.MAX_PAGE_SIZE, offset=offset
        )
    )
    scene_chapter_ids = list(
        dict.fromkeys(plan.chapter_id for plan in scene_plans if plan.chapter_id)
    )
    chapters_by_id: dict[str, object] = {}
    if scene_chapter_ids:
        for chapter in await chapter_repo.get_by_ids(session, scene_chapter_ids):
            if chapter.project_id == project_id:
                chapters_by_id[chapter.id] = chapter
    for plan in scene_plans:
        if not scene_plan_is_retrievable(confirmation=plan.confirmation):
            continue
        chapter = chapters_by_id.get(plan.chapter_id)
        pov = characters_by_id.get(plan.pov_character_id or "")
        text = render_scene_plan(
            plan,
            chapter_title=getattr(chapter, "title", None) if chapter else None,
            pov_character_name=getattr(pov, "name", None) if pov else None,
        )
        if text.strip():
            documents.append(
                IndexDocument(
                    document_id=story_document_id("scene_state", plan.id),
                    text=text,
                    attributes={"project_id": project_id, "source": "scene_state"},
                    metadata={"source": "scene_state", "entity_id": plan.id},
                )
            )

    return documents


def fingerprint_story_memory_documents(documents: list[IndexDocument]) -> str:
    """Return a stable fingerprint for the exact source documents being indexed.

    这是**逐字**指纹：它哈希完整文档文本，只在需要证明「被嵌入的正文一字未变」
    时使用（例如诊断）。索引新鲜度判定走 `fingerprint_story_memory_sources`，
    那条路径不读正文。
    """
    canonical_documents = [
        document.model_dump(mode="json")
        for document in sorted(documents, key=lambda item: item.document_id)
    ]
    serialized = json.dumps(
        canonical_documents,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def fingerprint_story_memory_sources(tokens: dict[str, str]) -> str:
    """哈希「文档 ID -> 来源令牌」映射，得到索引快照指纹。"""
    serialized = "\n".join(
        f"{document_id}\t{tokens[document_id]}" for document_id in sorted(tokens)
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


async def collect_story_memory_source_tokens(
    session: AsyncSession, project_id: str
) -> dict[str, str]:
    """收集当前应当被索引的文档及其来源令牌，**不读取正文**。

    只取 `id` / `updated_at` 与可见性、确认状态这类短列。令牌集合与
    `build_story_memory_documents` 的文档集合刻意保持同一套可用性判定，
    因此指纹变化与文档变化一一对应：任何正文改动都会推进 `updated_at`，
    任何可见性 / 确认状态切换都会改变令牌中的标志位，而增删会改变 ID 集合。
    """
    tokens: dict[str, str] = {}

    character_rows = (
        await session.execute(
            select(col(Character.id), col(Character.updated_at)).where(
                col(Character.project_id) == project_id
            )
        )
    ).all()
    character_ids = [row[0] for row in character_rows]
    if character_ids:
        profile_rows = (
            await session.execute(
                select(
                    col(CharacterProfile.character_id),
                    col(CharacterProfile.id),
                    col(CharacterProfile.updated_at),
                ).where(col(CharacterProfile.character_id).in_(character_ids))
            )
        ).all()
        state_rows = (
            await session.execute(
                select(
                    col(CharacterState.character_id),
                    col(CharacterState.id),
                    col(CharacterState.updated_at),
                ).where(
                    col(CharacterState.project_id) == project_id,
                    col(CharacterState.chapter_id).is_(None),
                )
            )
        ).all()
    else:
        profile_rows = []
        state_rows = []

    profiles_by_character = {
        row[0]: format_source_token(row[2], row[1]) for row in profile_rows
    }
    states_by_character: dict[str, list[str]] = {}
    for character_id, state_id, updated_at in state_rows:
        states_by_character.setdefault(character_id, []).append(
            format_source_token(updated_at, state_id)
        )
    for character_id, updated_at in character_rows:
        state_tokens = ",".join(sorted(states_by_character.get(character_id, ())))
        tokens[story_document_id("character", character_id)] = format_source_token(
            updated_at,
            profiles_by_character.get(character_id, "-"),
            state_tokens or "-",
        )

    world_info = await world_info_repo.get_by_project_id(session, project_id)
    if world_info is not None:
        meta_by_entry = {
            meta.entry_id: meta
            for meta in await world_entry_meta_repo.list_by_project(session, project_id)
        }
        entry_rows = (
            await session.execute(
                select(
                    col(WorldInfoEntry.id),
                    col(WorldInfoEntry.updated_at),
                    col(WorldInfoEntry.is_enabled),
                ).where(col(WorldInfoEntry.world_info_id) == world_info.id)
            )
        ).all()
        for entry_id, updated_at, is_enabled in entry_rows:
            meta = meta_by_entry.get(entry_id)
            ai_visible = meta.ai_visible if meta is not None else True
            if not world_entry_is_indexable(
                is_enabled=bool(is_enabled), ai_visible=bool(ai_visible)
            ):
                continue
            tokens[story_document_id("world_entry", entry_id)] = format_source_token(
                updated_at,
                f"enabled={bool(is_enabled)}",
                f"ai_visible={bool(ai_visible)}",
                format_source_token(meta.updated_at, meta.id) if meta is not None else "-",
            )

    outline_rows = (
        await session.execute(
            select(col(Outline.id), col(Outline.updated_at)).where(
                col(Outline.project_id) == project_id
            )
        )
    ).all()
    for outline_id, updated_at in outline_rows:
        tokens[story_document_id("outline", outline_id)] = format_source_token(
            updated_at
        )

    note_rows = (
        await session.execute(
            select(col(Note.id), col(Note.updated_at), col(Note.is_hidden)).where(
                col(Note.project_id) == project_id
            )
        )
    ).all()
    for note_id, updated_at, is_hidden in note_rows:
        if not note_is_indexable(is_hidden=bool(is_hidden)):
            continue
        tokens[story_document_id("note", note_id)] = format_source_token(
            updated_at, f"hidden={bool(is_hidden)}"
        )

    fact_rows = (
        await session.execute(
            select(
                col(WorldFact.id),
                col(WorldFact.updated_at),
                col(WorldFact.confirmation),
                col(WorldFact.status),
                col(WorldFact.superseded_by_id),
            ).where(col(WorldFact.project_id) == project_id)
        )
    ).all()
    for fact_id, updated_at, confirmation, status, superseded_by_id in fact_rows:
        if not world_fact_is_retrievable(
            confirmation=confirmation,
            status=status,
            superseded_by_id=superseded_by_id,
        ):
            continue
        tokens[story_document_id("world_fact", fact_id)] = format_source_token(
            updated_at, confirmation, status, superseded_by_id or "-"
        )

    belief_rows = (
        await session.execute(
            select(
                col(CharacterBelief.id),
                col(CharacterBelief.updated_at),
                col(CharacterBelief.confirmation),
                col(CharacterBelief.superseded_by_id),
                col(CharacterBelief.invalidated_at),
            ).where(col(CharacterBelief.project_id) == project_id)
        )
    ).all()
    for belief_id, updated_at, confirmation, superseded_by_id, invalidated_at in (
        belief_rows
    ):
        if not character_belief_is_retrievable(
            confirmation=confirmation,
            superseded_by_id=superseded_by_id,
            invalidated_at=invalidated_at,
        ):
            continue
        tokens[story_document_id("character_belief", belief_id)] = format_source_token(
            updated_at, confirmation, superseded_by_id or "-", invalidated_at or "-"
        )

    plotline_rows = (
        await session.execute(
            select(
                col(Plotline.id),
                col(Plotline.updated_at),
                col(Plotline.confirmation),
                col(Plotline.state),
            ).where(col(Plotline.project_id) == project_id)
        )
    ).all()
    for plotline_id, updated_at, confirmation, state in plotline_rows:
        if not plotline_is_retrievable(confirmation=confirmation, state=state):
            continue
        tokens[story_document_id("open_plotline", plotline_id)] = format_source_token(
            updated_at, confirmation, state
        )

    scene_rows = (
        await session.execute(
            select(
                col(ScenePlan.id),
                col(ScenePlan.updated_at),
                col(ScenePlan.confirmation),
            ).where(col(ScenePlan.project_id) == project_id)
        )
    ).all()
    for plan_id, updated_at, confirmation in scene_rows:
        if not scene_plan_is_retrievable(confirmation=confirmation):
            continue
        tokens[story_document_id("scene_state", plan_id)] = format_source_token(
            updated_at, confirmation
        )

    return tokens


async def story_memory_index_is_fresh(
    session: AsyncSession,
    *,
    project_id: str,
    index_row: RetrievalIndex | None = None,
    tokens: dict[str, str] | None = None,
) -> bool:
    """Whether a ready Story Memory index represents the current source snapshot.

    Rows created before source fingerprints were introduced are stale until the
    next successful rebuild. Comparison uses the cheap source tokens rather than
    the document text: insertions and deletions change the ID set, content edits
    advance `updated_at`, and visibility / confirmation switches are part of the
    token, so the check stays exact without re-reading every source body.
    """
    row = index_row or await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    if row is None or row.status != "ready" or not row.source_fingerprint:
        return False
    current_tokens = (
        tokens
        if tokens is not None
        else await collect_story_memory_source_tokens(session, project_id)
    )
    return fingerprint_story_memory_sources(current_tokens) == row.source_fingerprint


def build_story_memory_contract(model) -> RetrievalIndexContract:
    if model.dimensions is None:
        raise ValueError("default_embedding_model 必须提供 embedding dimensions")
    return RetrievalIndexContract(
        embedding_model_ref_id=model.id,
        embedding_model_id_snapshot=model.model_id,
        embedding_dimensions_snapshot=model.dimensions,
        distance_metric="cosine",
        chunker_type="recursive_character",
        chunk_size=DEFAULT_INDEX_CHUNK_SIZE,
        chunk_overlap=DEFAULT_INDEX_CHUNK_OVERLAP,
        filterable_fields=[
            FilterableField(name="project_id", field_type=FilterableFieldType.STRING),
            FilterableField(name="source", field_type=FilterableFieldType.STRING),
        ],
    )


async def ensure_story_memory_index(
    session: AsyncSession, project_id: str, model
) -> None:
    service = OpenFicRetrievalService()
    await service.register_index(
        session,
        story_memory_index_key(project_id),
        build_story_memory_contract(model),
        replace_contract_if_needs_rebuild=True,
    )


@dataclass
class StoryMemorySourceCounts:
    characters: int = 0
    world_entries: int = 0
    outlines: int = 0
    notes: int = 0
    chapters: int = 0


@dataclass
class StoryMemoryStatus:
    project_id: str
    embedding_configured: bool
    index_status: str
    last_error: str | None = None
    last_ready_at: datetime | None = None
    rebuild_job_status: str | None = None
    counts: StoryMemorySourceCounts = field(default_factory=StoryMemorySourceCounts)

    def to_payload(self) -> dict[str, object]:
        return {
            "project_id": self.project_id,
            "embedding_configured": self.embedding_configured,
            "index_status": self.index_status,
            "last_error": self.last_error,
            "last_ready_at": self.last_ready_at,
            "rebuild_job_status": self.rebuild_job_status,
            "counts": {
                "characters": self.counts.characters,
                "world_entries": self.counts.world_entries,
                "outlines": self.counts.outlines,
                "notes": self.counts.notes,
                "chapters": self.counts.chapters,
            },
        }


async def compute_story_memory_status(
    session: AsyncSession, *, project_id: str
) -> StoryMemoryStatus:
    config = await get_index_settings(session)
    model = await resolve_index_embedding_model(session, config)

    counts = StoryMemorySourceCounts(
        characters=len(await character_repo.list_all_by_project(session, project_id)),
        chapters=await chapter_repo.count_by_project(session, project_id),
        outlines=len(await outline_repo.list_by_project(session, project_id)),
        notes=len(
            await note_repo.list_by_project(session, project_id, include_hidden=False)
        ),
    )
    world_info = await world_info_repo.get_by_project_id(session, project_id)
    if world_info is not None:
        hidden_entry_ids = await _hidden_world_entry_ids(session, project_id)
        visible_entries = 0
        for entry in await world_info_entry_repo.list_enabled_by_world_info(
            session, world_info.id
        ):
            if entry.id not in hidden_entry_ids:
                visible_entries += 1
        counts.world_entries = visible_entries

    index_row = await retrieval_index_repo.get_by_index_key(
        session, story_memory_index_key(project_id)
    )
    index_status = index_row.status if index_row is not None else "not_created"
    if index_row is not None and index_row.status == "ready":
        if not await story_memory_index_is_fresh(
            session,
            project_id=project_id,
            index_row=index_row,
        ):
            index_status = "stale"
    active_jobs = await background_service.list_jobs(
        session,
        subject_type="project",
        subject_id=project_id,
        job_type=JOB_TYPE_STORY_MEMORY_REBUILD,
        statuses={JOB_STATUS_PENDING, JOB_STATUS_RUNNING},
        limit=1,
        offset=0,
    )
    return StoryMemoryStatus(
        project_id=project_id,
        embedding_configured=model is not None,
        index_status=index_status,
        last_error=index_row.last_error if index_row is not None else None,
        last_ready_at=index_row.last_ready_at if index_row is not None else None,
        rebuild_job_status=active_jobs[0].status if active_jobs else None,
        counts=counts,
    )


async def enqueue_story_memory_rebuild(
    session: AsyncSession, *, project_id: str
) -> str | None:
    """提交全量重建任务；未配置可用 embedding 模型时返回 None。"""
    config = await get_index_settings(session)
    model = await resolve_index_embedding_model(session, config)
    if model is None:
        return None

    await ensure_story_memory_index(session, project_id, model)
    job = await background_service.submit_job(
        session,
        job_type=JOB_TYPE_STORY_MEMORY_REBUILD,
        payload={"project_id": project_id},
        context={"embedding_model_ref_id": model.id},
        subject_type="project",
        subject_id=project_id,
    )
    return job.id


async def delete_project_story_memory_documents(
    session: AsyncSession, *, project_id: str
) -> None:
    """删除项目 Story Memory 索引中的向量文档。

    必须在人物、世界设定、大纲、笔记等源行删除前调用：文档 ID 由源行派生，
    源行消失后无法再定位。仅作用于该项目的 index_key，不影响其它项目向量。
    索引未注册或底层删除失败时只记录告警，保持 best-effort 语义。
    """
    index_key = story_memory_index_key(project_id)
    try:
        index_row = await retrieval_index_repo.get_by_index_key(session, index_key)
        if index_row is None:
            return
        document_ids = [
            document.document_id
            for document in await build_story_memory_documents(session, project_id)
        ]
        if not document_ids:
            return
        await OpenFicRetrievalService().delete_documents(
            session, index_key, document_ids
        )
    except Exception as exc:
        logger.bind(project_id=project_id).warning(
            f"delete story memory documents failed: {exc}"
        )
