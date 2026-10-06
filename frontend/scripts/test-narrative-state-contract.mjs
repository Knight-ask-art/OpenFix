/**
 * 叙事状态确认链路的契约回归（Node 运行，不启动浏览器、不访问网络）。
 *
 * 直接转译真实源码 src/features/narrative-state/lib/narrative-state-model.ts 后执行，
 * 不复制其中的解析、确认令牌、冲突判定与分页规则：被测的就是生产实现本身。
 *
 * 覆盖：
 * - 四类资源的未知 JSON 收窄（枚举回落、缺字段、非法条目过滤）；
 * - 场景计划在确认前即可核对视角、参与者、隐藏信息、预期变化与场景结果；
 * - 确认令牌原样回传（naive 与带偏移两种时间戳都不得被改写）；
 * - 409 被判为冲突而不是普通错误，并按字段展示变更前后的内容；
 * - 状态、关联与溯源字段的变化都不会在冲突比对中被隐藏（updated_at 令牌除外）；
 * - 手工录入的候选请求体绝不包含已确认状态；
 * - 分页边界（页码、偏移、越界回收）；
 * - 源码级接线检查（确认接口路径、分页参数、完整字段面板、组件确实使用被测判定函数）；
 * - 中英文案 key 对齐，且新增文案不含 Emoji。
 *
 * 所有数据都是合成值，不读取真实项目、数据库或网络。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const featureDir = path.resolve(here, "../src/features/narrative-state");
const modelPath = path.join(featureDir, "lib/narrative-state-model.ts");
const apiPath = path.join(featureDir, "lib/narrative-state-api.ts");
const rowPath = path.join(featureDir, "components/narrative-item-row.tsx");
const detailsPanelPath = path.join(featureDir, "components/narrative-details-panel.tsx");
const labelsPath = path.join(featureDir, "components/narrative-field-labels.ts");
const sectionPath = path.join(featureDir, "components/narrative-state-section.tsx");
const candidateFormPath = path.join(featureDir, "components/narrative-candidate-form.tsx");
const storyMemoryPagePath = path.resolve(
  here,
  "../src/features/story-memory/pages/story-memory-page.tsx",
);
const localePaths = {
  "zh-CN": path.resolve(here, "../src/i18n/locales/zh-CN.json"),
  en: path.resolve(here, "../src/i18n/locales/en.json"),
};

let checks = 0;
let failures = 0;

/** 记录一次断言，失败时打印可定位的标签。 */
function check(label, run) {
  checks += 1;
  try {
    run();
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 需要读取文件的断言：必须 await，否则失败会被吞掉。 */
async function checkAsync(label, run) {
  checks += 1;
  try {
    await run();
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 沿用已有脚本的 TS 转译导入方式：转译为 ESM 后从内存模块导入。 */
async function loadTsModule(absolutePath) {
  const source = await readFile(absolutePath, "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  if (diagnostics && diagnostics.length > 0) {
    for (const diagnostic of diagnostics) {
      console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    }
    throw new Error(`transpile failed: ${absolutePath}`);
  }
  const base64 = Buffer.from(outputText, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${base64}`);
}

const model = await loadTsModule(modelPath);
const modelSource = await readFile(modelPath, "utf8");

const PROJECT_ID = "synthetic-project";
/** SQLite 风格的 naive 时间戳：确认时必须原样回传，不能被补成 UTC 标记。 */
const TIMESTAMP_NAIVE = "2026-10-05T08:00:00";
/** 带时区偏移的时间戳：同样必须原样回传。 */
const TIMESTAMP_OFFSET = "2026-10-05T16:00:00+08:00";
const CONFLICT_DETAIL = "世界事实已被修改，请刷新后重新确认";

function worldFactPayload(overrides = {}) {
  return {
    id: "fact-1",
    project_id: PROJECT_ID,
    statement: "北境关口只在冬季开放",
    subject_ref: "北境关口",
    status: "uncertain",
    superseded_by_id: null,
    source_type: "inference",
    source_id: "chapter-3",
    source_chapter_id: "chapter-3",
    quote_anchor: "第 3 章 第 12 段",
    created_by: "reviewer",
    confidence: 0.62,
    confirmation: "candidate",
    confirmed_at: null,
    confirmed_by: null,
    created_at: TIMESTAMP_NAIVE,
    updated_at: TIMESTAMP_NAIVE,
    ...overrides,
  };
}

function beliefPayload(overrides = {}) {
  return {
    id: "belief-1",
    project_id: PROJECT_ID,
    character_id: "char-9",
    proposition: "她相信队长还活着",
    belief_state: "believed",
    learned_at_chapter_id: "chapter-7",
    superseded_by_id: null,
    invalidated_at: null,
    source_type: "chapter",
    source_id: null,
    source_chapter_id: "chapter-7",
    quote_anchor: "",
    created_by: "",
    confidence: null,
    confirmation: "inferred",
    confirmed_at: null,
    confirmed_by: null,
    created_at: TIMESTAMP_NAIVE,
    updated_at: TIMESTAMP_NAIVE,
    ...overrides,
  };
}

function plotlinePayload(overrides = {}) {
  return {
    id: "plot-1",
    project_id: PROJECT_ID,
    title: "失踪的哨兵",
    description: "哨兵失踪引出边境阴谋",
    current_question: "哨兵是否叛逃",
    payoff: "在第三卷揭示哨兵被俘",
    state: "progressing",
    introduced_chapter_id: "chapter-1",
    advanced_chapter_id: null,
    related_character_ids: ["char-1", "", 42, "char-2"],
    related_outline_ids: [],
    source_type: "outline",
    source_id: "outline-1",
    source_chapter_id: null,
    quote_anchor: "",
    created_by: "planner",
    confidence: 0.4,
    confirmation: "candidate",
    confirmed_at: null,
    confirmed_by: null,
    created_at: TIMESTAMP_NAIVE,
    updated_at: TIMESTAMP_OFFSET,
    ...overrides,
  };
}

const EMPTY_SCENE_RESULT = {
  fact_changes: [],
  belief_changes: [],
  relationship_changes: [],
  state_changes: [],
  plotline_changes: [],
};

function scenePlanPayload(overrides = {}) {
  return {
    id: "scene-1",
    project_id: PROJECT_ID,
    chapter_id: "chapter-4",
    scene_index: 2,
    goal: "让主角发现密道",
    pov_character_id: "char-1",
    location: "旧钟楼",
    tone: "压抑",
    preconditions: ["旧钟楼在夜间上锁"],
    participants: ["char-1", "char-2"],
    character_goals: [{ character_id: "char-1", goal: "查明钟声来源" }],
    known_information: ["守夜人每晚巡楼"],
    hidden_information: ["密道入口只有守夜人知道"],
    active_plotline_ids: ["plot-1"],
    world_constraints: ["钟楼内禁止点火"],
    expected_changes: ["主角掌握密道位置"],
    result: EMPTY_SCENE_RESULT,
    source_type: "agent",
    source_id: null,
    source_chapter_id: "chapter-4",
    quote_anchor: "",
    created_by: "agent",
    confidence: null,
    confirmation: "candidate",
    confirmed_at: null,
    confirmed_by: null,
    created_at: TIMESTAMP_NAIVE,
    updated_at: TIMESTAMP_NAIVE,
    ...overrides,
  };
}

/** 取某条目的某个类型化字段值，断言缺字段时立即失败。 */
function detailValue(item, key) {
  const detail = item.details.find((entry) => entry.key === key);
  assert.ok(detail, `条目缺少字段 ${key}`);
  return detail.value;
}

// ============================================================
// 1. 解析：未知 JSON -> 强类型视图模型
// ============================================================

check("世界事实解析主体字段与溯源", () => {
  const item = model.parseWorldFact(worldFactPayload());

  assert.equal(item.kind, "worldFacts");
  assert.equal(item.fields[0].key, "statement");
  assert.equal(item.fields[0].value, "北境关口只在冬季开放");
  assert.equal(item.fields[1].key, "subjectRef");
  assert.equal(item.fields[1].value, "北境关口");
  assert.equal(item.status, "uncertain");
  assert.equal(item.confirmation, "candidate");
  assert.equal(item.sourceType, "inference");
  assert.equal(item.sourceChapterId, "chapter-3");
  assert.equal(item.quoteAnchor, "第 3 章 第 12 段");
  assert.equal(item.createdBy, "reviewer");
  assert.equal(item.confidence, 0.62);
  assert.equal(item.confirmedAt, null);
});

check("确认令牌原样保留 naive 时间戳", () => {
  const item = model.parseWorldFact(worldFactPayload());

  assert.equal(item.updatedAt, TIMESTAMP_NAIVE);
  assert.ok(!item.updatedAt.endsWith("Z"));
});

check("未知枚举回落到安全默认值", () => {
  const item = model.parseWorldFact(
    worldFactPayload({ confirmation: "whatever", status: "not-a-status", statement: undefined }),
  );

  assert.equal(item.confirmation, "candidate");
  assert.equal(item.status, "uncertain");
  assert.equal(item.fields[0].value, "");
});

check("缺少 id 或非对象载荷被拒绝", () => {
  assert.equal(model.parseWorldFact({ ...worldFactPayload(), id: "" }), null);
  assert.equal(model.parseWorldFact(null), null);
  assert.equal(model.parseWorldFact([worldFactPayload()]), null);
  assert.equal(model.parseNarrativeItem("worldFacts", "not-an-object"), null);
});

check("人物信念解析命题与信念状态", () => {
  const item = model.parseCharacterBelief(beliefPayload());

  assert.equal(item.kind, "characterBeliefs");
  assert.equal(item.fields[0].value, "她相信队长还活着");
  assert.equal(item.status, "believed");
  assert.equal(item.confirmation, "inferred");
  assert.equal(item.sourceId, null);
  assert.equal(item.confidence, null);
  assert.equal(item.fields.find((field) => field.key === "learnedAtChapter").value, "chapter-7");
});

check("人物信念未知信念状态回落为 unknown", () => {
  const item = model.parseCharacterBelief({ id: "belief-2", belief_state: "?" });

  assert.equal(item.status, "unknown");
  assert.equal(item.confirmation, "candidate");
});

check("情节线解析标题、状态与关联人物", () => {
  const item = model.parsePlotline(plotlinePayload());

  assert.equal(item.fields[0].value, "失踪的哨兵");
  assert.equal(item.status, "progressing");
  assert.equal(item.sourceType, "outline");
  assert.equal(item.updatedAt, TIMESTAMP_OFFSET);
  const related = item.fields.find((field) => field.key === "relatedCharacters");
  assert.equal(related.value, "char-1, char-2");
});

check("场景计划解析场景目标与所属场景位置", () => {
  const item = model.parseScenePlan(scenePlanPayload());

  assert.equal(item.kind, "scenePlans");
  assert.equal(item.fields[0].value, "让主角发现密道");
  assert.equal(item.status, "");
  assert.equal(item.fields.find((field) => field.key === "sceneChapter").value, "chapter-4 #2");
});

check("场景计划在确认前即可核对全部语义字段", () => {
  const item = model.parseScenePlan(scenePlanPayload());
  const keys = item.details.map((detail) => detail.key);

  // 确认接口接收的是整行：视角、参与者、前置条件、信息投放、预期变化与结果都要能看到。
  for (const key of [
    "sceneGoal",
    "sceneChapter",
    "sceneLocation",
    "sceneTone",
    "scenePov",
    "scenePreconditions",
    "sceneParticipants",
    "sceneCharacterGoals",
    "sceneKnownInformation",
    "sceneHiddenInformation",
    "sceneActivePlotlines",
    "sceneWorldConstraints",
    "sceneExpectedChanges",
    "sceneResult",
  ]) {
    assert.ok(keys.includes(key), `场景计划缺少字段 ${key}`);
  }

  assert.equal(detailValue(item, "scenePov").text, "char-1");
  assert.deepEqual(detailValue(item, "scenePreconditions"), {
    type: "list",
    items: ["旧钟楼在夜间上锁"],
  });
  assert.deepEqual(detailValue(item, "sceneHiddenInformation"), {
    type: "list",
    items: ["密道入口只有守夜人知道"],
  });
  assert.deepEqual(detailValue(item, "sceneCharacterGoals"), {
    type: "goals",
    items: [{ characterId: "char-1", goal: "查明钟声来源" }],
  });

  // 场景结果固定五类，确认前即可逐类核对，而不是整块 JSON 糊在一起。
  const result = detailValue(item, "sceneResult");
  assert.equal(result.type, "sceneResult");
  assert.deepEqual(
    result.groups.map((group) => group.category),
    model.SCENE_RESULT_CATEGORIES,
  );
});

check("场景计划缺字段时按空值补齐，不产生虚假内容", () => {
  const item = model.parseScenePlan({ id: "scene-2", chapter_id: "chapter-5" });

  assert.equal(detailValue(item, "scenePov").text, "");
  assert.deepEqual(detailValue(item, "sceneParticipants"), { type: "list", items: [] });
  assert.deepEqual(detailValue(item, "sceneCharacterGoals"), { type: "goals", items: [] });
  assert.deepEqual(
    detailValue(item, "sceneResult").groups.map((group) => group.changes),
    [[], [], [], [], []],
  );
  // 结构非法时同样回落到空列表，不抛错。
  const malformed = model.parseScenePlan(
    scenePlanPayload({ participants: "not-a-list", character_goals: [null, { goal: "" }] }),
  );
  assert.deepEqual(detailValue(malformed, "sceneParticipants"), { type: "list", items: [] });
  assert.deepEqual(detailValue(malformed, "sceneCharacterGoals"), { type: "goals", items: [] });
});

check("分页响应过滤非法条目并保留后端分页元数据", () => {
  const page = model.parseNarrativePage(
    "worldFacts",
    {
      items: [
        worldFactPayload({ id: "fact-1" }),
        null,
        { id: "" },
        worldFactPayload({ id: "fact-2" }),
      ],
      total: 7,
      limit: 2,
      offset: 2,
    },
    20,
    0,
  );

  assert.deepEqual(
    page.items.map((item) => item.id),
    ["fact-1", "fact-2"],
  );
  assert.equal(page.total, 7);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 2);
});

check("分页响应缺少元数据时回落到请求侧取值", () => {
  const page = model.parseNarrativePage("worldFacts", { items: [worldFactPayload()] }, 20, 40);

  assert.equal(page.total, 1);
  assert.equal(page.limit, 20);
  assert.equal(page.offset, 40);
});

check("分页响应 items 不是数组时按空列表处理", () => {
  const page = model.parseNarrativePage("plotlines", { items: "nope", total: 3 }, 20, 0);

  assert.deepEqual(page.items, []);
  assert.equal(page.total, 3);
});

// ============================================================
// 2. 确认令牌：必须是读取时的原值
// ============================================================

check("确认请求体使用读取时的 updated_at 原值", () => {
  for (const timestamp of [TIMESTAMP_NAIVE, TIMESTAMP_OFFSET]) {
    const item = model.parseWorldFact(worldFactPayload({ updated_at: timestamp }));
    const payload = model.buildConfirmPayload(item);

    assert.deepEqual(payload, { expected_updated_at: timestamp });
    assert.equal(
      JSON.stringify(payload),
      `{"expected_updated_at":"${timestamp}"}`,
      "确认令牌不得被重新格式化",
    );
  }
});

check("缺少 updated_at 时不产生确认请求体", () => {
  const item = model.parseWorldFact(worldFactPayload({ updated_at: undefined }));

  assert.equal(item.updatedAt, "");
  assert.equal(model.buildConfirmPayload(item), null);
  assert.equal(model.canConfirm(item), false);
});

check("已确认的记录不再提供确认入口", () => {
  const confirmed = model.parseWorldFact(worldFactPayload({ confirmation: "confirmed" }));
  const candidate = model.parseWorldFact(worldFactPayload({ confirmation: "candidate" }));

  assert.equal(model.canConfirm(confirmed), false);
  assert.equal(model.canConfirm(candidate), true);
  for (const state of ["inferred", "rejected"]) {
    assert.equal(
      model.canConfirm(model.parseWorldFact(worldFactPayload({ confirmation: state }))),
      true,
    );
  }
});

// ============================================================
// 3. 409 冲突：判定、说明与变更展示
// ============================================================

check("409 被判为冲突，其他错误被判为普通错误", () => {
  assert.equal(model.classifyConfirmFailure({ response: { status: 409 } }), "conflict");
  assert.equal(model.classifyConfirmFailure({ response: { status: 500 } }), "error");
  assert.equal(model.classifyConfirmFailure(new Error("network")), "error");
  assert.equal(model.classifyConfirmFailure(null), "error");
});

check("冲突说明取自后端响应", () => {
  const error = { response: { status: 409, data: { detail: CONFLICT_DETAIL } } };

  assert.equal(model.errorDetail(error), CONFLICT_DETAIL);
  assert.equal(model.errorDetail(new Error("network")), null);
  assert.equal(model.errorDetail({ response: { status: 409, data: { detail: "" } } }), null);
});

check("刷新后按字段给出变更前后内容，状态变化不被隐藏", () => {
  const before = model.parseWorldFact(worldFactPayload());
  const after = model.parseWorldFact(
    worldFactPayload({ statement: "北境关口全年开放", status: "contradicted" }),
  );
  const changes = model.changedFields(before, after);

  assert.deepEqual(
    changes.map((change) => change.key),
    ["statement", "status"],
    "文本与状态变化都要报告",
  );
  assert.deepEqual(changes[0].before, { type: "text", text: "北境关口只在冬季开放" });
  assert.deepEqual(changes[0].after, { type: "text", text: "北境关口全年开放" });
  assert.deepEqual(changes[1].before, { type: "text", text: "uncertain" });
  assert.deepEqual(changes[1].after, { type: "text", text: "contradicted" });
});

check("同一次读取的两份快照之间没有变更", () => {
  const before = model.parseWorldFact(worldFactPayload());
  const after = model.parseWorldFact(worldFactPayload());

  assert.deepEqual(model.changedFields(before, after), []);
});

check("他人抢先确认导致的产物变化同样会被报告", () => {
  const before = model.parseWorldFact(worldFactPayload());
  const after = model.parseWorldFact(
    worldFactPayload({
      confirmation: "confirmed",
      confirmed_at: TIMESTAMP_OFFSET,
      confirmed_by: "another-user",
      updated_at: TIMESTAMP_OFFSET,
    }),
  );

  assert.deepEqual(
    model.changedFields(before, after).map((change) => change.key),
    ["confirmation", "confirmedAt", "confirmedBy"],
  );
});

check("只有 updated_at 变化时不产生内容变更", () => {
  const before = model.parseWorldFact(worldFactPayload());
  const after = model.parseWorldFact(worldFactPayload({ updated_at: "2026-10-05T10:00:00" }));

  assert.deepEqual(model.changedFields(before, after), []);
  assert.notEqual(before.updatedAt, after.updatedAt, "确认令牌本身确实变了");
});

check("溯源字段的变化不会被隐藏", () => {
  const before = model.parseWorldFact(worldFactPayload());
  const after = model.parseWorldFact(
    worldFactPayload({
      source_type: "agent",
      source_chapter_id: "chapter-9",
      quote_anchor: "第 9 章 第 2 段",
      confidence: 0.9,
      superseded_by_id: "fact-2",
    }),
  );

  assert.deepEqual(
    model.changedFields(before, after).map((change) => change.key),
    ["supersededById", "sourceType", "sourceChapter", "quoteAnchor", "confidence"],
  );
});

check("可比对字段集合覆盖内容、状态与溯源", () => {
  const keys = model
    .comparableDetails(model.parseWorldFact(worldFactPayload()))
    .map((detail) => detail.key);

  for (const key of [
    "statement",
    "subjectRef",
    "status",
    "supersededById",
    "sourceType",
    "sourceId",
    "sourceChapter",
    "quoteAnchor",
    "createdBy",
    "confidence",
    "confirmation",
    "confirmedAt",
    "confirmedBy",
    "createdAt",
  ]) {
    assert.ok(keys.includes(key), `比对集合缺少字段 ${key}`);
  }
  assert.ok(!keys.includes("updatedAt"), "updated_at 是确认令牌，不参与比对");
});

check("人物信念的状态、取代关系与失效时间变化会被报告", () => {
  const before = model.parseCharacterBelief(beliefPayload());
  const after = model.parseCharacterBelief(
    beliefPayload({
      belief_state: "mistaken",
      superseded_by_id: "belief-9",
      invalidated_at: "2026-10-05T09:00:00",
    }),
  );

  assert.deepEqual(
    model.changedFields(before, after).map((change) => change.key),
    ["status", "supersededById", "invalidatedAt"],
  );
});

check("情节线的状态、章节关联与关联人物变化会被报告", () => {
  const before = model.parsePlotline(plotlinePayload());
  const after = model.parsePlotline(
    plotlinePayload({
      state: "resolved",
      advanced_chapter_id: "chapter-12",
      related_character_ids: ["char-1"],
      related_outline_ids: ["outline-7"],
    }),
  );

  assert.deepEqual(
    model.changedFields(before, after).map((change) => change.key),
    ["status", "advancedChapter", "relatedCharacters", "relatedOutlines"],
  );
});

check("隐藏信息 / 预期变化 / 场景结果的改动在确认前可见、在冲突中必报", () => {
  const before = model.parseScenePlan(scenePlanPayload());
  const after = model.parseScenePlan(
    scenePlanPayload({
      hidden_information: ["密道入口只有守夜人知道", "守夜人已被收买"],
      expected_changes: ["主角掌握密道位置", "主角开始怀疑守夜人"],
      result: { ...EMPTY_SCENE_RESULT, fact_changes: ["钟楼三层存在密道"] },
      updated_at: "2026-10-05T11:00:00",
    }),
  );

  const changes = model.changedFields(before, after);
  assert.deepEqual(
    changes.map((change) => change.key),
    ["sceneHiddenInformation", "sceneExpectedChanges", "sceneResult"],
  );

  const hidden = changes.find((change) => change.key === "sceneHiddenInformation");
  assert.deepEqual(hidden.before.items, ["密道入口只有守夜人知道"]);
  assert.deepEqual(hidden.after.items, ["密道入口只有守夜人知道", "守夜人已被收买"]);

  const result = changes.find((change) => change.key === "sceneResult");
  assert.deepEqual(result.after.groups.find((group) => group.category === "factChanges").changes, [
    "钟楼三层存在密道",
  ]);
  assert.deepEqual(
    result.before.groups.find((group) => group.category === "factChanges").changes,
    [],
  );

  // 只改场景结果的「结果字段」也必须被报告，而不是判成「没有文本变化」。
  const resultOnly = model.changedFields(
    before,
    model.parseScenePlan(
      scenePlanPayload({
        result: { ...EMPTY_SCENE_RESULT, plotline_changes: ["密道支线开启"] },
        updated_at: "2026-10-05T11:30:00",
      }),
    ),
  );
  assert.deepEqual(
    resultOnly.map((change) => change.key),
    ["sceneResult"],
  );

  // 场景计划的视角与参与者变化同样必须被报告。
  const castOnly = model.changedFields(
    before,
    model.parseScenePlan(
      scenePlanPayload({ pov_character_id: "char-3", participants: ["char-3"] }),
    ),
  );
  assert.deepEqual(
    castOnly.map((change) => change.key),
    ["scenePov", "sceneParticipants"],
  );
});

check("完整记录视图保留结构化字段与确认令牌", () => {
  const item = model.parseScenePlan(scenePlanPayload());
  const view = model.narrativeRecordView(item);
  const text = model.serializeNarrativeRecord(item);

  assert.equal(view.updatedAt, TIMESTAMP_NAIVE, "记录视图必须带上确认令牌原值");
  assert.deepEqual(view.values.sceneHiddenInformation, ["密道入口只有守夜人知道"]);
  assert.deepEqual(view.values.sceneCharacterGoals, [
    { characterId: "char-1", goal: "查明钟声来源" },
  ]);
  assert.deepEqual(view.values.sceneResult.factChanges, []);
  assert.equal(view.provenance.sourceType, "agent");
  assert.ok(text.includes("\n  "), "记录视图必须是缩进 JSON，而不是压成一行");
  assert.equal(JSON.parse(text).updatedAt, TIMESTAMP_NAIVE);
});

check("变更预览有长度上限并折叠空白", () => {
  const longText = `第一行\n第二行 ${"很长".repeat(200)}`;
  const preview = model.previewText(longText);

  assert.ok(preview.length <= model.CONFLICT_PREVIEW_LENGTH + 1);
  assert.ok(preview.endsWith("…"));
  assert.ok(!preview.includes("\n"));
  assert.equal(model.previewText("  短  文本  "), "短 文本");
});

// ============================================================
// 4. 确认往返（合成服务端，仅验证被测的生产函数）
// ============================================================

/**
 * 合成确认往返：服务端持有当前行，只有令牌与当前 updated_at 完全一致才接受。
 * @param {object} options
 * @param {object} options.readItem 客户端读取到的条目
 * @param {object} options.serverItem 服务端当前行
 */
function confirmRoundTrip({ readItem, serverItem }) {
  const requests = [];
  const payload = model.buildConfirmPayload(readItem);
  if (payload === null) {
    return { requests, outcome: "blocked" };
  }
  requests.push({ id: readItem.id, body: payload });
  if (payload.expected_updated_at !== serverItem.updated_at) {
    return {
      requests,
      outcome: "rejected",
      error: {
        response: { status: 409, data: { detail: CONFLICT_DETAIL } },
      },
    };
  }
  return { requests, outcome: "confirmed", item: model.parseWorldFact(serverItem) };
}

check("令牌与当前行一致时确认成功", () => {
  const readItem = model.parseWorldFact(worldFactPayload());
  const serverItem = worldFactPayload({ confirmation: "candidate" });
  const result = confirmRoundTrip({ readItem, serverItem });

  assert.equal(result.outcome, "confirmed");
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.requests[0].body, { expected_updated_at: TIMESTAMP_NAIVE });
  assert.equal(model.classifyConfirmFailure(result.error), "error", "没有错误时不构成冲突");
});

check("行在被改写后确认被拒：判为冲突、可展示变更、且不自动重试", () => {
  const readItem = model.parseWorldFact(worldFactPayload());
  const serverItem = worldFactPayload({
    statement: "北境关口全年开放",
    updated_at: "2026-10-05T09:30:00",
  });
  const result = confirmRoundTrip({ readItem, serverItem });

  assert.equal(result.outcome, "rejected");
  assert.equal(result.requests.length, 1, "确认只能提交一次，不得自动重试");
  assert.equal(model.classifyConfirmFailure(result.error), "conflict");
  assert.equal(model.errorDetail(result.error), CONFLICT_DETAIL);

  const refreshed = model.parseWorldFact(serverItem);
  const changes = model.changedFields(readItem, refreshed);
  assert.deepEqual(
    changes.map((change) => change.key),
    ["statement"],
  );
  assert.deepEqual(changes[0].after, { type: "text", text: "北境关口全年开放" });
  assert.equal(refreshed.updatedAt, "2026-10-05T09:30:00");
  assert.notEqual(
    model.buildConfirmPayload(refreshed).expected_updated_at,
    result.requests[0].body.expected_updated_at,
    "重新确认必须使用刷新后的令牌",
  );
});

// ============================================================
// 5. 手工录入：只能产生候选
// ============================================================

check("手工新增世界事实只提交候选状态", () => {
  const body = model.buildWorldFactCandidateBody({ statement: "北境关口只在冬季开放" });

  assert.deepEqual(body, {
    statement: "北境关口只在冬季开放",
    subject_ref: null,
    confirmation: "candidate",
    source_type: "user",
  });
  assert.ok(!JSON.stringify(body).includes("confirmed"));
});

check("手工新增情节线只提交候选状态并裁掉空白", () => {
  const body = model.buildPlotlineCandidateBody({
    title: "失踪的哨兵",
    description: "   ",
  });
  const withDescription = model.buildPlotlineCandidateBody({
    title: "失踪的哨兵",
    description: "  边境阴谋的开端  ",
  });

  assert.equal(body.description, null);
  assert.equal(withDescription.description, "边境阴谋的开端");
  assert.equal(body.confirmation, "candidate");
  assert.ok(!JSON.stringify(withDescription).includes("confirmed"));
});

check("手工新增世界事实的主体空白时提交 null", () => {
  const body = model.buildWorldFactCandidateBody({ statement: "x", subjectRef: "   " });

  assert.equal(body.subject_ref, null);
});

// ============================================================
// 6. 分页边界
// ============================================================

check("页码到偏移量按固定页长换算", () => {
  assert.equal(model.NARRATIVE_PAGE_SIZE, 20);
  assert.equal(model.pageOffset(1), 0);
  assert.equal(model.pageOffset(3), 40);
  assert.equal(model.pageOffset(0), 0);
  assert.equal(model.pageOffset(-5), 0);
});

check("总页数至少为 1 且向上取整", () => {
  assert.equal(model.pageCount(0), 1);
  assert.equal(model.pageCount(-3), 1);
  assert.equal(model.pageCount(1), 1);
  assert.equal(model.pageCount(20), 1);
  assert.equal(model.pageCount(21), 2);
  assert.equal(model.pageCount(Number.NaN), 1);
});

check("页码被夹在合法区间内", () => {
  assert.equal(model.clampPage(1, 100), 1);
  assert.equal(model.clampPage(5, 100), 5);
  assert.equal(model.clampPage(99, 100), 5);
  assert.equal(model.clampPage(0, 100), 1);
  assert.equal(model.clampPage(Number.NaN, 100), 1);
  assert.equal(model.clampPage(1, 0), 1);
});

check("分页大小上限由后端夹取，前端不请求越界页长", () => {
  assert.equal(model.MAX_PAGE_SIZE, 200);
  assert.ok(model.NARRATIVE_PAGE_SIZE <= model.MAX_PAGE_SIZE);
});

// ============================================================
// 7. 源码级接线检查
// ============================================================

check("模型模块保持零依赖，契约测试执行的就是生产实现", () => {
  assert.ok(
    !/^\s*import\s/m.test(modelSource),
    "narrative-state-model.ts 不得引入依赖，否则无法被本脚本转译执行",
  );
});

await checkAsync("确认接口路径与请求体来自被测构造函数", async () => {
  const apiSource = await readFile(apiPath, "utf8");

  assert.ok(apiSource.includes("/narrative/${ENDPOINT_SEGMENTS[kind]}/${item.id}/confirm"));
  assert.ok(apiSource.includes("buildConfirmPayload(item)"));
  assert.ok(apiSource.includes("params: { limit: NARRATIVE_PAGE_SIZE, offset }"));
  assert.ok(
    apiSource.includes("buildWorldFactCandidateBody") &&
      apiSource.includes("buildPlotlineCandidateBody"),
    "候选请求体必须来自被测构造函数",
  );
});

await checkAsync("组件用被测判定函数区分 409，而不是就地判断状态码", async () => {
  const rowSource = await readFile(rowPath, "utf8");

  assert.ok(rowSource.includes('classifyConfirmFailure(error) === "conflict"'));
  assert.ok(rowSource.includes("changedFields(conflict.previous, item)"));
  assert.ok(rowSource.includes("narrativeQueryKey(item.kind, projectId)"));
  assert.ok(rowSource.includes("canConfirm(item)"));
});

await checkAsync("确认前可展开查看完整字段：面板渲染类型化 details 与 JSON 原文", async () => {
  const rowSource = await readFile(rowPath, "utf8");
  const panelSource = await readFile(detailsPanelPath, "utf8");

  assert.ok(rowSource.includes("<NarrativeDetailsPanel"));
  assert.ok(rowSource.includes("showDetails ? ("));
  assert.ok(
    !panelSource.includes("canConfirm"),
    "完整字段面板不得以「能否确认」为展示条件：确认前就要能核对整行",
  );
  assert.ok(panelSource.includes("item.details.map("));
  assert.ok(panelSource.includes("detailValueLines(detail.key, detail.value, item.kind, t)"));
  assert.ok(panelSource.includes("serializeNarrativeRecord(item)"));
  assert.ok(panelSource.includes('<pre className="narrative-state__json">'));
  assert.ok(!/apiClient\.|\bpatch\b|\bdelete\b/i.test(panelSource), "完整字段面板必须是只读的");
});

await checkAsync("冲突取值按字段类型展开，字段标签走 defaultValue 兜底", async () => {
  const rowSource = await readFile(rowPath, "utf8");
  const labelsSource = await readFile(labelsPath, "utf8");

  assert.ok(rowSource.includes("changeValueText(change.key, change.before, item.kind, t)"));
  assert.ok(rowSource.includes("changeValueText(change.key, change.after, item.kind, t)"));
  assert.ok(rowSource.includes('t("narrativeState.details.show", { defaultValue:'));
  assert.ok(labelsSource.includes("defaultValue: FIELD_LABEL_FALLBACKS[key]"));
  assert.ok(
    labelsSource.includes("defaultValue: SCENE_RESULT_FALLBACKS[category]"),
    "场景结果类别文案同样需要兜底",
  );
});

await checkAsync("新增源码不使用 any", async () => {
  for (const sourcePath of [modelPath, rowPath, detailsPanelPath, labelsPath]) {
    const source = await readFile(sourcePath, "utf8");
    assert.ok(!/:\s*any\b/.test(source), `${sourcePath} 使用了 any 注解`);
    assert.ok(!/\bas any\b/.test(source), `${sourcePath} 使用了 as any`);
  }
});

await checkAsync("确认入口只在通过 canConfirm 时渲染，且没有直接改写路径", async () => {
  const rowSource = await readFile(rowPath, "utf8");
  const sectionSource = await readFile(sectionPath, "utf8");
  const pageSource = await readFile(storyMemoryPagePath, "utf8");

  assert.ok(rowSource.includes("{canConfirm(item) ? ("));
  assert.ok(sectionSource.includes("export function NarrativeStateSection"));
  assert.ok(
    pageSource.includes("<NarrativeStateSection projectId={projectId} />"),
    "故事记忆页必须挂载叙事状态区块",
  );
  assert.ok(
    !/apiClient\.(patch|put|delete)/.test(rowSource + sectionSource),
    "前端面板不得直接改写或删除叙事状态",
  );
});

await checkAsync("只有世界事实与情节线提供手工录入，其余资源声明只读", async () => {
  const sectionSource = await readFile(sectionPath, "utf8");
  const formSource = await readFile(candidateFormPath, "utf8");

  assert.ok(sectionSource.includes('kind === "worldFacts" || kind === "plotlines"'));
  assert.ok(sectionSource.includes("narrativeState.readOnlyNotice"));
  assert.ok(formSource.includes("createWorldFactCandidate"));
  assert.ok(formSource.includes("createPlotlineCandidate"));
});

// ============================================================
// 8. 文案：中英对齐、无 Emoji
// ============================================================

const locales = {};
for (const [language, localePath] of Object.entries(localePaths)) {
  locales[language] = JSON.parse(await readFile(localePath, "utf8"));
}

function flattenKeys(value, prefix = "") {
  return Object.entries(value).flatMap(([key, entry]) =>
    entry !== null && typeof entry === "object"
      ? flattenKeys(entry, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

check("中英文案 key 完全对齐", () => {
  const zhKeys = flattenKeys(locales["zh-CN"].narrativeState).sort();
  const enKeys = flattenKeys(locales.en.narrativeState).sort();

  assert.ok(zhKeys.length > 0, "缺少 narrativeState 文案");
  assert.deepEqual(zhKeys, enKeys);
});

check("四类资源、四种确认状态与三种资源状态的文案齐全", () => {
  for (const language of ["zh-CN", "en"]) {
    const namespace = locales[language].narrativeState;

    for (const kind of model.NARRATIVE_KINDS) {
      assert.ok(namespace.tabs[kind], `${language} 缺少 tabs.${kind}`);
      assert.ok(namespace.empty[kind], `${language} 缺少 empty.${kind}`);
    }
    for (const state of model.CONFIRMATION_STATES) {
      assert.ok(namespace.confirmation[state], `${language} 缺少 confirmation.${state}`);
    }
    for (const status of model.WORLD_FACT_STATUSES) {
      assert.ok(namespace.worldFactStatus[status], `${language} 缺少 worldFactStatus.${status}`);
    }
    for (const state of model.BELIEF_STATES) {
      assert.ok(namespace.beliefState[state], `${language} 缺少 beliefState.${state}`);
    }
    for (const state of model.PLOTLINE_STATES) {
      assert.ok(namespace.plotlineState[state], `${language} 缺少 plotlineState.${state}`);
    }
    for (const sourceType of model.SOURCE_TYPES) {
      assert.ok(namespace.sourceTypes[sourceType], `${language} 缺少 sourceTypes.${sourceType}`);
    }
  }
});

check("用户可见文案确实进入 i18n，而不是硬编码在组件里", () => {
  const zh = locales["zh-CN"].narrativeState;
  const en = locales.en.narrativeState;

  for (const key of ["title", "confirm", "conflictTitle", "conflictBody", "readOnlyNotice"]) {
    assert.notEqual(zh[key], en[key], `${key} 没有被翻译`);
  }
});

/** Emoji 与装饰性符号区段（AGENTS.md 第 2 条禁止在用户可见文案中使用）。 */
const FORBIDDEN_RANGES = [
  [0x1f000, 0x1faff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0xfe0f, 0xfe0f],
];

function findForbiddenCodePoints(text) {
  const found = new Set();
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (FORBIDDEN_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) {
      found.add(`U+${codePoint.toString(16).toUpperCase()}`);
    }
  }
  return [...found];
}

check("新增文案不含 Emoji", () => {
  for (const [language, locale] of Object.entries(locales)) {
    assert.deepEqual(
      findForbiddenCodePoints(JSON.stringify(locale.narrativeState)),
      [],
      `${language} 的 narrativeState 文案含 Emoji`,
    );
  }
});

await checkAsync("新增源码不含 Emoji", async () => {
  for (const sourcePath of [
    modelPath,
    apiPath,
    rowPath,
    sectionPath,
    candidateFormPath,
    detailsPanelPath,
    labelsPath,
  ]) {
    const source = await readFile(sourcePath, "utf8");
    assert.deepEqual(findForbiddenCodePoints(source), [], `${sourcePath} 含 Emoji`);
  }
});

// ============================================================
// 结果
// ============================================================

console.log(
  `narrative-state contract suite: ${checks - failures}/${checks} checks passed ` +
    `(actual-source model + ${model.NARRATIVE_KINDS.length} resources)`,
);
if (failures > 0) {
  console.error(`narrative-state contract suite: ${failures} check(s) failed`);
  process.exitCode = 1;
}
