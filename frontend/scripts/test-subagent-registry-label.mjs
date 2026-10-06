import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// isActive is availability, including reusable completed/cancelled children.
for (const [locale, label, count] of [
  ["zh-CN", "子智能体", "{{count}} 个子智能体"],
  ["en", "Subagents", "{{count}} subagents"],
]) {
  const strings = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8")).writing.aiSidebar;
  assert.equal(strings.activeSubagents, label);
  assert.equal(strings.activeSubagentsCount, count);
  for (const status of ["Queued", "Running", "WaitingUser", "Completed", "Error", "Cancelled"]) {
    assert.ok(strings[`subagentStatus${status}`]);
  }
}
console.log("Subagent registry labels: 16 checks passed");
