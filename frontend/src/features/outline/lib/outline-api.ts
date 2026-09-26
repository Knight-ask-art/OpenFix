import { apiClient } from "@/lib/api-client";

export type OutlineLevel = "book" | "arc" | "volume" | "chapter";

export const OUTLINE_LEVELS: OutlineLevel[] = ["book", "arc", "volume", "chapter"];

export interface OutlineNode {
  id: string;
  project_id: string;
  parent_id: string | null;
  volume_id: string | null;
  chapter_id: string | null;
  level: OutlineLevel;
  title: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface OutlineListResponse {
  items: OutlineNode[];
  total: number;
}

export interface OutlineCreatePayload {
  level: OutlineLevel;
  title: string;
  content?: string;
  parent_id?: string | null;
}

export interface OutlineUpdatePayload {
  title?: string;
  content?: string;
  level?: OutlineLevel;
  parent_id?: string | null;
  sort_order?: number;
}

export async function fetchOutlines(projectId: string): Promise<OutlineNode[]> {
  const response = await apiClient.get<OutlineListResponse>(
    `/projects/${projectId}/outlines`,
  );
  return response.data.items;
}

export async function createOutline(
  projectId: string,
  payload: OutlineCreatePayload,
): Promise<OutlineNode> {
  const response = await apiClient.post<OutlineNode>(
    `/projects/${projectId}/outlines`,
    payload,
  );
  return response.data;
}

export async function updateOutline(
  projectId: string,
  outlineId: string,
  payload: OutlineUpdatePayload,
): Promise<OutlineNode> {
  const response = await apiClient.patch<OutlineNode>(
    `/projects/${projectId}/outlines/${outlineId}`,
    payload,
  );
  return response.data;
}

export async function deleteOutline(
  projectId: string,
  outlineId: string,
): Promise<number> {
  const response = await apiClient.delete<{ deleted_count: number }>(
    `/projects/${projectId}/outlines/${outlineId}`,
  );
  return response.data.deleted_count;
}

export function defaultChildLevel(parent: OutlineLevel | null): OutlineLevel {
  if (parent === null) return "book";
  const index = OUTLINE_LEVELS.indexOf(parent);
  return OUTLINE_LEVELS[Math.min(index + 1, OUTLINE_LEVELS.length - 1)];
}
