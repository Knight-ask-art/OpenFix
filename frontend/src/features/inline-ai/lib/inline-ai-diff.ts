import * as Diff from "diff";

export type InlineAiDiffRowType = "context" | "removed" | "added";

export interface InlineAiDiffRow {
  type: InlineAiDiffRowType;
  text: string;
}

export function buildInlineAiDiffRows(original: string, result: string): InlineAiDiffRow[] {
  const rows: InlineAiDiffRow[] = [];
  for (const part of Diff.diffLines(original, result)) {
    const lines = part.value.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const type: InlineAiDiffRowType = part.added ? "added" : part.removed ? "removed" : "context";
    for (const line of lines) rows.push({ type, text: line });
  }
  return rows;
}
