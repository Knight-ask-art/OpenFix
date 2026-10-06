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


def test_writer_keeps_task_locators_out_of_character_knowledge():
    text = prompt("writer")
    assert "任务定位元数据，不是人物所处世界的事实" in text
    assert "转换为正文已有的故事时间" in text
    assert "不照搬进角色台词或内心" in text
    assert "用户已确认的元叙事或破第四墙风格例外" in text
    assert "不据此禁用正常章节标题" in text


def test_writer_length_revision_scales_with_excess_and_budget_sum_is_complete():
    text = prompt("writer")
    # 无条件的最小修订指令会让远超上限的整章只做零碎删改，必须按超出幅度分流：
    # measure_text 已在超过上限一定比例时返回 structural_compression。
    assert "超出要求时按最小修订处理" not in text
    assert "按 measure_text 返回的 strategy" in text
    assert "structural_compression" in text
    assert "local_revision" in text
    # 分场景写作时，各场景预算之和必须是整章目标，否则会累积超出上限。
    assert "各场景预算之和等于本章完整目标" in text
    # 片段、前章与旧稿的测量都不能证明本章达标。
    assert "不能用场景片段、前章或旧稿的结果代替本章" in text
    # 压缩保留事实、选择与因果，不靠截断、静默删减或反复几字改动凑数。
    assert "保留事实、人物选择、因果与认知边界" in text
    assert "不截断正文" in text
    assert "不静默删减必需内容" in text
    assert "反复只改几字" in text
    # 不因字数要求引入统一的全局章节长度。
    assert "不新增统一的 1800–2200 硬门槛" in text


def test_build_dispatch_routes_length_by_measure_strategy():
    for name in ("build", "actor"):
        text = prompt(name)
        # 协调者与执行者都不能把字数问题一律下压成最小修订，
        # 否则远超上限的整章只会被零碎删改；策略由 measure_text 返回。
        assert "超长按最小修订处理" not in text
        assert "超出字数要求时只做最小有效修订" not in text
        assert "按 measure_text 返回的 strategy" in text
        assert "structural_compression" in text and "local_revision" in text
        assert "不截断" in text
        # 不重复引入全局硬门槛。
        assert "1800–2200" not in text

    build = prompt("build")
    # 派发时按整章目标分派，避免各场景预算独立累加抬高上限。
    assert "按整章目标分派" in build and "不按场景单独放宽字数预算" in build
    assert "不截断正文" in build and "反复只改几字" in build

    actor = prompt("actor")
    # 明显超长按场景功能压缩，且不改变事实、关系、主动性、因果与认知边界。
    assert "按场景功能" in actor
    assert "不改事实、人物关系、主动性、因果与认知边界" in actor
    # 接近边界时才走局部修订，并且不靠反复几字改动应付测量。
    assert "接近边界" in actor
    assert "反复只改几字" in actor


def test_actor_keeps_minimum_effective_edit_for_local_issues():
    text = prompt("actor")
    # 局部质量问题的最小有效修订规则不因字数分流被移除。
    assert "minimum effective edit" in text
    assert "删一处能解决就不改一段" in text
    assert "局部质量问题仍按 minimum effective edit" in text
    # 结构性压缩仍受事实、关系与知情边界约束。
    assert "不改变剧情事实、人物关系、知情范围" in text


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
