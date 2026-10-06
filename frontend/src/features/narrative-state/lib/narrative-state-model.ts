/**
 * 叙事状态（世界事实 / 人物信念 / 情节线 / 场景计划）的前端视图模型。
 *
 * 本文件不引入任何依赖，只负责把未知 JSON 收窄为强类型视图模型，
 * 因此可以被 Node 侧契约测试直接转译真实源码执行（与 lib/word-count.ts 的做法一致）。
 *
 * 两条硬约束：
 * - `updatedAt` 原样保留后端返回的字符串，确认接口必须回传读取时的同一个值；
 * - 创建的记录只能是候选 / 推断，「已确认」只能由确认接口产生。
 */

export type NarrativeKind = "worldFacts" | "characterBeliefs" | "plotlines" | "scenePlans";

export const NARRATIVE_KINDS: readonly NarrativeKind[] = [
  "worldFacts",
  "characterBeliefs",
  "plotlines",
  "scenePlans",
];

export type NarrativeConfirmationState = "candidate" | "inferred" | "confirmed" | "rejected";

export const CONFIRMATION_STATES: readonly NarrativeConfirmationState[] = [
  "candidate",
  "inferred",
  "confirmed",
  "rejected",
];

export type NarrativeSourceType =
  | "user"
  | "chapter"
  | "agent"
  | "inference"
  | "outline"
  | "world_info"
  | "character_profile";

export const SOURCE_TYPES: readonly NarrativeSourceType[] = [
  "user",
  "chapter",
  "agent",
  "inference",
  "outline",
  "world_info",
  "character_profile",
];

export type WorldFactStatus = "confirmed" | "uncertain" | "contradicted" | "retired";

export const WORLD_FACT_STATUSES: readonly WorldFactStatus[] = [
  "confirmed",
  "uncertain",
  "contradicted",
  "retired",
];

export type BeliefState = "known" | "believed" | "suspected" | "unknown" | "mistaken";

export const BELIEF_STATES: readonly BeliefState[] = [
  "known",
  "believed",
  "suspected",
  "unknown",
  "mistaken",
];

export type PlotlineState = "open" | "progressing" | "resolved" | "abandoned" | "uncertain";

export const PLOTLINE_STATES: readonly PlotlineState[] = [
  "open",
  "progressing",
  "resolved",
  "abandoned",
  "uncertain",
];

export type NarrativeFieldKey =
  // 主体内容字段
  | "statement"
  | "subjectRef"
  | "proposition"
  | "characterId"
  | "learnedAtChapter"
  | "title"
  | "description"
  | "currentQuestion"
  | "payoff"
  | "relatedCharacters"
  | "sceneChapter"
  | "sceneGoal"
  | "sceneLocation"
  | "sceneTone"
  | "scenePov"
  | "scenePreconditions"
  | "sceneParticipants"
  | "sceneCharacterGoals"
  | "sceneKnownInformation"
  | "sceneHiddenInformation"
  | "sceneActivePlotlines"
  | "sceneWorldConstraints"
  | "sceneExpectedChanges"
  | "sceneResult"
  // 状态与关联字段
  | "status"
  | "supersededById"
  | "invalidatedAt"
  | "introducedChapter"
  | "advancedChapter"
  | "relatedOutlines"
  // 溯源字段
  | "sourceType"
  | "sourceId"
  | "sourceChapter"
  | "quoteAnchor"
  | "createdBy"
  | "confidence"
  | "confirmation"
  | "confirmedAt"
  | "confirmedBy"
  | "createdAt";

export interface NarrativeField {
  key: NarrativeFieldKey;
  value: string;
}

// --- 结构化字段值 -----------------------------------------------------------

/** 场景结果的五类归档。 */
export type SceneResultCategory =
  | "factChanges"
  | "beliefChanges"
  | "relationshipChanges"
  | "stateChanges"
  | "plotlineChanges";

