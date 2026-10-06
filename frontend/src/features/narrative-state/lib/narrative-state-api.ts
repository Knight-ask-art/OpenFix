/**
 * 叙事状态 API 客户端。
 *
 * 所有请求都以项目为作用域，列表接口强制分页（limit / offset），
 * 确认接口必须携带读取该行时返回的 updated_at；
 * 常规创建只提交候选状态，绝不产生「已确认」。
 */

import { apiClient } from "@/lib/api-client";

import {
  buildConfirmPayload,
  buildPlotlineCandidateBody,
  buildWorldFactCandidateBody,
  NARRATIVE_PAGE_SIZE,
  pageOffset,
  parseNarrativeItem,
  parseNarrativePage,
  type NarrativeItem,
  type NarrativeKind,
  type NarrativePage,
} from "./narrative-state-model";

const ENDPOINT_SEGMENTS: Record<NarrativeKind, string> = {
  worldFacts: "world-facts",
  characterBeliefs: "character-beliefs",
  plotlines: "plotlines",
  scenePlans: "scene-plans",
};

/**
 * 查询键：`["narrative-state", kind, projectId]` 是该资源的失效前缀，
 * 带 page 的完整键只用于具体页的缓存，因此确认后只会失效同类资源。
 */
export function narrativeQueryKey(kind: NarrativeKind, projectId: string): readonly unknown[];
export function narrativeQueryKey(
  kind: NarrativeKind,
  projectId: string,
  page: number,
): readonly unknown[];
export function narrativeQueryKey(
  kind: NarrativeKind,
  projectId: string,
  page?: number,
): readonly unknown[] {
  return page === undefined
    ? ["narrative-state", kind, projectId]
    : ["narrative-state", kind, projectId, page];
}

export async function fetchNarrativePage(
  kind: NarrativeKind,
  projectId: string,
  page: number,
  signal?: AbortSignal,
): Promise<NarrativePage> {
  const offset = pageOffset(page, NARRATIVE_PAGE_SIZE);
  const response = await apiClient.get<unknown>(
    `/projects/${projectId}/narrative/${ENDPOINT_SEGMENTS[kind]}`,
    {
      params: { limit: NARRATIVE_PAGE_SIZE, offset },
      signal,
    },
  );
  return parseNarrativePage(kind, response.data, NARRATIVE_PAGE_SIZE, offset);
}

export async function confirmNarrativeItem(
  kind: NarrativeKind,
  projectId: string,
  item: NarrativeItem,
): Promise<NarrativeItem> {
  const payload = buildConfirmPayload(item);
  if (!payload) {
    throw new Error("缺少 updated_at 令牌，无法提交确认");
  }
  const response = await apiClient.post<unknown>(
    `/projects/${projectId}/narrative/${ENDPOINT_SEGMENTS[kind]}/${item.id}/confirm`,
    payload,
  );
  const confirmed = parseNarrativeItem(kind, response.data);
  if (!confirmed) {
    throw new Error("确认响应格式无效");
  }
  return confirmed;
}

export interface WorldFactCandidateInput {
  statement: string;
  subjectRef?: string;
}

export interface PlotlineCandidateInput {
  title: string;
  description?: string;
}

async function postCandidate(
  projectId: string,
  resourceSegment: string,
  kind: NarrativeKind,
  body: Record<string, unknown>,
): Promise<NarrativeItem> {
  const response = await apiClient.post<unknown>(
    `/projects/${projectId}/narrative/${resourceSegment}`,
    body,
  );
  const created = parseNarrativeItem(kind, response.data);
  if (!created) {
    throw new Error("创建响应格式无效");
  }
  return created;
}

export async function createWorldFactCandidate(
  projectId: string,
  input: WorldFactCandidateInput,
): Promise<NarrativeItem> {
  return postCandidate(
    projectId,
    ENDPOINT_SEGMENTS.worldFacts,
    "worldFacts",
    buildWorldFactCandidateBody(input),
  );
}

export async function createPlotlineCandidate(
  projectId: string,
  input: PlotlineCandidateInput,
): Promise<NarrativeItem> {
  return postCandidate(
    projectId,
    ENDPOINT_SEGMENTS.plotlines,
    "plotlines",
    buildPlotlineCandidateBody(input),
  );
}
