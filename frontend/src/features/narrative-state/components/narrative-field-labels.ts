import type { TFunction } from "i18next";

import type {
  NarrativeDetailValue,
  NarrativeFieldKey,
  NarrativeKind,
  SceneResultCategory,
} from "../lib/narrative-state-model";

/**
 * 叙事状态字段的界面文案。
 *
 * 字段标签统一走 `narrativeState.field.<key>` 约定，枚举取值走各自的枚举 key 约定。
 * 本文件只提供兜底文案：locale 里已有同 key 时以 locale 为准，
 * 尚未补入的 key 通过 defaultValue 展示，界面不会把 key 本身暴露给用户。
 */

const FIELD_LABEL_FALLBACKS: Record<NarrativeFieldKey, string> = {
  statement: "事实陈述",
  subjectRef: "主体",
  proposition: "信念命题",
  characterId: "人物",
  learnedAtChapter: "得知章节",
  title: "标题",
  description: "描述",
  currentQuestion: "当前悬念",
  payoff: "回收方式",
  relatedCharacters: "关联人物",
  sceneChapter: "所属章节",
  sceneGoal: "场景目标",
  sceneLocation: "地点",
  sceneTone: "基调",
  scenePov: "视角人物",
  scenePreconditions: "前置条件",
  sceneParticipants: "参与者",
  sceneCharacterGoals: "人物目标",
  sceneKnownInformation: "已知信息",
  sceneHiddenInformation: "隐藏信息",
  sceneActivePlotlines: "关联情节线",
  sceneWorldConstraints: "世界约束",
  sceneExpectedChanges: "预期变化",
  sceneResult: "场景结果",
  status: "状态",
  supersededById: "取代来源",
  invalidatedAt: "失效时间",
  introducedChapter: "引入章节",
  advancedChapter: "推进章节",
  relatedOutlines: "关联大纲",
  sourceType: "来源类型",
  sourceId: "来源 ID",
  sourceChapter: "来源章节",
  quoteAnchor: "定位锚点",
  createdBy: "创建者",
  confidence: "置信度",
  confirmation: "确认状态",
  confirmedAt: "确认时间",
  confirmedBy: "确认者",
  createdAt: "创建时间",
};

/** 字段标签：locale 优先，缺失时回落到兜底文案。 */
export function fieldLabel(key: NarrativeFieldKey, t: TFunction): string {
  return t(`narrativeState.field.${key}`, { defaultValue: FIELD_LABEL_FALLBACKS[key] });
}

type NarrativeEnumGroup =
  | "worldFactStatus"
  | "beliefState"
  | "plotlineState"
  | "confirmation"
  | "sourceType";

/**
 * 枚举取值的文案 key 前缀。
 * `confirmation` 与 `sourceTypes` 已有 locale；三个状态枚举使用待补的纯取值 key。
 */
const ENUM_VALUE_KEY_PREFIX: Record<NarrativeEnumGroup, string> = {
  worldFactStatus: "worldFactStatusValue",
  beliefState: "beliefStateValue",
  plotlineState: "plotlineStateValue",
  confirmation: "confirmation",
  sourceType: "sourceTypes",
};

const ENUM_VALUE_FALLBACKS: Record<NarrativeEnumGroup, Record<string, string>> = {
  worldFactStatus: {
    confirmed: "确定",
    uncertain: "不确定",
    contradicted: "存在矛盾",
    retired: "已停用",
  },
  beliefState: {
    known: "确信",
    believed: "相信",
    suspected: "怀疑",
    unknown: "未知",
    mistaken: "误信",
  },
  plotlineState: {
    open: "待展开",
    progressing: "推进中",
    resolved: "已回收",
    abandoned: "已放弃",
    uncertain: "不确定",
  },
  confirmation: {
    candidate: "候选",
    inferred: "推断",
    confirmed: "已确认",
    rejected: "已拒绝",
  },
  sourceType: {
    user: "人工录入",
    chapter: "正文",
    agent: "AI 代理",
    inference: "推断",
    outline: "大纲",
    world_info: "世界设定",
    character_profile: "人物档案",
  },
};

/** 枚举取值的纯取值文案（不带「状态：」等前缀）；未知取值原样回落。 */
export function enumValueLabel(group: NarrativeEnumGroup, value: string, t: TFunction): string {
  const fallback = ENUM_VALUE_FALLBACKS[group][value];
  if (fallback === undefined) return value;
  return t(`narrativeState.${ENUM_VALUE_KEY_PREFIX[group]}.${value}`, { defaultValue: fallback });
}

/** 状态类枚举按资源类型分组；场景计划没有状态枚举。 */
function statusEnumGroup(kind: NarrativeKind): NarrativeEnumGroup | null {
  if (kind === "worldFacts") return "worldFactStatus";
  if (kind === "characterBeliefs") return "beliefState";
  if (kind === "plotlines") return "plotlineState";
  return null;
}

/** 枚举型字段翻译为枚举文案，其余字段原样返回。 */
function detailTextValue(
  key: NarrativeFieldKey,
  value: string,
  kind: NarrativeKind,
  t: TFunction,
): string {
  if (value.length === 0) return "";
  if (key === "sourceType") return enumValueLabel("sourceType", value, t);
  if (key === "confirmation") return enumValueLabel("confirmation", value, t);
  if (key === "status") {
    const group = statusEnumGroup(kind);
    return group === null ? value : enumValueLabel(group, value, t);
  }
  return value;
}

const SCENE_RESULT_FALLBACKS: Record<SceneResultCategory, string> = {
  factChanges: "事实变化",
  beliefChanges: "信念变化",
  relationshipChanges: "关系变化",
  stateChanges: "状态变化",
  plotlineChanges: "情节线变化",
};

export function sceneResultCategoryLabel(category: SceneResultCategory, t: TFunction): string {
  return t(`narrativeState.sceneResult.${category}`, {
    defaultValue: SCENE_RESULT_FALLBACKS[category],
  });
}

/**
 * 把类型化字段值展开成可读行：文本一行、列表逐条、人物目标逐人、
 * 场景结果按五类变化加类别前缀。空值返回空数组，
 * 由调用方决定如何提示「未填写」，避免这里替界面决定空值语义。
 */
export function detailValueLines(
  key: NarrativeFieldKey,
  value: NarrativeDetailValue,
  kind: NarrativeKind,
  t: TFunction,
): string[] {
  switch (value.type) {
    case "text": {
      const text = detailTextValue(key, value.text, kind, t);
      return text.length > 0 ? [text] : [];
    }
    case "list":
      return value.items.filter((entry) => entry.length > 0);
    case "goals":
      return value.items.map((goal) => `${goal.characterId}：${goal.goal}`);
    case "sceneResult": {
      const lines: string[] = [];
      for (const group of value.groups) {
        for (const change of group.changes) {
          lines.push(`${sceneResultCategoryLabel(group.category, t)}：${change}`);
        }
      }
      return lines;
    }
  }
}
