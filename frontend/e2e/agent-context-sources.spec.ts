import { expect, test, type Page } from "@playwright/test";

import {
  LARGE_PROJECT_ID,
  LARGE_PROJECT_URL,
  apiRequest,
  approveUntilReply,
  getLatestTask,
  openProject,
  sendMessage,
  startNewTask,
} from "./helpers";

interface ContextSourcePayload {
  id?: unknown;
  category?: unknown;
  title?: unknown;
  sourceTypes?: unknown;
}

interface TaskMessagePayload {
  message_type?: unknown;
  payload?: {
    kind?: unknown;
    context_sources?: unknown;
  };
}

interface TaskWithMessages {
  id: string;
  messages?: TaskMessagePayload[];
}

const CONTEXT_TAB = "上下文";
const PANEL = ".agent-context-panel";
const SWITCHER_BUTTON = ".ai-sidebar-content-switcher__button";

const GUARD_TASK_ID = "e2e-context-source-guard-task";
const GUARD_TASK_TITLE = "上下文来源校验任务";
const GUARD_SESSION_ID = "e2e-context-source-guard-session";
const TIMESTAMP = "2026-10-03T08:00:00Z";

/** 有效来源：分类为自身键，来源类型合法，应正常渲染。 */
const VALID_CONTEXT_SOURCES = [
  {
    id: "chapter:guard-chapter-1",
    category: "chapter",
    title: "第一卷 第一章",
    sourceTypes: ["chapterBody"],
    chapterOrder: 1,
  },
  {
    id: "character:guard-hero",
    category: "character",
    title: "主角",
    sourceTypes: ["characterProfile"],
  },
];

/** 非法来源：继承自 Object.prototype 的分类名、未知分类，以及无合法来源类型的条目。 */
const MALFORMED_CONTEXT_SOURCES = [
  {
    id: "toString:guard",
    category: "toString",
    title: "继承的 toString",
    sourceTypes: ["chapterBody"],
  },
  {
    id: "constructor:guard",
    category: "constructor",
    title: "继承的 constructor",
    sourceTypes: ["chapterBody"],
  },
  {
    id: "__proto__:guard",
    category: "__proto__",
    title: "继承的 proto",
    sourceTypes: ["chapterBody"],
  },
  {
    id: "valueOf:guard",
    category: "valueOf",
    title: "继承的 valueOf",
    sourceTypes: ["chapterBody"],
  },
  {
    id: "hasOwnProperty:guard",
    category: "hasOwnProperty",
    title: "继承的 hasOwnProperty",
    sourceTypes: ["chapterBody"],
  },
  {
    id: "toLocaleString:guard",
    category: "toLocaleString",
    title: "继承的 toLocaleString",
    sourceTypes: ["chapterBody"],
  },
  {
    id: "unknownCategory:guard",
    category: "unknownCategory",
    title: "未知分类",
    sourceTypes: ["chapterBody"],
  },
  {
    id: "chapter:guard-bad-source-type",
    category: "chapter",
    title: "来源类型无效",
    sourceTypes: ["bogusSourceType"],
  },
  {
    id: "chapter:guard-inherited-source-type",
    category: "chapter",
    title: "继承的来源类型",
    sourceTypes: ["toString", "constructor"],
  },
];

/** 合法来源之间夹入非法来源，任何一条抛错都会中断后续渲染。 */
const GUARD_CONTEXT_SOURCES = [
  VALID_CONTEXT_SOURCES[0],
  ...MALFORMED_CONTEXT_SOURCES,
  VALID_CONTEXT_SOURCES[1],
];

/** 用固定任务替代项目任务列表与任务详情，使畸形 context_snapshot 进入侧边栏。 */
async function mockGuardedContextTask(page: Page): Promise<void> {
  const taskListItem = {
    id: GUARD_TASK_ID,
    project_id: LARGE_PROJECT_ID,
    title: GUARD_TASK_TITLE,
    token_input: 0,
    token_output: 0,
    token_cache: 0,
    context_input_tokens: 0,
    cost: 0,
    is_running: false,
    is_favorited: false,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };

  const taskDetail = {
    ...taskListItem,
    agent_session_id: GUARD_SESSION_ID,
    messages: [
      {
        id: "guard-context-snapshot",
        role: "system",
        content: "",
        message_type: "context_snapshot",
        message_status: "completed",
        display_channel: "hidden",
        payload: { kind: "context_snapshot", context_sources: GUARD_CONTEXT_SOURCES },
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      },
      {
        id: "guard-assistant-text",
        role: "assistant",
        content: "上下文来源已就绪。",
        message_type: "text",
        message_status: "completed",
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      },
    ],
  };

  await page.route(
    new RegExp(`/api/v1/projects/${LARGE_PROJECT_ID}/tasks(\\?|$)`),
    async (route) => {
      await route.fulfill({ json: { items: [taskListItem], total: 1 } });
    },
  );
  await page.route(new RegExp(`/api/v1/tasks/${GUARD_TASK_ID}(\\?|$)`), async (route) => {
    await route.fulfill({ json: taskDetail });
  });
}

