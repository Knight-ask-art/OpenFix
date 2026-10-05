import { apiClient } from "@/lib/api-client";

/**
 * 大纲 AI（PRD §14）：完善大纲 / 检查节奏 / 拆分章节 / 根据正文更新大纲。
 *
 * 四个接口都只返回候选内容，不会写入大纲；
 * 用户确认后由调用方通过既有大纲 API 落库。
 */

export type OutlineAiSeverity = "info" | "warning" | "high";

export interface OutlineAiDraftSuggestion {
  title: string;
  content: string;
  notes: string | null;
  model: string;
}

export interface OutlineAiIssue {
  severity: OutlineAiSeverity;
  message: string;
  evidence: string[];
  suggestion: string;
}

export interface OutlineAiPacingSuggestion {
  summary: string;
  issues: OutlineAiIssue[];
  model: string;
}

export interface OutlineAiSplitItem {
  title: string;
  content: string;
}

export interface OutlineAiSplitSuggestion {
  items: OutlineAiSplitItem[];
  model: string;
}

/** 大纲 AI 生成长文本，沿用内联 AI 的长超时设置。 */
const OUTLINE_AI_TIMEOUT_MS = 180_000;

export async function improveOutline(
  projectId: string,
  outlineId: string,
  instruction?: string,
  signal?: AbortSignal,
): Promise<OutlineAiDraftSuggestion> {
  const response = await apiClient.post<OutlineAiDraftSuggestion>(
    `/projects/${projectId}/outlines/ai/improve`,
    { outline_id: outlineId, instruction: instruction ?? null },
    { timeout: OUTLINE_AI_TIMEOUT_MS, signal },
  );
  return response.data;
}

export async function checkOutlinePacing(
  projectId: string,
  outlineId: string,
  signal?: AbortSignal,
): Promise<OutlineAiPacingSuggestion> {
  const response = await apiClient.post<OutlineAiPacingSuggestion>(
    `/projects/${projectId}/outlines/ai/check-pacing`,
    { scope: "node", outline_id: outlineId },
    { timeout: OUTLINE_AI_TIMEOUT_MS, signal },
  );
  return response.data;
}

export async function splitOutlineIntoChapters(
  projectId: string,
  outlineId: string,
  maxChapters = 8,
  instruction?: string,
  signal?: AbortSignal,
): Promise<OutlineAiSplitSuggestion> {
  const response = await apiClient.post<OutlineAiSplitSuggestion>(
    `/projects/${projectId}/outlines/ai/split-chapters`,
    { outline_id: outlineId, max_chapters: maxChapters, instruction: instruction ?? null },
    { timeout: OUTLINE_AI_TIMEOUT_MS, signal },
  );
  return response.data;
}

export async function updateOutlineFromChapter(
  projectId: string,
  outlineId: string,
  chapterId?: string,
  signal?: AbortSignal,
): Promise<OutlineAiDraftSuggestion> {
  const response = await apiClient.post<OutlineAiDraftSuggestion>(
    `/projects/${projectId}/outlines/ai/update-from-chapter`,
    { outline_id: outlineId, chapter_id: chapterId ?? null },
    { timeout: OUTLINE_AI_TIMEOUT_MS, signal },
  );
  return response.data;
}
