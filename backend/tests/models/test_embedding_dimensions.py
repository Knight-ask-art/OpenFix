"""Index vector metadata must not leak unsupported API parameters."""

from unittest.mock import patch

import pytest

from app.models.clients.embedding_client import EmbeddingClient, EmbeddingConfig


@pytest.mark.parametrize(
    ("provider", "model", "send_dimensions"),
    [
        ("siliconflow-cn", "Qwen/Qwen3-Embedding-8B", True),
        ("siliconflow", "Qwen/Qwen3-Embedding-4B", True),
        ("siliconflow-cn", "BAAI/bge-m3", False),
        ("openai-compatible", "custom-embedding", True),
        ("openai", "text-embedding-3-small", True),
        ("mistral", "mistral-embed", False),
        ("cohere", "embed-v4", False),
        ("azure", "text-embedding-ada-002", False),
        ("vercel", "embedding-model", False),
    ],
)
def test_dimensions_are_metadata_unless_api_supports_parameter(provider, model, send_dimensions):
    config = EmbeddingConfig(provider_type=provider, base_url="https://example.com/v1", api_key="", model_id=model, dimensions=1024)
    with patch("langchain_openai.OpenAIEmbeddings") as factory:
        EmbeddingClient(config)._get_embeddings()
    kwargs = factory.call_args.kwargs
    assert ("dimensions" in kwargs) is send_dimensions
    assert config.dimensions == 1024
