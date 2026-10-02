import type { AgentMessage } from "@/lib/agent.types";

export type AgentContextCategory =
  | "conversation"
  | "chapter"
  | "character"
  | "worldEntry"
  | "outline"
  | "note";

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
  | "compactionSummary";

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
  ]),
  character: new Set(["characterList", "characterProfile", "storyMemorySearch"]),
  worldEntry: new Set(["worldEntryList", "worldEntryContent", "storyMemorySearch"]),
  outline: new Set(["storyMemorySearch"]),
  note: new Set(["noteList", "noteContent", "storyMemorySearch"]),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asCategory(value: unknown): AgentContextCategory | null {
  return value === "chapter" ||
    value === "character" ||
    value === "worldEntry" ||
    value === "outline" ||
    value === "note"
    ? value
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
