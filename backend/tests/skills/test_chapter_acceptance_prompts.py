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


def test_reviewer_checks_previous_dialogue_and_ratio_bases():
    text = prompt("reviewer")
    assert "追溯性对白" in text
    assert "未验证" in text
    assert "单位、基数和因果" in text
    assert "损耗比例" in text and "补足比例" in text


def test_reviewer_checks_scene_function_without_forcing_warmth():
    text = prompt("reviewer")
    assert "场景主功能是否被信息投放挤占" in text
    assert "人物首次登场" in text and "轮番授课" in text
    assert "人物尚未知的真相" in text
    assert "不强制家庭场景温情化" in text
    assert "scene_function" in text


def test_narrative_skill_preserves_relationship_and_information_boundaries():
    path = ROOT.parents[1] / "skills/narrative-deslop.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    text = data["content"]
    assert "关系建立、情绪缓冲" in text
    assert "重要关系不能只靠身份说明代替" in text
    assert "不为藏信息删除当前必需事实" in text
    assert "scene_function" in text
