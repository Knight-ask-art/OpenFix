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
assert.equal(plan.canReportEmptyPlan({ status: "completed", toolResult: {}, payload: { is_interrupt_preview: true } }), false);
assert.equal(plan.canReportEmptyPlan({ status: "completed", payload: { is_interrupt_preview: false } }), true);
console.log("Tool message acceptance: 11 checks passed");
