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
console.log("Tool message acceptance: 40 checks passed");