export const SCENE_RESULT_CATEGORIES: readonly SceneResultCategory[] = [
  "factChanges",
  "beliefChanges",
  "relationshipChanges",
  "stateChanges",
  "plotlineChanges",
];

/** 后端 result_json 的键名，与 SCENE_RESULT_CATEGORIES 一一对应。 */
const SCENE_RESULT_SOURCE_KEYS: Record<SceneResultCategory, string> = {
  factChanges: "fact_changes",
  beliefChanges: "belief_changes",
  relationshipChanges: "relationship_changes",
  stateChanges: "state_changes",
  plotlineChanges: "plotline_changes",
};

export interface SceneCharacterGoal {
  characterId: string;
  goal: string;
}

export interface SceneResultGroup {
  category: SceneResultCategory;
  changes: string[];
}

/**
 * 字段值的类型化表示：文本、字符串列表、人物目标、场景结果五类变化。
 *
 * 列表与记录保持结构，不预先压成展示字符串，
 * 这样同一份数据既能在确认前原样展示，也能逐字段参与冲突比对。
 */
export type NarrativeDetailValue =
  | { type: "text"; text: string }
  | { type: "list"; items: string[] }
  | { type: "goals"; items: SceneCharacterGoal[] }
  | { type: "sceneResult"; groups: SceneResultGroup[] };

export interface NarrativeDetail {
  key: NarrativeFieldKey;
  value: NarrativeDetailValue;
}

export interface NarrativeItem {
  id: string;
  kind: NarrativeKind;
  confirmation: NarrativeConfirmationState;
  sourceType: NarrativeSourceType;
  sourceId: string | null;
  sourceChapterId: string | null;
  quoteAnchor: string;
  createdBy: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  confidence: number | null;
  /** 资源自身的状态枚举（世界事实状态 / 信念状态 / 情节线状态）；场景计划为空串。 */
  status: string;
  createdAt: string;
  /**
   * 紧凑展示用的有序文本投影；`fields[0]` 是该条目的主体文本。
   * 只用于列表摘要，不承担「字段是否完整」的职责——完整记录见 `details`。
   */
  fields: NarrativeField[];
  /**
   * 该条目全部语义相关字段的类型化完整记录。
   *
   * 确认接口接收的是整行，因此确认前必须能看到整行：`details` 覆盖
   * 主体字段、状态字段、关联字段与结构化字段（人物目标、场景结果五类变化）。
   */
  details: NarrativeDetail[];
  /** 读取时的 updated_at 原值，仅用于确认令牌与冲突比对。 */
  updatedAt: string;
}

