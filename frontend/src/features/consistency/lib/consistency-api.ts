import { apiClient } from "@/lib/api-client";

export type ConsistencySeverity = "info" | "warning" | "high";

export interface ConsistencyIssue {
  type: string;
  severity: ConsistencySeverity;
  message: string;
  evidence: string[];
  suggestion: string;
}

export interface ConsistencyCheckResult {
  chapter_id: string;
  model: string;
  context_source: "story_memory" | "inventory";
  issues: ConsistencyIssue[];
}

export async function runConsistencyCheck(
  projectId: string,
  chapterId: string,
): Promise<ConsistencyCheckResult> {
  const response = await apiClient.post<ConsistencyCheckResult>(
    `/projects/${projectId}/consistency/check`,
    { chapter_id: chapterId },
    { timeout: 300000 },
  );
  return response.data;
}
