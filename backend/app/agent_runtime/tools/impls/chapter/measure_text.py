"""确定性文本字数测量工具。"""

from pydantic import BaseModel, Field

from app.agent_runtime.tools.base import AgentTool
from app.agent_runtime.tools.errors import ToolExecutionError
from app.agent_runtime.tools.registry import ToolRegistry
from app.core.word_count import count_words

# 单次测量的输入上限，避免把整本书正文一次塞进工具调用。
MAX_MEASURE_TEXT_CHARACTERS = 48_000

# 字数口径来源，与项目保存字数使用同一个计数器。
COUNTING_METHOD = "app.core.word_count.count_words"


class MeasureTextInput(BaseModel):
    text: str = Field(
        description=(
            "待测量的文本，最长 48000 字符。只统计字数并与给定范围比较，不回显文本内容。"
        ),
    )
    min_words: int | None = Field(
        default=None,
        ge=0,
        description="可选的字数下限（非负整数），用于判断文本是否偏短",
    )
    max_words: int | None = Field(
        default=None,
        ge=0,
        description="可选的字数上限（非负整数），不得小于 min_words",
    )


class MeasureTextRange(BaseModel):
    min_words: int | None
    max_words: int | None


class MeasureTextRevision(BaseModel):
    target_words: int
    word_delta: int
    minimum_change_words: int
    guidance: str


class MeasureTextOutput(BaseModel):
    word_count: int
    range: MeasureTextRange | None
    within_range: bool | None
    counting_method: str
    revision: MeasureTextRevision | None = None


@ToolRegistry.register
class MeasureTextTool(AgentTool):
    name: str = "measure_text"
    description: str = (
        "测量文本字数，并与可选的字数范围比较。"
        "只返回统计结果，不回显正文，不读写项目数据，不调用模型。"
        "字数口径与项目保存字数一致，来源为 app.core.word_count.count_words。"
        "用户或项目给出字数要求时，用它实测草稿与已保存正文；"
        "估算字数、其他 Agent 的自报字数都不能作为证据。"
        "未传 min_words / max_words 时只返回字数，within_range 为 null；"
        "本工具不设默认字数门槛，不判断章节合格与否。"
    )
    access_level: str = "readonly"
    args_schema: type[BaseModel] = MeasureTextInput

    async def _execute(
        self,
        text: str,
        min_words: int | None = None,
        max_words: int | None = None,
    ) -> str:
        if len(text) > MAX_MEASURE_TEXT_CHARACTERS:
            raise ToolExecutionError(
                f"文本长度 {len(text)} 字符，超过单次测量上限 "
                f"{MAX_MEASURE_TEXT_CHARACTERS} 字符，请分段测量。",
                code="limit_exceeded",
            )

        if min_words is not None and max_words is not None and max_words < min_words:
            raise ToolExecutionError(
                f"max_words（{max_words}）不能小于 min_words（{min_words}）。",
                code="validation_error",
            )

        word_count = count_words(text)
        has_range = min_words is not None or max_words is not None
        within_range: bool | None = None
        if has_range:
            within_range = (min_words is None or word_count >= min_words) and (
                max_words is None or word_count <= max_words
            )

        revision = None
        if within_range is False:
            if min_words is not None and max_words is not None:
                target = (min_words + max_words) // 2
            else:
                target = min_words if min_words is not None else max_words
            assert target is not None
            boundary = (
                min_words
                if min_words is not None and word_count < min_words
                else max_words
            )
            assert boundary is not None
            revision = MeasureTextRevision(
                target_words=target,
                word_delta=target - word_count,
                minimum_change_words=abs(boundary - word_count),
                guidance=(
                    "word_delta 为达到目标需要增减的实测字数（负数表示删减）。"
                    "按差额集中修订，避免每次只改几字反复调用；"
                    "保留事实、认知边界、声线与必要因果，不能机械截断。"
                    "修订后测量完整候选，片段达标不代表整章达标。"
                ),
            )

        return MeasureTextOutput(
            word_count=word_count,
            range=(
                MeasureTextRange(min_words=min_words, max_words=max_words)
                if has_range
                else None
            ),
            within_range=within_range,
            counting_method=COUNTING_METHOD,
            revision=revision,
        ).model_dump_json(exclude={"revision"} if revision is None else set())