export interface NarrativePage {
  items: NarrativeItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 冲突中的单个字段变化；`null` 表示该侧快照里没有这个字段。 */
export interface NarrativeFieldChange {
  key: NarrativeFieldKey;
  before: NarrativeDetailValue | null;
  after: NarrativeDetailValue | null;
}

export interface NarrativeConfirmPayload {
  expected_updated_at: string;
}

export const NARRATIVE_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

// --- 未知 JSON 收窄 ---------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnumValue<T extends string>(value: string, allowed: readonly T[]): value is T {
  for (const candidate of allowed) {
    if (candidate === value) return true;
  }
  return false;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function readNullableString(source: Record<string, unknown>, key: string): string | null {
  const value = readString(source, key);
  return value.length > 0 ? value : null;
}

function readFiniteNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = readString(source, key);
  return isEnumValue(value, allowed) ? value : fallback;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function readObject(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

function textDetail(key: NarrativeFieldKey, text: string): NarrativeDetail {
  return { key, value: { type: "text", text } };
}

function listDetail(key: NarrativeFieldKey, items: string[]): NarrativeDetail {
  return { key, value: { type: "list", items } };
}

/** 人物目标：`[{character_id, goal}]`，两侧都为空白的条目直接丢弃。 */
function readSceneCharacterGoals(
  source: Record<string, unknown>,
  key: string,
): SceneCharacterGoal[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  const goals: SceneCharacterGoal[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const characterId = readString(entry, "character_id");
    const goal = readString(entry, "goal");
    if (characterId.length === 0 && goal.length === 0) continue;
    goals.push({ characterId, goal });
  }
  return goals;
}

/** 场景结果固定五类；缺失或非法载荷按空类别补齐，保证结构稳定可比对。 */
function readSceneResult(source: Record<string, unknown>, key: string): SceneResultGroup[] {
  const raw = readObject(source[key]);
  return SCENE_RESULT_CATEGORIES.map((category) => ({
    category,
    changes: readStringArray(raw, SCENE_RESULT_SOURCE_KEYS[category]),
  }));
}

/** 把响应中共享的溯源字段收窄到条目上。 */
function readProvenance(raw: Record<string, unknown>) {
  return {
    sourceType: readEnum(raw, "source_type", SOURCE_TYPES, "user"),
    sourceId: readNullableString(raw, "source_id"),
    sourceChapterId: readNullableString(raw, "source_chapter_id"),
    quoteAnchor: readString(raw, "quote_anchor"),
    createdBy: readString(raw, "created_by"),
    confirmedAt: readNullableString(raw, "confirmed_at"),
    confirmedBy: readNullableString(raw, "confirmed_by"),
    confidence: readFiniteNumber(raw, "confidence"),
  };
}

// --- 各资源的解析 -----------------------------------------------------------

export function parseWorldFact(raw: unknown): NarrativeItem | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    kind: "worldFacts",
    confirmation: readEnum(raw, "confirmation", CONFIRMATION_STATES, "candidate"),
    status: readEnum(raw, "status", WORLD_FACT_STATUSES, "uncertain"),
    createdAt: readString(raw, "created_at"),
    updatedAt: readString(raw, "updated_at"),
    fields: [
      { key: "statement", value: readString(raw, "statement") },
      { key: "subjectRef", value: readString(raw, "subject_ref") },
    ],
    details: [
      textDetail("statement", readString(raw, "statement")),
      textDetail("subjectRef", readString(raw, "subject_ref")),
      textDetail("status", readEnum(raw, "status", WORLD_FACT_STATUSES, "uncertain")),
      textDetail("supersededById", readString(raw, "superseded_by_id")),
    ],
    ...readProvenance(raw),
  };
}

export function parseCharacterBelief(raw: unknown): NarrativeItem | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    kind: "characterBeliefs",
    confirmation: readEnum(raw, "confirmation", CONFIRMATION_STATES, "candidate"),
    status: readEnum(raw, "belief_state", BELIEF_STATES, "unknown"),
    createdAt: readString(raw, "created_at"),
    updatedAt: readString(raw, "updated_at"),
    fields: [
      { key: "proposition", value: readString(raw, "proposition") },
      { key: "characterId", value: readString(raw, "character_id") },
      { key: "learnedAtChapter", value: readString(raw, "learned_at_chapter_id") },
    ],
    details: [
      textDetail("proposition", readString(raw, "proposition")),
      textDetail("characterId", readString(raw, "character_id")),
      textDetail("status", readEnum(raw, "belief_state", BELIEF_STATES, "unknown")),
      textDetail("learnedAtChapter", readString(raw, "learned_at_chapter_id")),
      textDetail("supersededById", readString(raw, "superseded_by_id")),
      textDetail("invalidatedAt", readString(raw, "invalidated_at")),
    ],
    ...readProvenance(raw),
  };
}

