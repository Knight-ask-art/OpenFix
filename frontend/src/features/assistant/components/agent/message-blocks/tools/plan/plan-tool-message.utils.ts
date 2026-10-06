import type { AgentMessage } from "@/lib/agent.types";

import type {
  PlanPriority,
  PlanStatus,
  PlanTodoPayload,
  ToolMessageContentMode,
} from "../shared/tool-message-utils";

type PlanMessageSource = Pick<
  AgentMessage,
  | "status"
  | "isStreaming"
  | "toolResult"
  | "toolArgs"
  | "toolArgsText"
  | "partialToolArgs"
  | "payload"
>;

const PLACEHOLDER_PLAN_RESULT_REASONS = new Set([
  "approval_preview",
  "permission_required",
  "ask_user_pending",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asPlanStatus(value: unknown): PlanStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed"
    ? value
    : undefined;
}

function asPlanPriority(value: unknown): PlanPriority | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function parseToolArgsText(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getToolResultRecords(message: PlanMessageSource): Record<string, unknown>[] {
  const toolResult = message.toolResult;
  if (!isRecord(toolResult)) return [];
  const data = toolResult.data;
  return isRecord(data) && data !== toolResult ? [data, toolResult] : [toolResult];
}

const PLAN_TOOL_NAME = "write_plan";

export function isPlanToolMessage(message: Pick<AgentMessage, "toolName">): boolean {
  return message.toolName === PLAN_TOOL_NAME;
}

function getToolArgsCandidates(message: PlanMessageSource): unknown[] {
  const payload = isRecord(message.payload) ? message.payload : {};
  return [message.toolArgs, message.partialToolArgs, payload.tool_args, payload.partial_tool_args];
}

function getToolArgsTextCandidates(message: PlanMessageSource): unknown[] {
  const payload = isRecord(message.payload) ? message.payload : {};
  return [message.toolArgsText, payload.tool_args_text, payload.partial_tool_args_text];
}

/**
 * Resolve the call arguments of a plan tool message. While an approval is pending the call
 * was streamed as text only, so the structured arguments have to be recovered from it.
 */
export function getPlanToolArgs(message: PlanMessageSource): Record<string, unknown> | undefined {
  for (const candidate of getToolArgsCandidates(message)) {
    if (isRecord(candidate)) return candidate;
  }
  for (const candidate of getToolArgsTextCandidates(message)) {
    const parsed = parseToolArgsText(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function getApprovalToolArgs(
  approvalMessage: Pick<AgentMessage, "toolApproval">,
): Record<string, unknown> | undefined {
  const toolArgs = approvalMessage.toolApproval?.tool_args;
  return isRecord(toolArgs) ? toolArgs : undefined;
}

/**
 * A plan tool call that waits for approval has not executed: keep the proposed todos
 * visible and stop reporting it as a completed result.
 */
export function toPendingPlanApprovalMessage(
  message: AgentMessage,
  approvalMessage: Pick<AgentMessage, "toolApproval">,
): AgentMessage {
  const toolArgs = getPlanToolArgs(message) ?? getApprovalToolArgs(approvalMessage);
  return {
    ...message,
    status: "pending",
    isStreaming: false,
    toolArgs,
    toolResult: undefined,
    toolSuccess: undefined,
    payload: {
      ...(message.payload ?? {}),
      pending_approval: true,
      approval_id: approvalMessage.toolApproval?.approval_id,
      ...(toolArgs ? { tool_args: toolArgs } : {}),
    },
  };
}

function isPlaceholderPlanResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.is_preview === true || value.is_interrupt_preview === true) return true;
  if (value.type === "preview") return true;
  const reason = asString(value.reason);
  return Boolean(reason && PLACEHOLDER_PLAN_RESULT_REASONS.has(reason));
}

export function isPendingPlanToolMessage(message: PlanMessageSource): boolean {
  // A streamed call, an approval preview, or a call waiting for approval is a proposal,
  // not an executed result.
  if (message.payload?.pending_approval === true) return true;
  if (message.payload?.is_interrupt_preview === true) return true;
  if (message.isStreaming === true) return true;
  return message.status === "pending" || message.status === "running";
}

export function canReportEmptyPlan(message: PlanMessageSource): boolean {
  if (isPendingPlanToolMessage(message)) return false;
  // Approval placeholders report "需要审批" instead of a plan; never surface them as an
  // executed result without plan data, including after a history reload.
  if (isPlaceholderPlanResult(message.toolResult)) return false;
  if (isPlaceholderPlanResult(message.toolResult?.data)) return false;
  return (
    Boolean(message.toolResult) || message.status === "completed" || message.status === "error"
  );
}

function toPlanTodoPayload(value: unknown): PlanTodoPayload | null {
  if (!isRecord(value)) return null;
  const content = asString(value.content);
  if (!content) return null;
  return {
    content,
    status: asPlanStatus(value.status) ?? "pending",
    priority: asPlanPriority(value.priority) ?? "medium",
  };
}

function getPlanTodoSourceRecords(message: PlanMessageSource): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];

  for (const record of getToolResultRecords(message)) {
    if (isRecord(record.plan)) sources.push(record.plan);
    sources.push(record);
  }

  for (const candidate of getToolArgsCandidates(message)) {
    if (isRecord(candidate)) sources.push(candidate);
  }

  for (const candidate of getToolArgsTextCandidates(message)) {
    const parsed = parseToolArgsText(candidate);
    if (parsed) sources.push(parsed);
  }

  if (isRecord(message.payload)) sources.push(message.payload);

  return sources;
}

export function getPlanTodos(message: PlanMessageSource): PlanTodoPayload[] {
  for (const source of getPlanTodoSourceRecords(message)) {
    const todos = Array.isArray(source.todos)
      ? source.todos
          .filter(isRecord)
          .map(toPlanTodoPayload)
          .filter((todo): todo is PlanTodoPayload => Boolean(todo))
      : [];
    if (todos.length > 0) return todos;
  }
  return [];
}

export interface PlanToolDisplayConfig {
  contentMode: ToolMessageContentMode;
  defaultExpanded: boolean;
}

const PLAN_TOOL_DISPLAY_CONFIG: PlanToolDisplayConfig = {
  contentMode: "expandable",
  defaultExpanded: true,
};

const PLAN_TODO_MARKERS: Record<PlanStatus, string> = {
  pending: "[ ]",
  in_progress: "[*]",
  completed: "[✓]",
};

export function getPlanToolDisplayConfig(): PlanToolDisplayConfig {
  return PLAN_TOOL_DISPLAY_CONFIG;
}

export function getPlanTodoMarker(status: PlanStatus): string {
  return PLAN_TODO_MARKERS[status];
}
