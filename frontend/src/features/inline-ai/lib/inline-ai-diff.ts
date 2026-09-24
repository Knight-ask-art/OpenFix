import * as Diff from "diff";

export type InlineAiDiffRowType = "context" | "removed" | "added";
export type InlineAiDiffSegmentType = "equal" | "removed" | "added";

export interface InlineAiDiffSegment {
  type: InlineAiDiffSegmentType;
  text: string;
}

export interface InlineAiDiffRow {
  type: InlineAiDiffRowType;
  text: string;
  /** 字符级高亮片段；缺省表示整行变更未做行内细分。 */
  segments?: InlineAiDiffSegment[];
}

type LineKind = "equal" | "removed" | "added";

interface LineEntry {
  kind: LineKind;
  text: string;
}

/** 超过该长度的单行跳过字符级 diff，避免长文本 Myers 计算卡顿。 */
const MAX_CHAR_DIFF_LINE_LENGTH = 4_000;

function splitPartLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function charDiffSegments(removedText: string, addedText: string): {
  removed: InlineAiDiffSegment[];
  added: InlineAiDiffSegment[];
} {
  const removed: InlineAiDiffSegment[] = [];
  const added: InlineAiDiffSegment[] = [];
  for (const part of Diff.diffChars(removedText, addedText)) {
    if (!part.removed && !part.added) {
      removed.push({ type: "equal", text: part.value });
      added.push({ type: "equal", text: part.value });
      continue;
    }
    if (part.removed) removed.push({ type: "removed", text: part.value });
    if (part.added) added.push({ type: "added", text: part.value });
  }
  return { removed, added };
}

export function buildInlineAiDiffRows(original: string, result: string): InlineAiDiffRow[] {
  const entries: LineEntry[] = [];
  for (const part of Diff.diffLines(original, result)) {
    const kind: LineKind = part.added ? "added" : part.removed ? "removed" : "equal";
    for (const text of splitPartLines(part.value)) entries.push({ kind, text });
  }

  const rows: InlineAiDiffRow[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (entry.kind === "equal") {
      rows.push({ type: "context", text: entry.text });
      index += 1;
      continue;
    }

    const runKind = entry.kind;
    let runEnd = index;
    while (runEnd < entries.length && entries[runEnd].kind === runKind) runEnd += 1;
    const run = entries.slice(index, runEnd);

    const oppositeKind: LineKind = runKind === "removed" ? "added" : "removed";
    let oppositeEnd = runEnd;
    while (oppositeEnd < entries.length && entries[oppositeEnd].kind === oppositeKind) {
      oppositeEnd += 1;
    }
    const oppositeRun = entries.slice(runEnd, oppositeEnd);

    const removedLines = (runKind === "removed" ? run : oppositeRun).map((item) => item.text);
    const addedLines = (runKind === "added" ? run : oppositeRun).map((item) => item.text);
    const pairCount = Math.min(removedLines.length, addedLines.length);

    for (let pair = 0; pair < pairCount; pair += 1) {
      const removedText = removedLines[pair];
      const addedText = addedLines[pair];
      if (
        removedText.length <= MAX_CHAR_DIFF_LINE_LENGTH &&
        addedText.length <= MAX_CHAR_DIFF_LINE_LENGTH
      ) {
        const segments = charDiffSegments(removedText, addedText);
        rows.push({ type: "removed", text: removedText, segments: segments.removed });
        rows.push({ type: "added", text: addedText, segments: segments.added });
      } else {
        rows.push({ type: "removed", text: removedText });
        rows.push({ type: "added", text: addedText });
      }
    }
    for (let extra = pairCount; extra < removedLines.length; extra += 1) {
      rows.push({ type: "removed", text: removedLines[extra] });
    }
    for (let extra = pairCount; extra < addedLines.length; extra += 1) {
      rows.push({ type: "added", text: addedLines[extra] });
    }

    index = oppositeEnd;
  }
  return rows;
}
