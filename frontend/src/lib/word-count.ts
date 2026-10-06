/**
 * 字数统计 - 章节字数的唯一口径，必须与 backend/app/core/word_count.py 完全一致。
 *
 * 统计规则：
 * 1. 汉字、日文、韩文文字逐字符计 1；
 * 2. 其它 Unicode 字母（L）与数字（Nd）的连续串计 1；
 * 3. 组合音标（M）随前一个字符，既不计数，也不切断连续串；
 * 4. 标点、空白、emoji 不计，并作为分词边界。
 *
 * 由此得到的固定口径：英文撇号属于标点，按边界处理（don't 计 2）；
 * abc123 属于同一个连续串，计 1。CJK 区间表与后端共用，边界用例见
 * fixtures/word-count-cases.json。
 */

/** CJK 区间表：必须与 backend/app/core/word_count.py 的 CJK_RANGES 保持一致。 */
export const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // 谚文字母
  [0x2e80, 0x2eff], // CJK 部首补充
  [0x2f00, 0x2fdf], // 康熙部首
  [0x3005, 0x3005], // 々 迭代符号
  [0x3007, 0x3007], // 〇 表意数字零
  [0x3021, 0x3029], // 苏州码子
  [0x3038, 0x303b], // 笔画符号与竖排迭代符号
  [0x3041, 0x3096], // 平假名
  [0x309d, 0x309f], // 平假名叠字
  [0x30a1, 0x30fa], // 片假名
  [0x30fc, 0x30ff], // 片假名长音符与叠字
  [0x3105, 0x312f], // 注音符号
  [0x3131, 0x318e], // 谚文兼容字母
  [0x31a0, 0x31bf], // 注音符号扩展
  [0x31f0, 0x31ff], // 片假名音标扩展
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xa960, 0xa97f], // 谚文字母扩展 A
  [0xac00, 0xd7a3], // 谚文音节
  [0xd7b0, 0xd7fb], // 谚文字母扩展 B
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xff66, 0xff9f], // 半角片假名（含半角浊音符）
  [0x20000, 0x2a6df], // CJK 扩展 B
  [0x2a700, 0x2ebef], // CJK 扩展 C 至 F
  [0x2f800, 0x2fa1f], // CJK 兼容表意文字补充
];

const LETTER_PATTERN = /\p{L}/u;
const DIGIT_PATTERN = /\p{Nd}/u;
const MARK_PATTERN = /\p{M}/u;

/** 判断单个字符是否属于逐字符计数的 CJK 区间。 */
export function isCjkCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return false;
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** 按统一口径统计字数。 */
export function countWords(text: string): number {
  if (!text) return 0;

  let total = 0;
  let inToken = false;
  for (const char of text) {
    if (isCjkCharacter(char)) {
      total += 1;
      inToken = false;
      continue;
    }
    if (MARK_PATTERN.test(char)) {
      // 组合音标随前一个字符：不计数，也不切断连续串。
      continue;
    }
    if (LETTER_PATTERN.test(char) || DIGIT_PATTERN.test(char)) {
      if (!inToken) {
        total += 1;
        inToken = true;
      }
      continue;
    }
    inToken = false;
  }

  return total;
}
