import { apiClient } from "@/lib/api-client";

export interface StoryMemoryCounts {
  characters: number;
  world_entries: number;
  outlines: number;
  notes: number;
  chapters: number;
}

export interface StoryMemoryStatus {
  project_id: string;
  embedding_configured: boolean;
  index_status: string;
  last_error: string | null;
  last_ready_at: string | null;
  rebuild_job_status: string | null;
  counts: StoryMemoryCounts;
}

export async function fetchStoryMemoryStatus(
  projectId: string,
): Promise<StoryMemoryStatus> {
  const response = await apiClient.get<StoryMemoryStatus>(
    `/projects/${projectId}/story-memory/status`,
  );
  return response.data;
}

export async function rebuildStoryMemory(
  projectId: string,
): Promise<{ job_id: string | null; enqueued: boolean }> {
  const response = await apiClient.post<{ job_id: string | null; enqueued: boolean }>(
    `/projects/${projectId}/story-memory/rebuild`,
  );
  return response.data;
}