export function parsePlotline(raw: unknown): NarrativeItem | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  return {
    id,
    kind: "plotlines",
    confirmation: readEnum(raw, "confirmation", CONFIRMATION_STATES, "candidate"),
    status: readEnum(raw, "state", PLOTLINE_STATES, "uncertain"),
    createdAt: readString(raw, "created_at"),
    updatedAt: readString(raw, "updated_at"),
    fields: [
      { key: "title", value: readString(raw, "title") },
      { key: "description", value: readString(raw, "description") },
      { key: "currentQuestion", value: readString(raw, "current_question") },
      { key: "payoff", value: readString(raw, "payoff") },
      {
        key: "relatedCharacters",
        value: readStringArray(raw, "related_character_ids").join(", "),
      },
    ],
    details: [
      textDetail("title", readString(raw, "title")),
      textDetail("description", readString(raw, "description")),
      textDetail("currentQuestion", readString(raw, "current_question")),
      textDetail("payoff", readString(raw, "payoff")),
      textDetail("status", readEnum(raw, "state", PLOTLINE_STATES, "uncertain")),
      textDetail("introducedChapter", readString(raw, "introduced_chapter_id")),
      textDetail("advancedChapter", readString(raw, "advanced_chapter_id")),
      listDetail("relatedCharacters", readStringArray(raw, "related_character_ids")),
      listDetail("relatedOutlines", readStringArray(raw, "related_outline_ids")),
    ],
    ...readProvenance(raw),
  };
}

export function parseScenePlan(raw: unknown): NarrativeItem | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw, "id");
  if (!id) return null;
  const sceneIndex = readFiniteNumber(raw, "scene_index");
  const chapterId = readString(raw, "chapter_id");
  const sceneChapterText = sceneIndex === null ? chapterId : `${chapterId} #${sceneIndex}`;
  return {
    id,
    kind: "scenePlans",
    confirmation: readEnum(raw, "confirmation", CONFIRMATION_STATES, "candidate"),
    status: "",
    createdAt: readString(raw, "created_at"),
    updatedAt: readString(raw, "updated_at"),
    fields: [
      { key: "sceneGoal", value: readString(raw, "goal") },
      { key: "sceneChapter", value: sceneChapterText },
      { key: "sceneLocation", value: readString(raw, "location") },
      { key: "sceneTone", value: readString(raw, "tone") },
    ],
    details: [
      textDetail("sceneGoal", readString(raw, "goal")),
      textDetail("sceneChapter", sceneChapterText),
      textDetail("sceneLocation", readString(raw, "location")),
      textDetail("sceneTone", readString(raw, "tone")),
      textDetail("scenePov", readString(raw, "pov_character_id")),
      listDetail("scenePreconditions", readStringArray(raw, "preconditions")),
      listDetail("sceneParticipants", readStringArray(raw, "participants")),
      {
        key: "sceneCharacterGoals",
        value: { type: "goals", items: readSceneCharacterGoals(raw, "character_goals") },
      },
      listDetail("sceneKnownInformation", readStringArray(raw, "known_information")),
      listDetail("sceneHiddenInformation", readStringArray(raw, "hidden_information")),
      listDetail("sceneActivePlotlines", readStringArray(raw, "active_plotline_ids")),
      listDetail("sceneWorldConstraints", readStringArray(raw, "world_constraints")),
      listDetail("sceneExpectedChanges", readStringArray(raw, "expected_changes")),
      {
        key: "sceneResult",
        value: { type: "sceneResult", groups: readSceneResult(raw, "result") },
      },
    ],
    ...readProvenance(raw),
  };
}

const PARSERS: Record<NarrativeKind, (raw: unknown) => NarrativeItem | null> = {
  worldFacts: parseWorldFact,
  characterBeliefs: parseCharacterBelief,
  plotlines: parsePlotline,
  scenePlans: parseScenePlan,
};

export function parseNarrativeItem(kind: NarrativeKind, raw: unknown): NarrativeItem | null {
  return PARSERS[kind](raw);
}

/** 解析分页列表响应；缺失或非法的分页元数据回落到请求侧取值。 */
export function parseNarrativePage(
  kind: NarrativeKind,
  raw: unknown,
  fallbackLimit: number,
  fallbackOffset: number,
): NarrativePage {
  const source = readObject(raw);
  const rawItems = source.items;
  const items = Array.isArray(rawItems)
    ? rawItems.flatMap((entry) => {
        const parsed = parseNarrativeItem(kind, entry);
        return parsed === null ? [] : [parsed];
      })
    : [];
  const total = readFiniteNumber(source, "total");
  return {
    items,
    total: total === null ? items.length : Math.max(0, total),
    limit: readFiniteNumber(source, "limit") ?? fallbackLimit,
    offset: readFiniteNumber(source, "offset") ?? fallbackOffset,
  };
}