function isContextSourceSanitizerError(message: string): boolean {
  return /agent-context-sources|SOURCE_TYPES_BY_CATEGORY|\.has is not a function/i.test(message);
}

function lastContextSources(messages: TaskMessagePayload[]): ContextSourcePayload[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.message_type !== "context_snapshot") continue;
    const rawSources = message.payload?.context_sources;
    return Array.isArray(rawSources) ? (rawSources as ContextSourcePayload[]) : [];
  }
  return [];
}

async function openContextPanel(page: Page): Promise<void> {
  await page.locator(SWITCHER_BUTTON, { hasText: CONTEXT_TAB }).click();
  await expect(page.locator(PANEL)).toBeVisible();
}

test.describe("Agent 上下文来源面板", () => {
  test("面板与最终模型输入的来源元数据保持一致", async ({ page }) => {
    await openProject(page, LARGE_PROJECT_URL);
    await startNewTask(page);

    await sendMessage(page, "请读取第一卷第一章的正文，读完后回复「读取完成」。不要修改任何章节。");
    await approveUntilReply(page, "读取完成", 600000);

    const task = await getLatestTask(page, LARGE_PROJECT_ID);
    const { status, data } = await apiRequest<TaskWithMessages>(
      page,
      "GET",
      `/api/v1/tasks/${task.id}`,
    );
    expect(status).toBe(200);

    const sources = lastContextSources(data?.messages ?? []);
    expect(sources.length).toBeGreaterThan(0);

    await openContextPanel(page);

    const panel = page.locator(PANEL);
    const categories = Array.from(
      new Set(
        sources
          .map((source) => source.category)
          .filter((category): category is string => typeof category === "string"),
      ),
    );
    expect(categories.length).toBeGreaterThan(0);
    for (const category of categories) {
      await expect(page.locator(`#agent-context-${category}`)).toBeVisible();
    }

    await expect(panel.locator(".agent-context-item")).toHaveCount(sources.length);
    await expect(panel).not.toContainText("assistant.contextSources.");
  });

  test("消息中的来源引用计入上下文来源", async ({ page }) => {
    await openProject(page, LARGE_PROJECT_URL);
    await startNewTask(page);

    await sendMessage(
      page,
      "请参考 @chapter:第一卷 的写作节奏，回复「来源已确认」，不要执行任何工具。",
    );
    await approveUntilReply(page, "来源已确认", 300000);

    await openContextPanel(page);

    const panel = page.locator(PANEL);
    await expect(page.locator("#agent-context-chapter")).toBeVisible();
    await expect(
      panel.locator(".agent-context-item__title", { hasText: "第一卷" }).first(),
    ).toBeVisible();
    await expect(
      panel.locator(".agent-context-source-tag", { hasText: "消息引用" }).first(),
    ).toBeVisible();
    await expect(panel).not.toContainText("assistant.contextSources.");
  });

  test("忽略继承与未知的分类名，仍渲染有效来源", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await mockGuardedContextTask(page);
    await openProject(page, LARGE_PROJECT_URL);
    await startNewTask(page);

    const guardedTask = page.locator(".task-list-item", { hasText: GUARD_TASK_TITLE });
    await expect(guardedTask).toBeVisible({ timeout: 30000 });
    await guardedTask.click();

    await openContextPanel(page);

    const panel = page.locator(PANEL);
    await expect(page.locator("#agent-context-chapter")).toBeVisible();
    await expect(page.locator("#agent-context-character")).toBeVisible();
    await expect(
      panel.locator(".agent-context-item__title", { hasText: "第 1 章" }).first(),
    ).toBeVisible();
    await expect(
      panel.locator(".agent-context-item__title", { hasText: "主角" }).first(),
    ).toBeVisible();
    await expect(panel.locator(".agent-context-item")).toHaveCount(VALID_CONTEXT_SOURCES.length);

    for (const source of MALFORMED_CONTEXT_SOURCES) {
      await expect(panel).not.toContainText(source.title);
    }
    await expect(panel).not.toContainText("assistant.contextSources.");
    expect(pageErrors.filter(isContextSourceSanitizerError)).toEqual([]);
  });
});
