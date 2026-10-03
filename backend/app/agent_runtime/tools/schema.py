"""Stable tool-schema serialization shared by audit and token estimation."""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import BaseModel

from app.core.utils.tiktoken import get_encoding


def _inline_local_schema_references(
    schema: Any,
    definitions: dict[str, Any],
    resolving: frozenset[str] = frozenset(),
) -> Any:
    if isinstance(schema, list):
        return [
            _inline_local_schema_references(item, definitions, resolving)
            for item in schema
        ]
    if not isinstance(schema, dict):
        return schema

    reference = schema.get("$ref")
    if isinstance(reference, str) and reference.startswith("#/$defs/"):
        definition_name = reference.removeprefix("#/$defs/")
        definition = definitions.get(definition_name)
        if isinstance(definition, dict) and definition_name not in resolving:
            resolved_definition = _inline_local_schema_references(
                definition,
                definitions,
                resolving | {definition_name},
            )
            sibling_fields = {
                key: _inline_local_schema_references(value, definitions, resolving)
                for key, value in schema.items()
                if key != "$ref"
            }
            return {**resolved_definition, **sibling_fields}

    return {
        key: _inline_local_schema_references(value, definitions, resolving)
        for key, value in schema.items()
        if key != "$defs"
    }


def serialize_tool_definitions(
    tools: Iterable[BaseTool] | None,
) -> list[dict[str, Any]]:
    """Return the schema view already used by LLM audit details."""
    result: list[dict[str, Any]] = []
    for tool in tools or []:
        args_schema = tool.args_schema
        parameters: dict[str, Any]
        if isinstance(args_schema, type) and issubclass(args_schema, BaseModel):
            schema = args_schema.model_json_schema()
            properties = schema.get("properties")
            definitions = schema.get("$defs")
            parameters = (
                _inline_local_schema_references(
                    properties,
                    definitions if isinstance(definitions, dict) else {},
                )
                if isinstance(properties, dict)
                else tool.args
            )
        else:
            parameters = tool.args
        result.append(
            {
                "name": tool.name,
                "description": tool.description,
                "parameters": parameters,
            }
        )
    return result


def serialize_tool_schemas(tools: Iterable[BaseTool] | None) -> list[dict[str, Any]]:
    """Return conservative function-tool schemas for budgets and fingerprints."""
    result: list[dict[str, Any]] = []
    for tool in tools or []:
        args_schema = tool.args_schema
        if isinstance(args_schema, type) and issubclass(args_schema, BaseModel):
            schema = args_schema.model_json_schema()
            definitions = schema.get("$defs")
            parameters = _inline_local_schema_references(
                schema,
                definitions if isinstance(definitions, dict) else {},
            )
        else:
            parameters = tool.args
        result.append(
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": parameters,
                },
            }
        )
    return result


def tool_schema_json(tools: Iterable[BaseTool] | None) -> str:
    return json.dumps(
        serialize_tool_definitions(tools),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    )


def count_tool_schema_tokens(tools: Iterable[BaseTool] | None) -> int:
    serialized = serialize_tool_schemas(tools)
    if not serialized:
        return 0
    schema = json.dumps(
        serialized,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        default=str,
    )
    return len(get_encoding("o200k_base").encode(schema))
