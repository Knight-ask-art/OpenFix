import type { AgentMessage } from "@/lib/agent.types";

export type AgentContextCategory =
  | "conversation"
  | "chapter"
  | "character"
  | "worldEntry"
  | "outline"
  | "note"
  | "rule"
  | "skill";

export type AgentContextSourceType =
  | "chapterBody"
  | "chapterCatalog"
  | "chapterSearch"
  | "chapterSummary"
  | "rangeSummary"
  | "characterList"
  | "characterProfile"
  | "worldEntryList"
  | "worldEntryContent"
  | "noteList"
  | "noteContent"
  | "storyMemorySearch"
  | "compactionSummary"
  | "mentionReference"
  | "mentionExcerpt"
  | "availableSkill"
  | "activatedSkill"
  | "agentRules";

export interface AgentContextSource {
  id: string;
  category: AgentContextCategory;
  title: string;
  chapterOrder?: number;
  chapterStartOrder?: number;
  chapterEndOrder?: number;
  sourceTypes: AgentContextSourceType[];
}

const SOURCE_TYPES_BY_CATEGORY: Record<AgentContextCategory, Set<AgentContextSourceType>> = {
  conversation: new Set(["compactionSummary"]),
  chapter: new Set([
    "chapterBody",
    "chapterCatalog",
    "chapterSearch",
    "chapterSummary",
    "rangeSummary",
    "storyMemorySearch",
    "mentionReference",
    "mentionExcerpt",
  ]),
  character: new Set([
    "characterList",
    "characterProfile",
    "storyMemorySearch",
    "mentionReference",
  ]),
  worldEntry: new Set([
    "worldEntryList",
    "worldEntryContent",
    "storyMemorySearch",
    "mentionReference",
  ]),
  outline: new Set(["storyMemorySearch"]),
  note: new Set(["noteList", "noteContent", "storyMemorySearch", "mentionReference"]),
  rule: new Set(["agentRules"]),
  skill: new Set(["availableSkill", "activatedSkill", "mentionReference"]),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCategory(value: unknown): AgentContextCategory | null {
  // Own keys only: inherited names such as "toString" or "__proto__" are not
  // categories, and their map entries are not Sets.
  return typeof value === "string" && Object.hasOwn(SOURCE_TYPES_BY_CATEGORY, value)
    ? (value as AgentContextCategory)
    : null;
}

function getSafeSource(value: unknown): AgentContextSource | null {
  const record = asRecord(value);
  if (!record) return null;

  const category = asCategory(record.category);
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!category || !id.startsWith(`${category}:`) || id.length > 256) return null;

  const title = typeof record.title === "string" ? record.title.trim().slice(0, 160) : "";
  const sourceTypes = Array.isArray(record.sourceTypes)
    ? Array.from(
        new Set(
          record.sourceTypes.filter(
            (value): value is AgentContextSourceType =>
              typeof value === "string" &&
              SOURCE_TYPES_BY_CATEGORY[category].has(value as AgentContextSourceType),
          ),
        ),
      )
    : [];
  if (sourceTypes.length === 0) return null;

  const source: AgentContextSource = { id, category, title, sourceTypes };
  for (const key of ["chapterOrder", "chapterStartOrder", "chapterEndOrder"] as const) {
    const value = record[key];
    if (category === "chapter" && typeof value === "number" && Number.isInteger(value)) {
      source[key] = value;
    }
  }
  return source;
}

export const AGENT_CONTEXT_RUNTIME_SKIP_REASONS = [
  "no_project",
  "agent_unavailable",
  "agent_disabled",
  "note_read_disabled",
  "skill_disabled",
  "no_valid_confirmed_card",
  "token_budget",
  "dropped",
] as const;

export type AgentContextRuntimeSkipReason =
  (typeof AGENT_CONTEXT_RUNTIME_SKIP_REASONS)[number];

