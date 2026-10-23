import hashlib
import hmac
import json
import re
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.agent_runtime.tools.base import AgentTool
from app.core.editor_content_limits import EditorContentLimitError, validate_editor_content
from app.core.word_count import count_words
from app.agent_runtime.revisions import (
    current_revision_id_from_state,
    images_by_id,
    record_agent_activity_for_change,
    record_chapter_diffs,
)
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.impls.chapter.diff_preview import (
    build_chapter_diff_preview,
    build_edit_chapter_tool_result_preview,
    chapter_preview_from_object,
)
from app.agent_runtime.tools.impls.chapter.refs import (
    ChapterRef,
    VolumeRef,
    resolve_chapter_from_list,
    resolve_volume_from_list,
)
from app.agent_runtime.tools.registry import ToolRegistry
from app.agent_runtime.tools.impls.chapter.content_edit import edit_chapter_content
from app.storage.database import create_session
from app.storage.repos import chapter_repo, volume_repo
from app.storage.services.version_control_service import refresh_project_stats

_SHA256_HEX = re.compile(r"^[0-9a-fA-F]{64}$")

# 字面保留约束是有限的附加校验，不是补丁引擎。
MAX_PRESERVE_EXACT_ITEMS = 32
MAX_PRESERVE_EXACT_TOTAL_CHARACTERS = 4_000