// --- 分页 -------------------------------------------------------------------

export function pageOffset(page: number, pageSize: number = NARRATIVE_PAGE_SIZE): number {
  return Math.max(0, Math.floor(page) - 1) * pageSize;
}

export function pageCount(total: number, pageSize: number = NARRATIVE_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function clampPage(
  page: number,
  total: number,
  pageSize: number = NARRATIVE_PAGE_SIZE,
): number {
  const lastPage = pageCount(total, pageSize);
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), lastPage);
}

// --- 确认 -------------------------------------------------------------------

/** 主体文本（fields[0]）；没有字段时回落到空串。 */
export function primaryFieldValue(item: NarrativeItem): string {
  const [primary] = item.fields;
  return primary ? primary.value : "";
}

/** 缺少 updated_at 令牌的行不允许提交确认，避免把空令牌发给后端。 */
export function buildConfirmPayload(item: NarrativeItem): NarrativeConfirmPayload | null {
  if (item.updatedAt.length === 0) return null;
  return { expected_updated_at: item.updatedAt };
}

/** 已确认的记录不再提供确认入口。 */
export function canConfirm(item: NarrativeItem): boolean {
  return item.confirmation !== "confirmed" && buildConfirmPayload(item) !== null;
}

export type NarrativeConfirmFailure = "conflict" | "error";

/**
 * 区分确认失败的两条路径：
 * - conflict（409）：读取后被改写，必须刷新并展示变更，不允许自动重试确认；
 * - error：其他错误，只提示失败。
 */
export function classifyConfirmFailure(error: unknown): NarrativeConfirmFailure {
  return isHttpStatusError(error, 409) ? "conflict" : "error";
}

export interface WorldFactCandidateInput {
  statement: string;
  subjectRef?: string;
}

export interface PlotlineCandidateInput {
  title: string;
  description?: string;
}

/** 常规创建的请求体：显式候选状态，绝不携带已确认。 */
export function buildWorldFactCandidateBody(
  input: WorldFactCandidateInput,
): Record<string, unknown> {
  const subjectRef = input.subjectRef?.trim() ?? "";
  return {
    statement: input.statement,
    subject_ref: subjectRef.length > 0 ? subjectRef : null,
    confirmation: "candidate",
    source_type: "user",
  };
}

export function buildPlotlineCandidateBody(input: PlotlineCandidateInput): Record<string, unknown> {
  const description = input.description?.trim() ?? "";
  return {
    title: input.title,
    description: description.length > 0 ? description : null,
    confirmation: "candidate",
    source_type: "user",
  };
}

/**
 * 溯源字段也进入比对：来源、置信度、确认状态与确认者的变化
 * 同样会影响「这条记录还是不是你看到的那条」，不允许被隐藏。
 */
function provenanceDetails(item: NarrativeItem): NarrativeDetail[] {
  return [
    textDetail("sourceType", item.sourceType),
    textDetail("sourceId", item.sourceId ?? ""),
    textDetail("sourceChapter", item.sourceChapterId ?? ""),
    textDetail("quoteAnchor", item.quoteAnchor),
    textDetail("createdBy", item.createdBy),
    textDetail("confidence", item.confidence === null ? "" : String(item.confidence)),
    textDetail("confirmation", item.confirmation),
    textDetail("confirmedAt", item.confirmedAt ?? ""),
    textDetail("confirmedBy", item.confirmedBy ?? ""),
    textDetail("createdAt", item.createdAt),
  ];
}

/**
 * 参与冲突比对的完整字段集合：内容字段 + 溯源字段。
 * 唯一不参与的是 updated_at —— 它是确认令牌本身，冲突时必然不同。
 */
