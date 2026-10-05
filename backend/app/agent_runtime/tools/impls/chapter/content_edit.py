"""Shared chapter editing semantics for approval previews and execution."""

from app.agent_runtime.tools.text_match import fuzzy_replace


def edit_chapter_content(
    content: str, old_content: str, new_content: str, *, replace_all: bool = False
) -> str | None:
    # An empty anchor initializes an empty chapter only. It must never insert
    # into or overwrite an existing manuscript, including a whitespace draft.
    if old_content == "":
        return new_content if content == "" else None
    result = fuzzy_replace(content, old_content, new_content, replace_all=replace_all)
    return result.new_content if result is not None else None
