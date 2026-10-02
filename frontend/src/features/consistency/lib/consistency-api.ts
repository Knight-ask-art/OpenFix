import { apiClient } from "@/lib/api-client";

export type ConsistencySeverity = "info" | "warning" | "high";

export type ConsistencyScope = "chapter" | "volume" | "book";

export interface ConsistencySource {
  chapter_id: string;
  chapter_order: number;
  chapter_title: string;
  excerpt: string;
  quote: string;
}

export interface ConsistencyIssue {
  type: string;
  severity: ConsistencySeverity;
  message: string;
  evidence: string[];
  suggestion: string;
  sources: ConsistencySource[];
}

export interface ConsistencyCheckResult {
  scope: ConsistencyScope;
  label: string;
  chapter_id: string | null;
  volume_id: string | null;
  chapter_count: number;
  model: string;
  context_source: "story_memory" | "inventory";
  issues: ConsistencyIssue[];
  failed_segments?: number[];
}

export interface ConsistencyCheckParams {
  scope: ConsistencyScope;
  chapterId?: string | null;
  volumeId?: string | null;
}

export interface ConsistencyIssueAnalysis {
  model: string;
  analysis: string;
}

export interface ConsistencyIssueAnalysisParams {
  scope: ConsistencyScope;
  chapterId?: string | null;
  volumeId?: string | null;
  issue: Pick<ConsistencyIssue, "type" | "severity" | "message" | "evidence" | "suggestion">;
}

export async function runConsistencyCheck(
  projectId: string,
  params: ConsistencyCheckParams,
): Promise<ConsistencyCheckResult> {
  const response = await apiClient.post<ConsistencyCheckResult>(
    `/projects/${projectId}/consistency/check`,
    {
      scope: params.scope,
      chapter_id: params.chapterId ?? null,
      volume_id: params.volumeId ?? null,
    },
    { timeout: 300000 },
  );
  return response.data;
}

export async function analyzeConsistencyIssue(
  projectId: string,
  params: ConsistencyIssueAnalysisParams,
): Promise<ConsistencyIssueAnalysis> {
  const response = await apiClient.post<ConsistencyIssueAnalysis>(
    `/projects/${projectId}/consistency/analyze`,
    {
      scope: params.scope,
      chapter_id: params.chapterId ?? null,
      volume_id: params.volumeId ?? null,
      issue: params.issue,
    },
    { timeout: 120000 },
  );
  return response.data;
}
