"""Sanity checks for fixed synthetic token-efficiency benchmark cases."""

from scripts.token_efficiency_benchmark import run_benchmark


def test_benchmark_reports_all_requested_workflow_shapes_and_only_estimates() -> None:
    result = run_benchmark()
    cases = result["cases"]

    assert result["benchmark_kind"] == "synthetic_o200k_base_estimates"
    assert result["live_provider_calls"] == 0
    assert len(cases) == 7
    assert cases["B_multi_chapter_continuity"]["continuity_messages_preserved"] == 10
    assert cases["D_reviewer_to_actor_repeated_reads"]["estimated_tokens_avoided"] > 0
    assert (
        cases["E_skill_heavy_duplicate_activation"]["duplicate_results_replaced"] == 2
    )
    assert cases["C_chapter_50_plus_retrieval"]["ranked_top_result_preserved"] is True
    assert (
        cases["F_rag_heavy"]["input_tokens_after"]
        <= cases["F_rag_heavy"]["input_tokens_before"]
    )