const RUNTIME_SKIP_REASONS = new Set<string>(AGENT_CONTEXT_RUNTIME_SKIP_REASONS);
const RUNTIME_LABEL_LIMIT = 160;
const RUNTIME_NOTE_ID_LIMIT = 128;
const RUNTIME_TOKEN_LIMIT = 2_000_000;
const RUNTIME_SHA256_RE = /^[0-9a-f]{64}$/;

export interface AgentContextRuntimeModel {
  id: string | null;
  recordId: string | null;
}

export type AgentContextRuntimeStyle =
  | {
      status: "loaded";
      noteId: string;
      sha256: string;
      tokens: number;
      budget: number;
    }
  | {
      status: "skipped";
      reason: AgentContextRuntimeSkipReason;
      tokens?: number;
      budget?: number;
    };

export interface AgentContextRuntime {
  model?: AgentContextRuntimeModel;
  style?: AgentContextRuntimeStyle;
}

function runtimeText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? Array.from(normalized).slice(0, limit).join("") : null;
}

function runtimeCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= RUNTIME_TOKEN_LIMIT
    ? value
    : null;
}

function sanitizeRuntimeModel(value: unknown): AgentContextRuntimeModel | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = runtimeText(record.id, RUNTIME_LABEL_LIMIT);
  const recordId = runtimeText(record.recordId, RUNTIME_LABEL_LIMIT);
  if (id === null && recordId === null) return null;
  return { id, recordId };
}

function sanitizeRuntimeStyle(value: unknown): AgentContextRuntimeStyle | null {
  const record = asRecord(value);
  if (!record) return null;

  if (record.status === "skipped") {
    const reason = record.reason;
    if (typeof reason !== "string" || !RUNTIME_SKIP_REASONS.has(reason)) return null;
    const style: Extract<AgentContextRuntimeStyle, { status: "skipped" }> = {
      status: "skipped",
      reason: reason as AgentContextRuntimeSkipReason,
    };
    if (reason === "token_budget") {
      const tokens = runtimeCount(record.tokens);
      const budget = runtimeCount(record.budget);
      if (tokens !== null) style.tokens = tokens;
      if (budget !== null) style.budget = budget;
    }
    return style;
  }

  if (record.status !== "loaded") return null;
  const noteId = runtimeText(record.noteId, RUNTIME_NOTE_ID_LIMIT);
  const sha256 = record.sha256;
  if (
    noteId === null ||
    typeof sha256 !== "string" ||
    sha256.length !== 64 ||
    !RUNTIME_SHA256_RE.test(sha256)
  ) {
    return null;
  }
  const tokens = runtimeCount(record.tokens);
  const budget = runtimeCount(record.budget);
  if (tokens === null || budget === null) return null;
  return { status: "loaded", noteId, sha256, tokens, budget };
}

/** Keep only bounded, content-free runtime observation fields. */
export function sanitizeAgentContextRuntime(value: unknown): AgentContextRuntime | null {
  const record = asRecord(value);
  if (!record) return null;

  const model = sanitizeRuntimeModel(record.model);
  const style = sanitizeRuntimeStyle(record.style);
  if (!model && !style) return null;

  const runtime: AgentContextRuntime = {};
  if (model) runtime.model = model;
  if (style) runtime.style = style;
  return runtime;
}

/** Read the runtime observation from the latest context snapshot only. */
export function buildAgentContextRuntime(
  messages: AgentMessage[],
): AgentContextRuntime | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== "context_snapshot") continue;
    return sanitizeAgentContextRuntime(message.payload?.context_runtime);
  }
  return null;
}

export function buildAgentContextSources(messages: AgentMessage[]): AgentContextSource[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== "context_snapshot") continue;

    const rawSources = message.payload?.context_sources;
    if (!Array.isArray(rawSources)) return [];
    return rawSources.flatMap((source) => {
      const safeSource = getSafeSource(source);
      return safeSource ? [safeSource] : [];
    });
  }
  return [];
}