def content_sha256(content: str) -> str:
    """Exact UTF-8 SHA256 of stored text; no normalization."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _normalized_sha256(value: object, field_name: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _SHA256_HEX.fullmatch(value.strip()):
        raise ToolExecutionError(
            f"{field_name} 必须是 64 位十六进制 SHA256，已拒绝本次修改。",
            code="validation_error",
        )
    return value.strip().lower()


def _validated_preserve_exact(values: object) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list):
        raise ToolExecutionError(
            "preserve_exact 必须是字符串列表，已拒绝本次修改。",
            code="validation_error",
        )
    if len(values) > MAX_PRESERVE_EXACT_ITEMS:
        raise ToolExecutionError(
            f"preserve_exact 最多 {MAX_PRESERVE_EXACT_ITEMS} 项，已拒绝本次修改。",
            code="limit_exceeded",
        )
    literals: list[str] = []
    total = 0
    for item in values:
        if not isinstance(item, str) or not item.strip():
            raise ToolExecutionError(
                "preserve_exact 不能包含空字符串，已拒绝本次修改。",
                code="validation_error",
            )
        total += len(item)
        literals.append(item)
    if total > MAX_PRESERVE_EXACT_TOTAL_CHARACTERS:
        raise ToolExecutionError(
            f"preserve_exact 总长度超过 {MAX_PRESERVE_EXACT_TOTAL_CHARACTERS} "
            "字符，已拒绝本次修改。",
            code="limit_exceeded",
        )
    return literals


def _sha256_field_validator(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if not _SHA256_HEX.fullmatch(normalized):
        raise ValueError("必须是 64 位十六进制 SHA256")
    return normalized


def _validate_change_constraints(
    base_content: str,
    proposed_content: str,
    *,
    expected_base: str | None,
    expected_result: str | None,
    preserved_literals: list[str],
) -> tuple[str, str]:
    """Validate the exact preview/execution pair without changing either text."""
    base_sha = content_sha256(base_content)
    result_sha = content_sha256(proposed_content)
    if expected_base is not None and not hmac.compare_digest(base_sha, expected_base):
        raise ToolExecutionError(
            "stale_base: 章节正文已变化，未做任何修改；请重新读取正文与哈希。",
            code="conflict",
        )
    for literal in preserved_literals:
        if literal not in base_content or literal not in proposed_content:
            raise ToolExecutionError(
                "constraint_failed: 字面保留片段在基稿或结果中不存在，未做任何修改。",
                code="validation_error",
            )
    if expected_result is not None and not hmac.compare_digest(result_sha, expected_result):
        raise ToolExecutionError(
            "constraint_failed: 完整结果与预期哈希不一致，未做任何修改。",
            code="validation_error",
        )
    return base_sha, result_sha


class EditChapterInput(BaseModel):
    volume_ref: VolumeRef = Field(description="目标卷")
    chapter_ref: ChapterRef = Field(description="目标章节")
    new_title: str | None = Field(
        default=None,
        description="新章节标题，可选；仅在修改标题时填写",
    )
    old_content: str | None = Field(
        default=None,
        description="要查找并替换的原始文本；仅在修改正文时填写。已有空白章节首次填正文时传空字符串；非空章节必须提供原文锚点，禁止删除重建章节",
    )
    new_content: str | None = Field(
        default=None,
        description="用于替换的新文本；仅在修改正文时填写",
    )
    replace_all: bool = Field(
        default=False,
        description="是否替换命中的全部old_content，指定为false时只替换首个匹配项",
    )
    expected_base_sha256: str | None = Field(
        default=None,
        description=(
            "可选。编辑前章节原始正文（非行号化显示）的 SHA256 基线，取自 read_chapter "
            "的 content_sha256；与当前正文不一致时拒绝修改"
        ),
    )
    preserve_exact: list[str] | None = Field(
        default=None,
        description=(
            "可选。修改后必须仍原样存在的片段，最多 32 项且总长不超过 4000 字符；"
            "片段须在当前正文中存在，否则拒绝修改。只校验字面片段，不证明语义未被改变"
        ),
    )
    expected_result_sha256: str | None = Field(
        default=None,
        description=(
            "可选。预期修改后完整正文的 SHA256；不一致时拒绝修改。不要猜测哈希"
        ),
    )

    @field_validator("expected_base_sha256", "expected_result_sha256", mode="after")
    @classmethod
    def check_sha256_fields(cls, v: str | None) -> str | None:
        return _sha256_field_validator(v)

    @field_validator("new_content", mode="after")
    @classmethod
    def check_edit_fields(cls, v, info):
        data = info.data
        has_title = data.get("new_title") is not None
        has_content = data.get("old_content") is not None and v is not None
        if not has_title and not has_content:
            raise ValueError("new_title 和 old_content/new_content 必填其中一类")
        return v


@ToolRegistry.register
class EditChapterTool(AgentTool):
    name: str = "edit_chapter"
    description: str = (
        "编辑指定章节的标题或内容。"
        "可选 expected_base_sha256 校验改写基线，preserve_exact 要求字面片段保留，"
        "expected_result_sha256 校验完整结果；校验失败即拒绝修改且不写入。"
        "返回 base_sha256/result_sha256 与 revision_id，供审阅确切版本。"
    )
    access_level: str = "write"
    args_schema: type[BaseModel] = EditChapterInput

    async def build_interrupt_preview(self, args: dict[str, Any]) -> dict | None:
        session = self.get_runtime_db_session()
        if session is None:
            return None
        volume_ref = args.get("volume_ref")
        if isinstance(volume_ref, VolumeRef):
            volume_ref = volume_ref.model_dump()
        if not isinstance(volume_ref, dict):
            return None
        chapter_ref = args.get("chapter_ref")
        if isinstance(chapter_ref, ChapterRef):
            chapter_ref = chapter_ref.model_dump()
        if not isinstance(chapter_ref, dict):
            return None
        new_title = args.get("new_title")
        old_content = args.get("old_content")
        new_content = args.get("new_content")
        receipt: dict[str, Any] = {"will_recheck_at_execution": True}
        try:
            expected_base = _normalized_sha256(args.get("expected_base_sha256"), "expected_base_sha256")
            expected_result = _normalized_sha256(args.get("expected_result_sha256"), "expected_result_sha256")
            literals = _validated_preserve_exact(args.get("preserve_exact"))

            def validate_change(base_content: str, proposed_content: str) -> None:
                base_sha, result_sha = _validate_change_constraints(
                    base_content, proposed_content, expected_base=expected_base,
                    expected_result=expected_result, preserved_literals=literals,
                )
                receipt.update({
                    "base_sha256": base_sha, "result_sha256": result_sha,
                    "expected_base_sha256": expected_base,
                    "expected_result_sha256": expected_result,
                    "preserve_exact_count": len(literals),
                    "validated_at_preview": True,
                })

            preview = await build_edit_chapter_tool_result_preview(
                session, self.project_id, volume_ref=volume_ref, chapter_ref=chapter_ref,
                new_title=new_title if isinstance(new_title, str) else None,
                old_content=old_content if isinstance(old_content, str) else None,
                new_content=new_content if isinstance(new_content, str) else None,
                replace_all=bool(args.get("replace_all")), validate_change=validate_change,
            )
        except ToolExecutionError as exc:
            return {"type": "fail", "success": False, "code": exc.code, "message": str(exc)}
        return {**preview, "constraints": receipt} if preview is not None else None

    async def _execute(
        self,
        volume_ref: dict,
        chapter_ref: dict,
        new_title: str | None = None,
        old_content: str | None = None,
        new_content: str | None = None,
        replace_all: bool = False,
        expected_base_sha256: str | None = None,
        preserve_exact: list[str] | None = None,
        expected_result_sha256: str | None = None,
    ) -> str:
        revision_id = current_revision_id_from_state(self._state)
        if revision_id is None:
            raise ToolExecutionError("缺少当前 revision，无法执行章节编辑")
        # 约束参数先于任何数据库访问校验；错误消息不回显正文片段。
        expected_base = _normalized_sha256(expected_base_sha256, "expected_base_sha256")
        expected_result = _normalized_sha256(
            expected_result_sha256, "expected_result_sha256"
        )
        preserved_literals = _validated_preserve_exact(preserve_exact)
        volume_ref_model = VolumeRef.model_validate(volume_ref)
        ref = ChapterRef.model_validate(chapter_ref)
        session = await create_session()
        try:
            volume = resolve_volume_from_list(
                await volume_repo.list_by_project(session, self.project_id),
                volume_ref_model,
            )
            matched = await chapter_repo.get_by_volume_ref(
                session,
                volume.id,
                ref_type=ref.type,
                ref_value=ref.value,
            )
            match = resolve_chapter_from_list([matched] if matched is not None else [], ref)
            base_content = match.content or ""
            proposed_content = base_content
            if old_content is not None and new_content is not None:
                edited_content = edit_chapter_content(
                    base_content, old_content, new_content, replace_all=replace_all
                )
                if edited_content is None:
                    raise ToolExecutionError("未在章节内容中找到要替换的文本")
                proposed_content = edited_content
            base_sha, result_sha = _validate_change_constraints(
                base_content, proposed_content, expected_base=expected_base,
                expected_result=expected_result, preserved_literals=preserved_literals,
            )
            if old_content is not None and new_content is not None:
                try:
                    validate_editor_content(proposed_content)
                except EditorContentLimitError as exc:
                    raise ToolExecutionError(str(exc)) from exc
            before = images_by_id([match])
            before_match = chapter_preview_from_object(match)
            if new_title is not None:
                match.title = new_title
            if old_content is not None and new_content is not None:
                match.content = proposed_content
                match.word_count = count_words(match.content)
            match.updated_at = datetime.now(UTC)
            await chapter_repo.update_chapter(session, match)
            chapter_diff = build_chapter_diff_preview(
                before_match,
                chapter_preview_from_object(match),
                path=[volume.title.strip()],
            )
            after = images_by_id([match])
            affected = await record_chapter_diffs(
                session,
                revision_id=revision_id,
                project_id=self.project_id,
                before=before,
                after=after,
            )
            for chapter_id in affected:
                await record_agent_activity_for_change(
                    session,
                    revision_id=revision_id,
                    task_id=str(self._state.get("task_id") or ""),
                    agent_session_id=self.session_id,
                    before=before.get(chapter_id),
                    after=after.get(chapter_id),
                )
            await refresh_project_stats(session, self.project_id)
            from app.background.jobs import service as background_service
            from app.retrieval.chapter_index import safe_maybe_enqueue_auto_index
            from app.retrieval.index_status import schedule_emit_index_status

            await safe_maybe_enqueue_auto_index(session, project_id=self.project_id)
            schedule_emit_index_status(session, self.project_id)
            await background_service.commit_and_notify(session)
            return json.dumps(
                {
                    "success": True,
                    "word_count": match.word_count,
                    "metadata": {"chapter_diff": chapter_diff},
                    "base_sha256": base_sha,
                    "result_sha256": result_sha,
                    "revision_id": revision_id,
                },
                ensure_ascii=False,
            )
        except ToolExecutionError:
            raise
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
