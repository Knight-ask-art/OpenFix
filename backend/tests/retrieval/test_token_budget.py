"""Rank-ordered retrieval output must respect token budgets when possible."""

import json
from types import SimpleNamespace

from app.agent_runtime.context.compaction.tokens import count_text_tokens
from app.agent_runtime.tools.impls.chapter.search_chapters import _group_results
from app.retrieval.token_budget import fit_ranked_text_results
from app.retrieval.types import ChunkSearchResult
from app.agent_runtime.tools.impls.memory.search_story_memory import (
    StoryMemoryResultItem,
)


def test_ranked_story_results_keep_best_item_and_stop_when_budget_is_spent() -> None:
    results = [
        StoryMemoryResultItem(
            source="chapter",
            source_label="章节",
            title="第 50 章",
            text="最相关片段。" * 2_000,
            score=0.99,
        ),
        StoryMemoryResultItem(
            source="chapter",
            source_label="章节",
            title="第 12 章",
            text="次相关片段。" * 20,
            score=0.62,
        ),
    ]
    context = {
        "query": "角色知道什么",
        "searched_sources": ["chapter"],
        "skipped_sources": [],
    }

    def render(items) -> str:
        return json.dumps(
            {**context, "results": [item.model_dump() for item in items]},
            ensure_ascii=False,
            separators=(",", ":"),
        )

    bounded = fit_ranked_text_results(results, token_budget=300, render=render)

    assert len(bounded) == 1
    assert bounded[0].score == 0.99
    assert bounded[0].text
    assert count_text_tokens(render(bounded)) <= 300


def test_ranked_story_results_do_not_exceed_budget_when_envelope_cannot_fit() -> None:
    result = StoryMemoryResultItem(
        source="character",
        source_label="人物",
        title="林洛",
        text="",
        score=0.99,
    )

    bounded = fit_ranked_text_results(
        [result],
        token_budget=1,
        render=lambda items: json.dumps(
            {"query": "角色认知", "results": [item.model_dump() for item in items]},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )

    assert bounded == []


def test_chapter_search_caps_chunks_without_dropping_the_highest_ranked() -> None:
    result_rows = [
        ChunkSearchResult(
            document_id=f"chapter:{index}",
            chunk_id=f"chunk:{index}",
            chunk_index=index,
            text=("最相关片段。" if index == 0 else "其他片段。") * 1_000,
            metadata={"chapter_id": f"chapter-{index}", "volume_id": "volume-1"},
            score=0.99 - index * 0.1,
            matched_by="hybrid",
        )
        for index in range(3)
    ]
    chapters = {
        f"chapter-{index}": SimpleNamespace(
            id=f"chapter-{index}",
            title=f"第 {index + 1} 章",
            volume_id="volume-1",
            order=index + 1,
        )
        for index in range(3)
    }

    serialized = _group_results(
        query="角色的记忆",
        results=result_rows,
        chapters_by_id=chapters,
        volumes_by_id={"volume-1": SimpleNamespace(title="第一卷")},
        token_budget=300,
    )
    payload = json.loads(serialized)

    assert len(payload["results"]) == 1
    assert payload["results"][0]["chapter_order"] == 1
    assert payload["results"][0]["chunks"][0]["text"].startswith("最相关片段")
    assert count_text_tokens(serialized) <= 300
