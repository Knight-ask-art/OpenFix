import { apiClient } from "@/lib/api-client";

import type { InlineAiAction } from "./inline-ai-actions";

export interface InlineAiTransformRequest {
  projectId: string;
  chapterId: string;
  action: InlineAiAction;
  selectedText: string;
  instruction?: string;
}

export interface InlineAiTransformResponse {
  original: string;
  result: string;
  model: string;
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
}

export async function transformInlineAi(
  payload: InlineAiTransformRequest,
): Promise<InlineAiTransformResponse> {
  const response = await apiClient.post<InlineAiTransformResponse>("/inline-ai/transform", {
    project_id: payload.projectId,
    chapter_id: payload.chapterId,
    action: payload.action,
    selected_text: payload.selectedText,
    instruction: payload.instruction || null,
  });
  return response.data;
}
