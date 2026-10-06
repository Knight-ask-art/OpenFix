import pytest
from pydantic import ValidationError

from app.agent_runtime.tools.impls.memory.search_story_memory import SearchStoryMemoryInput


@pytest.mark.parametrize("sources", [["outline", "note"], '["outline", "note"]'])
def test_source_array_provider_compatibility(sources):
    assert SearchStoryMemoryInput(query="chapter outline", sources=sources).sources == [
        "outline", "note"
    ]


@pytest.mark.parametrize("sources", ['["unknown"]', '"outline"', "outline", "[", '{}'])
def test_invalid_sources_still_rejected(sources):
    with pytest.raises(ValidationError):
        SearchStoryMemoryInput(query="chapter outline", sources=sources)


def test_schema_remains_typed_array():
    schema = SearchStoryMemoryInput.model_json_schema()["properties"]["sources"]
    assert any(part.get("type") == "array" for part in schema["anyOf"])