export function comparableDetails(item: NarrativeItem): NarrativeDetail[] {
  return [...item.details, ...provenanceDetails(item)];
}

/** 结构化的比对签名：列表与记录按结构比较，避免拼接后的字符串互相掩盖。 */
function detailSignature(value: NarrativeDetailValue): string {
  switch (value.type) {
    case "text":
      return `text:${value.text}`;
    case "list":
      return `list:${JSON.stringify(value.items)}`;
    case "goals":
      return `goals:${JSON.stringify(value.items.map((goal) => [goal.characterId, goal.goal]))}`;
    case "sceneResult":
      return `sceneResult:${JSON.stringify(
        value.groups.map((group) => [group.category, group.changes]),
      )}`;
  }
}

/** 字段值的普通 JSON 形态，供完整记录视图直接序列化。 */
export function detailJsonValue(value: NarrativeDetailValue): unknown {
  switch (value.type) {
    case "text":
      return value.text;
    case "list":
      return value.items;
    case "goals":
      return value.items.map((goal) => ({ characterId: goal.characterId, goal: goal.goal }));
    case "sceneResult": {
      const result: Record<string, string[]> = {};
      for (const group of value.groups) result[group.category] = group.changes;
      return result;
    }
  }
}

/** 完整记录视图：内容字段按 key 展开，溯源字段单列，updated_at 一并保留。 */
export function narrativeRecordView(item: NarrativeItem): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const detail of item.details) values[detail.key] = detailJsonValue(detail.value);
  const provenance: Record<string, unknown> = {};
  for (const detail of provenanceDetails(item)) {
    provenance[detail.key] = detailJsonValue(detail.value);
  }
  return { id: item.id, kind: item.kind, values, provenance, updatedAt: item.updatedAt };
}

/** 确认前可展开查看的完整记录（缩进 JSON 文本）。 */
export function serializeNarrativeRecord(item: NarrativeItem): string {
  return JSON.stringify(narrativeRecordView(item), null, 2);
}

/**
 * 逐字段比较同一条目的前后快照，用于 409 冲突后展示「变的是什么」。
 * 覆盖内容字段与溯源字段；updated_at 是确认令牌本身，不参与比对。
 */
export function changedFields(
  previous: NarrativeItem,
  current: NarrativeItem,
): NarrativeFieldChange[] {
  const previousDetails = comparableDetails(previous);
  const currentDetails = comparableDetails(current);
  const beforeByKey = new Map(previousDetails.map((detail) => [detail.key, detail.value]));
  const afterByKey = new Map(currentDetails.map((detail) => [detail.key, detail.value]));
  const keys: NarrativeFieldKey[] = [];
  for (const detail of [...previousDetails, ...currentDetails]) {
    if (!keys.includes(detail.key)) keys.push(detail.key);
  }
  const changes: NarrativeFieldChange[] = [];
  for (const key of keys) {
    const before = beforeByKey.get(key) ?? null;
    const after = afterByKey.get(key) ?? null;
    if (before === null && after === null) continue;
    if (before !== null && after !== null && detailSignature(before) === detailSignature(after)) {
      continue;
    }
    changes.push({ key, before, after });
  }
  return changes;
}

/** 冲突提示里的文本预览上限，避免把超长条目整段铺进提示区。 */
export const CONFLICT_PREVIEW_LENGTH = 160;

export function previewText(value: string, maxLength: number = CONFLICT_PREVIEW_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

// --- 传输错误（不依赖 axios，按响应形状判定） --------------------------------

export function isHttpStatusError(error: unknown, status: number): boolean {
  if (!isRecord(error)) return false;
  const response = error.response;
  if (!isRecord(response)) return false;
  return response.status === status;
}

export function errorDetail(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const response = error.response;
  if (!isRecord(response)) return null;
  const data = response.data;
  if (!isRecord(data)) return null;
  const detail = data.detail;
  return typeof detail === "string" && detail.length > 0 ? detail : null;
}
