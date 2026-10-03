"""Provider-neutral usage accounting tests."""

import pytest

from app.audit.usage import normalize_usage_tokens


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        (
            {
                "prompt_tokens": 1_000,
                "completion_tokens": 200,
                "prompt_tokens_details": {"cached_tokens": 400},
                "completion_tokens_details": {"reasoning_tokens": 50},
            },
            {
                "token_input": 1_000,
                "token_input_total": 1_000,
                "token_input_uncached": 600,
                "token_cache": 400,
                "token_cache_write": 0,
                "token_reasoning": 50,
                "cache_hit_rate": 0.4,
                "tokens_total": 1_200,
            },
        ),
        (
            {
                "input_tokens": 1_000,
                "output_tokens": 250,
                "cache_read_input_tokens": 300,
                "cache_creation_input_tokens": 100,
            },
            {
                "token_input": 1_000,
                "token_input_total": 1_400,
                "token_input_uncached": 1_000,
                "token_cache": 300,
                "token_cache_write": 100,
                "token_reasoning": 0,
                "cache_hit_rate": pytest.approx(300 / 1_400),
                "tokens_total": 1_650,
            },
        ),
        (
            {
                "prompt_token_count": 2_000,
                "candidates_token_count": 300,
                "cached_content_token_count": 800,
                "thoughts_token_count": 120,
            },
            {
                "token_input": 2_000,
                "token_input_total": 2_000,
                "token_input_uncached": 1_200,
                "token_cache": 800,
                "token_cache_write": 0,
                "token_reasoning": 120,
                "cache_hit_rate": 0.4,
                "tokens_total": 2_300,
            },
        ),
    ],
)
def test_normalizes_provider_usage_aliases(usage, expected) -> None:
    actual = normalize_usage_tokens(usage)
    for key, value in expected.items():
        assert actual[key] == value


def test_missing_and_invalid_usage_returns_zero_metrics() -> None:
    assert normalize_usage_tokens(None) == normalize_usage_tokens({})
    actual = normalize_usage_tokens(
        {
            "input_tokens": -8,
            "output_tokens": True,
            "cached_tokens": 20,
            "total_tokens": 0,
        }
    )

    assert actual["token_input"] == 0
    assert actual["token_output"] == 0
    assert actual["token_input_uncached"] == 0
    assert actual["cache_hit_rate"] == 0.0
