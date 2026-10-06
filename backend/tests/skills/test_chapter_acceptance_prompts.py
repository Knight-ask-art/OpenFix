from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2] / "app/prompts/builtin-agents"


def prompt(name: str) -> str:
    data = yaml.safe_load((ROOT / f"{name}.yaml").read_text(encoding="utf-8"))
    return str(data)


def test_writer_measures_exact_candidate_and_both_bounds():
    text = prompt("writer")
    assert "min_words 与 max_words" in text
    assert "同一正文" in text
    assert "前章或旧稿" in text


def test_reviewer_checks_declared_rules_and_unintended_injuries():
    text = prompt("reviewer")
    assert "规则与结果" in text
    assert "意外新增事实" in text
    assert "证据不足" in text
    assert "默认全低" in text


def test_coordinators_handoff_unsaved_candidate_explicitly():
    for name in ("build", "plan"):
        text = prompt(name)
        assert "source_dispatch_ids" in text
        assert "old_content" in text and "new_content" in text
        assert "未保存" in text
