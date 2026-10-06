import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import ts from "typescript";

async function load(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const base = "../src/features/assistant/components/agent/message-blocks/tools/";
const catalog = await load(`${base}shared/tool-message-catalog.ts`);
assert(catalog.REGISTERED_TOOL_NAMES.includes("search_story_memory"));
assert.equal(catalog.TOOL_DESCRIPTOR_META.search_story_memory.group, "context");
assert.equal(catalog.TOOL_DESCRIPTOR_META.search_story_memory.isExplore, true);
assert.equal(new Set(catalog.REGISTERED_TOOL_NAMES).size, catalog.REGISTERED_TOOL_NAMES.length);

// 只读的叙事状态工具必须注册成探索类：只显示标题与范围，不展开正文。
assert(catalog.REGISTERED_TOOL_NAMES.includes("read_narrative_state"));
assert.equal(catalog.TOOL_DESCRIPTOR_META.read_narrative_state.group, "context");
assert.equal(catalog.TOOL_DESCRIPTOR_META.read_narrative_state.isExplore, true);
assert.equal(catalog.TOOL_DESCRIPTOR_META.read_narrative_state.contentMode, "hidden");
// 标签不能是 "list"：否则会被探索摘要计入列表数，而不是上下文读取数。
assert.notEqual(catalog.TOOL_DESCRIPTOR_META.read_narrative_state.tag, "list");

// 每个已注册的工具都必须有元数据，注册表与元数据表不得漂移。
const byName = (left, right) => left.localeCompare(right);
assert.deepEqual(
  [...catalog.REGISTERED_TOOL_NAMES].sort(byName),
  Object.keys(catalog.TOOL_DESCRIPTOR_META).sort(byName),
);

// registry 依赖 React 与 i18n，只能做源码级接线检查：确认描述符挂上了本地化标题、
// 只读取章节范围，并且叙事状态正文 state_text 不进入任何渲染路径。
const registrySource = await readFile(
  new URL(`${base}shared/tool-message-registry.tsx`, import.meta.url),
  "utf8",
);
assert(registrySource.includes("read_narrative_state: {"));
assert(registrySource.includes('i18n.t("assistant.tools.readNarrativeState")'));
assert(registrySource.includes('i18n.t("assistant.tools.noNarrativeState")'));
assert(registrySource.includes("asString(data.chapter_scope)"));
// 叙事状态正文只能留在消息里，注册表不得读取或渲染它（注释里提到字段名不算读取）。
assert(!/\.\s*state_text|\[\s*["']state_text/.test(registrySource));
assert(!catalog.REGISTERED_TOOL_NAMES.some((toolName) => toolName.includes("state_text")));

// 运行状态映射：read_narrative_state 必须落到专属阶段，否则会退回 considering，
// 用户会看到「正在考虑下一步」，而不是「正在叙事状态读取」。
const runningStatusSource = await load(
  "../src/features/assistant/components/agent/agent-running-status.ts",
);
const narrativeRunningStatus = runningStatusSource.getAgentRunningStatus([
  { type: "tool", toolName: "read_narrative_state", status: "running" },
]);
assert.equal(narrativeRunningStatus, "narrativeRead");
assert.notEqual(narrativeRunningStatus, runningStatusSource.AGENT_RUNNING_STATUS.considering);

// 设置面板按 TOOL_DISPLAY_KEYS 过滤：缺条目时该工具在权限列表里完全不可见。
const settingsSource = await readFile(
  new URL("../src/features/settings/components/agent-tools-settings.tsx", import.meta.url),
  "utf8",
);
const displayKeysBlock = settingsSource.slice(
  settingsSource.indexOf("const TOOL_DISPLAY_KEYS"),
  settingsSource.indexOf("export function AgentToolsSettings"),
);
const displayKeys = [...displayKeysBlock.matchAll(/^ {2}([a-z][a-z0-9_]*): \{$/gm)].map(
  (match) => match[1],
);
assert.ok(settingsSource.includes("read_narrative_state: {"));
assert.ok(displayKeys.includes("read_narrative_state"));
assert.ok(settingsSource.includes("settings.agentTool.readNarrativeState.name"));
assert.ok(settingsSource.includes("settings.agentTool.readNarrativeState.description"));

const plan = await load(`${base}plan/plan-tool-message.utils.ts`);
assert.equal(plan.canReportEmptyPlan({}), false);
assert.equal(plan.canReportEmptyPlan({ status: "running" }), false);
assert.equal(plan.canReportEmptyPlan({ status: "completed" }), true);
assert.equal(plan.canReportEmptyPlan({ status: "error" }), true);
assert.equal(plan.canReportEmptyPlan({ toolResult: { data: {} } }), true);
assert.equal(
  plan.canReportEmptyPlan({
    status: "completed",
    toolResult: {},
    payload: { is_interrupt_preview: true },
  }),
  false,
);
assert.equal(
  plan.canReportEmptyPlan({ status: "completed", payload: { is_interrupt_preview: false } }),
  true,
);

// A write_plan call that is still waiting for approval is not an executed result: the
// transcript keeps it as a pending message instead of finalizing it as completed.
const pendingApproval = {
  status: "pending",
  isStreaming: false,
  payload: { pending_approval: true, tool_args: { todos: [] } },
};
assert.equal(plan.canReportEmptyPlan(pendingApproval), false);
assert.equal(plan.isPendingPlanToolMessage(pendingApproval), true);
assert.equal(plan.canReportEmptyPlan({ status: "pending", payload: {} }), false);
assert.equal(plan.canReportEmptyPlan({ status: "completed", isStreaming: true }), false);

// Approval placeholders reported by the runtime must never be read as "no plan returned",
// both live and after a history reload.
assert.equal(
  plan.canReportEmptyPlan({
    status: "completed",
    toolResult: {
      type: "ok",
      success: true,
      reason: "approval_preview",
      message: "需要审批",
    },
  }),
  false,
);
assert.equal(
  plan.canReportEmptyPlan({
    status: "completed",
    toolResult: { type: "preview", success: true, reason: "permission_required" },
  }),
  false,
);
assert.equal(
  plan.canReportEmptyPlan({
    status: "completed",
    toolResult: { data: { is_preview: true, reason: "approval_preview" } },
  }),
  false,
);

// While approval is pending the tool args only exist as streamed JSON text, because the
// prepare phase never emits a tool_call event with structured input.
const streamedArgsText = JSON.stringify({
  todos: [
    { content: "读取第二章", status: "completed", priority: "high" },
    { content: "写入第三章", status: "in_progress", priority: "medium" },
  ],
});
const pendingStreamedPlan = {
  status: "pending",
  toolArgsText: streamedArgsText,
  payload: { tool_args_text: streamedArgsText, pending_approval: true },
};
assert.deepEqual(
  plan.getPlanTodos(pendingStreamedPlan).map((todo) => [todo.content, todo.status, todo.priority]),
  [
    ["读取第二章", "completed", "high"],
    ["写入第三章", "in_progress", "medium"],
  ],
);
assert.equal(plan.canReportEmptyPlan(pendingStreamedPlan), false);

// Structured args win over streamed text, and a plan object without todos must not hide
// todos that are available elsewhere.
assert.deepEqual(
  plan
    .getPlanTodos({
      toolArgs: { todos: [{ content: "结构化计划", status: "pending", priority: "low" }] },
    })
    .map((todo) => todo.content),
  ["结构化计划"],
);
assert.deepEqual(
  plan
    .getPlanTodos({
      toolResult: {
        data: { plan: { id: "plan-1" }, todos: [{ content: "结果里待办", priority: "high" }] },
      },
    })
    .map((todo) => todo.content),
  ["结果里待办"],
);
assert.equal(plan.getPlanTodos({ toolArgsText: "{not json" }).length, 0);
// A raw stream may omit priority; the todo still has to render instead of blanking the plan.
assert.deepEqual(plan.getPlanTodos({ toolArgs: { todos: [{ content: "缺少优先级" }] } }), [
  { content: "缺少优先级", status: "pending", priority: "medium" },
]);

// Denied or failed writes stay visible as errors and keep their proposed todos.
const deniedPlan = {
  status: "error",
  toolArgs: { todos: [{ content: "被拒绝的计划", status: "pending", priority: "high" }] },
  toolResult: {
    type: "fail",
    success: false,
    status: "approval_denied",
    reason: "tool_error",
    message: "工具调用已被用户拒绝",
  },
};
assert.equal(plan.canReportEmptyPlan(deniedPlan), true);
assert.deepEqual(
  plan.getPlanTodos(deniedPlan).map((todo) => todo.content),
  ["被拒绝的计划"],
);
// A completed result without any plan data still reports the empty-plan warning.
assert.equal(
  plan.canReportEmptyPlan({
    status: "completed",
    toolResult: { type: "ok", success: true, data: "已写入" },
  }),
  true,
);

const approvalToolArgs = {
  todos: [{ content: "审批里的待办", status: "pending", priority: "high" }],
};
const makeApprovalMessage = (toolArgs) => ({
  type: "approval",
  toolApproval: {
    approval_id: "approval-1",
    tool_name: "write_plan",
    tool_args: toolArgs,
    tool_call_id: "call_plan_1",
    message: "是否允许调用 write_plan？",
    interrupt_behavior: "block",
  },
});
const makeStreamedPlanMessage = (overrides) => ({
  id: "call_plan_1",
  type: "tool",
  role: "tool",
  toolName: "write_plan",
  status: "running",
  isStreaming: true,
  payload: { tool_call_id: "call_plan_1", tool_name: "write_plan" },
  ...overrides,
});

// End to end for the approval-pending chain: the pending write_plan message only has
// streamed args text. It must show the proposed todos, never the empty-result warning.
assert.equal(plan.isPlanToolMessage(makeStreamedPlanMessage({})), true);
assert.equal(plan.isPlanToolMessage({ toolName: "write_chapter" }), false);
const pendingMessage = plan.toPendingPlanApprovalMessage(
  makeStreamedPlanMessage({ toolArgsText: streamedArgsText }),
  makeApprovalMessage(approvalToolArgs),
);
assert.equal(pendingMessage.status, "pending");
assert.equal(pendingMessage.isStreaming, false);
assert.equal(pendingMessage.toolResult, undefined);
assert.equal(pendingMessage.payload.pending_approval, true);
assert.equal(pendingMessage.payload.approval_id, "approval-1");
assert.deepEqual(
  plan.getPlanTodos(pendingMessage).map((todo) => todo.content),
  ["读取第二章", "写入第三章"],
);
assert.equal(plan.canReportEmptyPlan(pendingMessage), false);

// The same pending call without streamed args recovers the proposed todos from the
// interrupt payload, and stays free of the empty-result warning when neither has them.
const pendingWithoutArgs = plan.toPendingPlanApprovalMessage(
  makeStreamedPlanMessage({ id: "call_plan_2" }),
  makeApprovalMessage(approvalToolArgs),
);
assert.deepEqual(
  plan.getPlanTodos(pendingWithoutArgs).map((todo) => todo.content),
  ["审批里的待办"],
);
assert.equal(plan.canReportEmptyPlan(pendingWithoutArgs), false);
assert.equal(
  plan.canReportEmptyPlan(
    plan.toPendingPlanApprovalMessage(
      makeStreamedPlanMessage({ id: "call_plan_3" }),
      makeApprovalMessage({}),
    ),
  ),
  false,
);

// Reloaded child-run placeholders keep their proposed todos and stay warning free.
assert.deepEqual(
  plan
    .getPlanTodos({
      status: "completed",
      toolName: "write_plan",
      toolArgs: { todos: [{ content: "重载后的待办", status: "pending", priority: "high" }] },
      toolResult: {
        type: "ok",
        success: true,
        reason: "approval_preview",
        message: "需要审批",
      },
    })
    .map((todo) => todo.content),
  ["重载后的待办"],
);
// 新增的用户可见文案必须同时落在中英文里，并且不得使用 Emoji（AGENTS.md 第 2 条）。
const locales = {};
for (const [language, file] of Object.entries({
  "zh-CN": "../src/i18n/locales/zh-CN.json",
  en: "../src/i18n/locales/en.json",
})) {
  locales[language] = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
}
const DECORATIVE_RANGES = [
  [0x1f000, 0x1faff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0xfe0f, 0xfe0f],
];
function hasDecorativeCodePoint(text) {
  return [...text].some((character) => {
    const codePoint = character.codePointAt(0);
    return DECORATIVE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
  });
}

// 断言收集到数组再一次性比较：这样不论语言数量多少，断言执行次数都与源码里的写法一致。
const localeProblems = [];
for (const [language, locale] of Object.entries(locales)) {
  const labels = {
    "assistant.tools.readNarrativeState": locale.assistant.tools.readNarrativeState,
    "assistant.tools.noNarrativeState": locale.assistant.tools.noNarrativeState,
    // knowledge_boundary 是新增的一致性问题类型；缺文案就会退化成裸 type 字符串。
    "consistency.types.knowledge_boundary": locale.consistency.types.knowledge_boundary,
  };
  for (const [key, label] of Object.entries(labels)) {
    if (typeof label !== "string" || label.trim().length === 0) {
      localeProblems.push(`${language} 缺少文案 ${key}`);
    } else if (hasDecorativeCodePoint(label)) {
      localeProblems.push(`${language} 的 ${key} 含 Emoji 或装饰符号：${label}`);
    }
  }
}
assert.deepEqual(localeProblems, []);
assert.notEqual(
  locales["zh-CN"].assistant.tools.readNarrativeState,
  locales.en.assistant.tools.readNarrativeState,
);
assert.notEqual(
  locales["zh-CN"].consistency.types.knowledge_boundary,
  locales.en.consistency.types.knowledge_boundary,
);
assert.deepEqual(
  Object.keys(locales["zh-CN"].consistency.types).sort(byName),
  Object.keys(locales.en.consistency.types).sort(byName),
);
// 叙事状态详情面板与设置/运行状态接线依赖的文案：缺一条就会退回中文 defaultValue、
// 或在英文界面里露出裸 key。数量固定为报告里列出的 48 条详情文案。
const requiredLocaleKeys = [
  "assistant.runningStatus.narrativeRead",
  "settings.agentTool.readNarrativeState.name",
  "settings.agentTool.readNarrativeState.description",
  "narrativeState.details.show",
  "narrativeState.details.hide",
  "narrativeState.details.rawJson",
];
for (const fieldKey of [
  "status",
  "supersededById",
  "invalidatedAt",
  "introducedChapter",
  "advancedChapter",
  "relatedOutlines",
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
  requiredLocaleKeys.push(`narrativeState.field.${fieldKey}`);
}
for (const [group, values] of Object.entries({
  worldFactStatusValue: ["confirmed", "uncertain", "contradicted", "retired"],
  beliefStateValue: ["known", "believed", "suspected", "unknown", "mistaken"],
  plotlineStateValue: ["open", "progressing", "resolved", "abandoned", "uncertain"],
  sceneResult: [
    "factChanges",
    "beliefChanges",
    "relationshipChanges",
    "stateChanges",
    "plotlineChanges",
  ],
})) {
  for (const value of values) requiredLocaleKeys.push(`narrativeState.${group}.${value}`);
}

const narrativeLocaleProblems = [];
let narrativeLocaleKeyCount = 0;
for (const [language, locale] of Object.entries(locales)) {
  for (const key of requiredLocaleKeys) {
    if (key.startsWith("narrativeState.")) narrativeLocaleKeyCount += 1;
    const label = key
      .split(".")
      .reduce((node, part) => (node == null ? undefined : node[part]), locale);
    if (typeof label !== "string" || label.trim().length === 0) {
      narrativeLocaleProblems.push(`${language} 缺少文案 ${key}`);
    } else if (hasDecorativeCodePoint(label)) {
      narrativeLocaleProblems.push(`${language} 的 ${key} 含 Emoji 或装饰符号`);
    }
  }
}
// 语言数量会翻倍计数，按语言数还原成单语言的 key 数量再做断言。
assert.equal(narrativeLocaleKeyCount / Object.keys(locales).length, 48);
assert.deepEqual(narrativeLocaleProblems, []);
console.log("Tool message acceptance: 64 checks passed");
