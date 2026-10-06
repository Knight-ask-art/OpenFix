# -*- coding: utf-8 -*-
"""
字数统计 - 章节字数的唯一口径。

统计规则（必须与 frontend/src/lib/word-count.ts 完全一致）：

1. 汉字、日文、韩文文字逐字符计 1；
2. 其它 Unicode 字母（L*）与数字（Nd）的连续串计 1；
3. 组合音标（M*）随前一个字符，既不计数，也不切断连续串；
4. 标点、空白、emoji 不计，并作为分词边界。

由此得到的固定口径：英文撇号属于标点，按边界处理（don't 计 2）；
abc123 属于同一个连续串，计 1。CJK 区间表与前端共用，边界用例见
fixtures/word-count-cases.json。
"""

import unicodedata

# CJK 区间表：必须与 frontend/src/lib/word-count.ts 的 CJK_RANGES 保持一致。
# 区间内的字符逐字符计数，因此这里用纯码点区间判断，不依赖 Unicode 数据库版本。
CJK_RANGES: tuple[tuple[int, int], ...] = (
    (0x1100, 0x11FF),  # 谚文字母
    (0x2E80, 0x2EFF),  # CJK 部首补充
    (0x2F00, 0x2FDF),  # 康熙部首
    (0x3005, 0x3005),  # 々 迭代符号
    (0x3007, 0x3007),  # 〇 表意数字零
    (0x3021, 0x3029),  # 苏州码子
    (0x3038, 0x303B),  # 笔画符号与竖排迭代符号
    (0x3041, 0x3096),  # 平假名
    (0x309D, 0x309F),  # 平假名叠字
    (0x30A1, 0x30FA),  # 片假名
    (0x30FC, 0x30FF),  # 片假名长音符与叠字
    (0x3105, 0x312F),  # 注音符号
    (0x3131, 0x318E),  # 谚文兼容字母
    (0x31A0, 0x31BF),  # 注音符号扩展
    (0x31F0, 0x31FF),  # 片假名音标扩展
    (0x3400, 0x4DBF),  # CJK 扩展 A
    (0x4E00, 0x9FFF),  # CJK 基本区
    (0xA960, 0xA97F),  # 谚文字母扩展 A
    (0xAC00, 0xD7A3),  # 谚文音节
    (0xD7B0, 0xD7FB),  # 谚文字母扩展 B
    (0xF900, 0xFAFF),  # CJK 兼容表意文字
    (0xFF66, 0xFF9F),  # 半角片假名（含半角浊音符）
    (0x20000, 0x2A6DF),  # CJK 扩展 B
    (0x2A700, 0x2EBEF),  # CJK 扩展 C 至 F
    (0x2F800, 0x2FA1F),  # CJK 兼容表意文字补充
)


def is_cjk_character(char: str) -> bool:
    """
    判断单个字符是否属于逐字符计数的 CJK 区间。

    Args:
        char: 单个字符（码点）。

    Returns:
        属于 CJK 区间返回 True。
    """
    code_point = ord(char)
    return any(start <= code_point <= end for start, end in CJK_RANGES)


def count_words(text: str) -> int:
    """
    按统一口径统计字数。

    Args:
        text: 待统计的正文。

    Returns:
        字数。
    """
    if not text:
        return 0

    total = 0
    in_token = False
    for char in text:
        if is_cjk_character(char):
            total += 1
            in_token = False
            continue

        category = unicodedata.category(char)
        if category.startswith("M"):
            # 组合音标随前一个字符：不计数，也不切断连续串。
            continue
        if category.startswith("L") or category == "Nd":
            if not in_token:
                total += 1
                in_token = True
            continue

        in_token = False

    return total
