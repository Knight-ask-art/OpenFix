/**
 * AI 模型错误分类的浏览器测试夹具（合成接口，不访问真实后端或模型）。
 *
 * 只提供各消费方真实需要的窄路由 mock：未登记的路由会被记录并返回 501，
 * 测试结束时断言“没有未预期请求”，避免 blanket success handler。
 * 每个 AI 端点使用显式队列，由用例决定“不可用 / 普通失败 / 成功”的顺序。
 */
import { expect, type Page, type Route } from "@playwright/test";

export type Language = "en" | "zh-CN";

export const PROJECT_ID = "ai-error-project";
export const PROJECT_TITLE = "Synthetic AI Error Novel";
export const VOLUME_ID = "ai-error-volume";
export const CHAPTER_ID = "ai-error-chapter";
export const ROOT_OUTLINE_ID = "ai-error-outline-root";
export const TIMESTAMP = "2026-10-03T08:00:00Z";

export const UNAVAILABLE_CODE = "background_model_unavailable";
/** 后端返回的安全 message：绝不能出现在用户界面里。 */
export const UNAVAILABLE_MESSAGE = "synthetic-backend-light-model-text";
/** 普通失败的字符串 detail：包含“模型”也绝不能触发不可用分类。 */
export const ORDINARY_DETAIL = "Synthetic ordinary failure 模型 400";

/** inline-ai 成功分支返回的合成候选项（result 字段，单一导出常量）。 */
export const INLINE_RESULT_TEXT = "Synthetic polished version of the selected text.";
/** inline-ai 成功分支返回的合成模型标识（model 字段）。 */
export const INLINE_MODEL = "synthetic-inline-model";

export const CHAPTER_CONTENT = "Synthetic selection body for inline AI.";

export type AiEndpoint =
  | "story-setup"
  | "inline-ai"
  | "outline-improve"
  | "consistency-check"
  | "consistency-analyze";

export const AI_ENDPOINTS: AiEndpoint[] = [
  "story-setup",
  "inline-ai",
  "outline-improve",
  "consistency-check",
  "consistency-analyze",
];

export type StubResponse =
  | { kind: "unavailable" }
  | { kind: "detail"; status: number; detail: string }
  /** success 默认返回单一导出的短候选项；inlineResult 仅供长候选项滚动回归覆盖 result 字段。 */
  | { kind: "success"; inlineResult?: string };

export interface RecordedRequest {
  endpoint: AiEndpoint;
  body: unknown;
}

export interface AiErrorState {
  requests: RecordedRequest[];
  unexpectedRequests: string[];
  unexpectedSocketEvents: string[];
  pageErrors: string[];
  socketConnected: boolean;
  enqueue(endpoint: AiEndpoint, response: StubResponse): void;
  pending(endpoint: AiEndpoint): number;
}

export const LABELS: Record<Language, Record<string, string>> = {
  en: {
    begin: "Get started",
    inspire: "Start from an idea",
    ideaPlaceholder:
      "For example: a near-future mystery about a journalist who has lost part of her memory.",
    generate: "Generate drafts",
    generateFailedPrefix: "Generation failed",
    polish: "Polish",
    aiRewriteFailed: "AI rewrite failed",
    improve: "Improve outline",
    check: "Run check",
    analyze: "AI analysis",
  },
  "zh-CN": {
    begin: "开始",
    inspire: "从灵感开始",
    ideaPlaceholder: "例如：我想写一本近未来悬疑小说，主角是一名失去部分记忆的记者。",
    generate: "生成草案",
    generateFailedPrefix: "生成失败",
    polish: "润色",
    aiRewriteFailed: "AI 改写失败",
    improve: "AI 完善大纲",
    check: "开始检查",
    analyze: "AI 分析",
  },
};

/** 每个语种的本地化引导锚点：缺失任一锚点说明文案或 key 有问题。 */
export const GUIDANCE_ANCHORS: Record<Language, string[]> = {
  en: ["Light model", "Settings > Models"],
  "zh-CN": ["轻量模型", "设置"],
};

export interface InstallOptions {
  language: Language;
  /** 首页/项目列表返回的项目；默认包含一个项目。 */
  includeProject?: boolean;
}

function chapterTree() {
  const chapter = {
    id: CHAPTER_ID,
    project_id: PROJECT_ID,
    volume_id: VOLUME_ID,
    title: "Synthetic Chapter",
    order: 1,
    word_count: 5,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
  return {
    volumes: [
      {
        id: VOLUME_ID,
        project_id: PROJECT_ID,
        title: "Synthetic Volume",
        order: 1,
        description: null,
        chapter_count: 1,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        chapters: [chapter],
      },
    ],
    total_chapters: 1,
  };
}

const PROJECT = {
  id: PROJECT_ID,
  title: PROJECT_TITLE,
  description: null,
  word_count: 5,
  chapter_count: 1,
  cover_url: null,
  created_at: TIMESTAMP,
  updated_at: TIMESTAMP,
};

const OUTLINE_ROOT = {
  id: ROOT_OUTLINE_ID,
  project_id: PROJECT_ID,
  parent_id: null,
  volume_id: null,
  chapter_id: null,
  level: "book",
  title: "Synthetic Root Outline",
  content: "Synthetic outline content",
  sort_order: 0,
  created_at: TIMESTAMP,
  updated_at: TIMESTAMP,
};

const SYNTHETIC_ISSUE = {
  type: "character_age",
  severity: "warning",
  message: "synthetic issue message",
  evidence: ["synthetic evidence"],
  suggestion: "synthetic suggestion",
  sources: [
    {
      chapter_id: CHAPTER_ID,
      chapter_order: 1,
      chapter_title: "Synthetic Chapter",
      excerpt: "synthetic excerpt",
      quote: "synthetic quote",
    },
  ],
};

function readCheckPayload(
  value: unknown,
): { scope: string; chapter_id: string | null; volume_id: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.scope !== "string") return null;
  return {
    scope: raw.scope,
    chapter_id: typeof raw.chapter_id === "string" ? raw.chapter_id : null,
    volume_id: typeof raw.volume_id === "string" ? raw.volume_id : null,
  };
}

export async function installAiErrorApp(
  page: Page,
  options: InstallOptions,
): Promise<AiErrorState> {
  const queues = new Map<AiEndpoint, StubResponse[]>();
  const state: AiErrorState = {
    requests: [],
    unexpectedRequests: [],
    unexpectedSocketEvents: [],
    pageErrors: [],
    socketConnected: false,
    enqueue(endpoint, response) {
      const queue = queues.get(endpoint) ?? [];
      queue.push(response);
      queues.set(endpoint, queue);
    },
    pending(endpoint) {
      return (queues.get(endpoint) ?? []).length;
    },
  };
  page.on("pageerror", (error) => state.pageErrors.push(error.message));

  const preferences = {
    language: options.language,
    theme: "light",
    theme_preset: "default",
    font_family: "system-ui",
    code_font_family: "ui-monospace",
    base_font_size: 14,
    editor_font_size: 16,
  };

  const pollingPackets: string[] = [];
  const engineOpen =
    '0{"sid":"ai-error-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
  const receivePacket = (packet: string, send: (reply: string) => void) => {
    if (packet.startsWith("40")) {
      state.socketConnected = true;
      send('40{"sid":"ai-error-namespace"}');
      return;
    }
    if (packet === "2") {
      send("3");
      return;
    }
    if (packet === "3" || packet === "41") return;
    if (!packet.startsWith("42")) {
      state.unexpectedSocketEvents.push(packet);
      return;
    }
    const values = JSON.parse(packet.slice(2)) as unknown;
    if (!Array.isArray(values)) {
      state.unexpectedSocketEvents.push(packet);
      return;
    }
    const event: unknown = values[0];
    if (event === "background:leave") return;
    if (event === "background:join") {
      send(`42${JSON.stringify(["background:joined", { project_id: PROJECT_ID }])}`);
      send(
        `42${JSON.stringify([
          "background:snapshot",
          {
            project_id: PROJECT_ID,
            project_revision: 1,
            summary: { statuses: [], maintenance: {} },
          },
        ])}`,
      );
      return;
    }
    state.unexpectedSocketEvents.push(String(event));
  };

  await page.routeWebSocket(/\/socket\.io\//, (route) => {
    let answered = false;
    route.onMessage((message) => {
      answered = true;
      receivePacket(typeof message === "string" ? message : message.toString(), (reply) =>
        route.send(reply),
      );
    });
    route.send(engineOpen);
    setTimeout(() => {
      if (!answered) {
        try {
          route.send(engineOpen);
        } catch {
          // Page already closed.
        }
      }
    }, 300);
  });
  await page.route(/\/socket\.io\//, async (route) => {
    if (route.request().method() === "POST") {
      for (const packet of (route.request().postData() ?? "").split("\x1e")) {
        receivePacket(packet, (reply) => pollingPackets.push(reply));
      }
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
      return;
    }
    if (!new URL(route.request().url()).searchParams.has("sid")) {
      await route.fulfill({ status: 200, contentType: "text/plain", body: engineOpen });
      return;
    }
    if (pollingPackets.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: pollingPackets.splice(0).join("\x1e") || "2",
    });
  });

  await page.route("**/runtime-config.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route(/https?:\/\/[^/]*(posthog|sentry)\.[^/]+\//, async (route) => {
    state.unexpectedRequests.push(`telemetry ${route.request().url()}`);
    await route.abort();
  });

  const takeResponse = (endpoint: AiEndpoint): StubResponse | null => {
    const queue = queues.get(endpoint);
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  };

  const fulfillStub = async (
    route: Route,
    endpoint: AiEndpoint,
    response: StubResponse,
    body: unknown,
  ) => {
    state.requests.push({ endpoint, body });
    if (response.kind === "unavailable") {
      await route.fulfill({
        status: 400,
        json: { detail: { code: UNAVAILABLE_CODE, message: UNAVAILABLE_MESSAGE } },
      });
      return;
    }
    if (response.kind === "detail") {
      await route.fulfill({ status: response.status, json: { detail: response.detail } });
      return;
    }
    if (endpoint === "consistency-check") {
      const payload = readCheckPayload(body);
      await route.fulfill({
        status: 200,
        json: {
          scope: payload?.scope ?? "chapter",
          label: "Synthetic scope label",
          chapter_id: payload?.chapter_id ?? null,
          volume_id: payload?.volume_id ?? null,
          chapter_count: 1,
          model: "synthetic-check-model",
          context_source: "inventory",
          issues: [SYNTHETIC_ISSUE],
        },
      });
      return;
    }
    if (endpoint === "consistency-analyze") {
      await route.fulfill({
        status: 200,
        json: { analysis: "synthetic analysis", model: "synthetic-analysis-model" },
      });
      return;
    }
    if (endpoint === "inline-ai") {
      const payload = body as { selected_text?: unknown } | null;
      const original =
        payload && typeof payload.selected_text === "string" ? payload.selected_text : "";
      await route.fulfill({
        status: 200,
        json: {
          original,
          result: response.inlineResult ?? INLINE_RESULT_TEXT,
          model: INLINE_MODEL,
          usage: null,
        },
      });
      return;
    }
    await route.fulfill({ status: 200, json: {} });
  };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/v1/, "");
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });

    if (method === "GET") {
      if (path === "/auth/status") return json({ enabled: false, authenticated: true });
      if (path === "/auth/preferences") return json(preferences);
      if (path === "/health") return json({ status: "ok", version: "synthetic" });
      if (path === "/runtime-config") return json({ posthog_enabled: false });
      if (path === "/settings") {
        return json({
          ...preferences,
          default_model: "",
          light_model: "",
          summary_model: "",
          default_embedding_model: "",
          index_mode: "off",
          index_enabled_projects: [],
          agent_tool_permissions: [],
          agent_bypass_tool_approval: false,
          summary_auto_generate_chapter: false,
          summary_auto_generate_long_term: false,
          telemetry_enabled: false,
          audit_persist_details: false,
        });
      }
      if (path === "/settings/agent-session-lock") return json({ is_locked: false });
      if (path === "/models" || path === "/model-providers") return json([]);
      if (path === "/agent-definitions") return json({ definitions: [] });
      if (path === "/retrieval/index/status") {
        return json({
          mode: "off",
          embedding_model_configured: false,
          total_projects: 1,
          total_chapters: 1,
          indexed_count: 0,
          pending_count: 0,
          in_progress_count: 0,
          failed_count: 0,
          projects: [],
        });
      }
      if (path === "/dashboard/writing") {
        return json({ summary: { active_days: 0, creative_chapters: 0 }, time_series: [] });
      }
      if (path === "/projects") {
        return json({
          items: options.includeProject === false ? [] : [PROJECT],
          total: options.includeProject === false ? 0 : 1,
          page: 1,
          page_size: 100,
        });
      }
      if (path === `/projects/${PROJECT_ID}`) return json(PROJECT);
      // 首页每日目标卡片读取项目产品属性；合成项目没有设置每日目标。
      if (path === `/projects/${PROJECT_ID}/profile`) {
        return json({
          project_id: PROJECT_ID,
          genre: "",
          synopsis: "",
          target_word_count: 0,
          daily_word_goal: 0,
          status: "drafting",
          updated_at: TIMESTAMP,
        });
      }
      if (path === `/projects/${PROJECT_ID}/chapters`) return json(chapterTree());
      if (path === `/projects/${PROJECT_ID}/notes`) {
        return json({ categories: [], root_notes: [], total_notes: 0 });
      }
      if (path === `/projects/${PROJECT_ID}/tasks`) return json({ items: [], total: 0 });
      if (path === `/projects/${PROJECT_ID}/chapter-meta`) return json({ items: [], total: 0 });
      if (path === `/projects/${PROJECT_ID}/retrieval/index/status`) {
        return json({
          project_id: PROJECT_ID,
          enabled: false,
          status: "disabled",
          title: PROJECT_TITLE,
          total_chapters: 1,
          indexed_count: 0,
          pending_count: 0,
          in_progress_count: 0,
          failed_count: 0,
          empty_content_count: 0,
          last_error: null,
          progress: 0,
        });
      }
      if (path === `/projects/${PROJECT_ID}/story-memory/status`) {
        return json({
          project_id: PROJECT_ID,
          embedding_configured: false,
          index_status: "not_created",
          last_error: null,
          last_ready_at: null,
          rebuild_job_status: null,
          counts: { chapters: 1, characters: 0, world_entries: 0, outlines: 1, notes: 0 },
        });
      }
      if (path === `/projects/${PROJECT_ID}/outlines`) {
        return json({ items: [OUTLINE_ROOT], total: 1 });
      }
      if (path === `/chapters/${CHAPTER_ID}`) {
        return json({ ...chapterTree().volumes[0].chapters[0], content: CHAPTER_CONTENT });
      }
      if (path === `/chapters/${CHAPTER_ID}/meta`) {
        return json({
          chapter_id: CHAPTER_ID,
          project_id: PROJECT_ID,
          status: "draft",
          target_word_count: 0,
          last_ai_check_at: null,
          updated_at: TIMESTAMP,
        });
      }
    }

    if (method === "POST") {
      if (path === "/story-setup/draft") {
        const response = takeResponse("story-setup");
        if (!response) {
          state.unexpectedRequests.push(`unexpected ${method} ${path}`);
          return json({ detail: "Unexpected synthetic request" }, 501);
        }
        return fulfillStub(route, "story-setup", response, request.postDataJSON());
      }
      if (path === "/inline-ai/transform") {
        const response = takeResponse("inline-ai");
        if (!response) {
          state.unexpectedRequests.push(`unexpected ${method} ${path}`);
          return json({ detail: "Unexpected synthetic request" }, 501);
        }
        return fulfillStub(route, "inline-ai", response, request.postDataJSON());
      }
      if (path === `/projects/${PROJECT_ID}/outlines/ai/improve`) {
        const response = takeResponse("outline-improve");
        if (!response) {
          state.unexpectedRequests.push(`unexpected ${method} ${path}`);
          return json({ detail: "Unexpected synthetic request" }, 501);
        }
        return fulfillStub(route, "outline-improve", response, request.postDataJSON());
      }
      if (path === `/projects/${PROJECT_ID}/consistency/check`) {
        const response = takeResponse("consistency-check");
        if (!response) {
          state.unexpectedRequests.push(`unexpected ${method} ${path}`);
          return json({ detail: "Unexpected synthetic request" }, 501);
        }
        return fulfillStub(route, "consistency-check", response, request.postDataJSON());
      }
      if (path === `/projects/${PROJECT_ID}/consistency/analyze`) {
        const response = takeResponse("consistency-analyze");
        if (!response) {
          state.unexpectedRequests.push(`unexpected ${method} ${path}`);
          return json({ detail: "Unexpected synthetic request" }, 501);
        }
        return fulfillStub(route, "consistency-analyze", response, request.postDataJSON());
      }
    }

    state.unexpectedRequests.push(`${method} ${path}`);
    return json({ detail: "Unexpected synthetic request" }, 501);
  });

  return state;
}

/** 断言没有未预期请求 / 页面异常 / socket 事件，并等待 UI 稳定。 */
export async function expectNoUnexpected(page: Page, state: AiErrorState): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }),
  );
  expect(state.unexpectedRequests).toEqual([]);
  expect(state.unexpectedSocketEvents).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  await expect.poll(() => state.socketConnected).toBe(true);
  const undrained = AI_ENDPOINTS.filter((endpoint) => state.pending(endpoint) > 0);
  expect(undrained).toEqual([]);
}

/** 应用自身（Dexie）创建的本地数据库与其 store，见 src/lib/local-db.ts。 */
const LOCAL_DATABASE_NAME = "OpenFicDB";
const LAST_CHAPTERS_STORE = "projectLastChapters";
const TABS_STORE = "projectTabs";
/** 等待应用自身建库的上限（毫秒）：超时即失败，绝不代为创建或迁移。 */
const DATABASE_WAIT_TIMEOUT = 10_000;

/**
 * 用原生 IndexedDB 预置“最后访问章节”，让写作页自动打开编辑器。
 *
 * 只读写应用自身已创建的 OpenFicDB：先等它出现，再以无版本方式打开现有连接并校验两个 store，写入精确
 * 记录、等待事务提交后回读校验，同时确认该项目没有遗留的持久标签页（不删除任何记录）。连接、事务与请求
 * 错误一律 reject，连接一律在 finally 中关闭。
 */
export async function seedLastChapterMemory(
  page: Page,
  projectId: string,
  chapterId: string,
): Promise<void> {
  await page.evaluate(
    async (value: {
      databaseName: string;
      lastChaptersStore: string;
      tabsStore: string;
      waitTimeout: number;
      projectId: string;
      chapterId: string;
    }): Promise<void> => {
      const { databaseName, lastChaptersStore, tabsStore, waitTimeout } = value;

      const requestResult = <R>(request: IDBRequest<R>): Promise<R> =>
        new Promise<R>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        });

      const transactionDone = (transaction: IDBTransaction): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () =>
            reject(transaction.error ?? new Error("IndexedDB transaction failed"));
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
        });

      const deadline = Date.now() + waitTimeout;
      for (;;) {
        const databases = await indexedDB.databases();
        if (databases.some((entry) => entry.name === databaseName)) break;
        if (Date.now() > deadline) throw new Error(`${databaseName} was not created by the app`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        let failed = false;
        const fail = (error: Error): void => {
          if (failed) return;
          failed = true;
          reject(error);
        };
        const request = indexedDB.open(databaseName);
        request.onupgradeneeded = () => {
          request.transaction?.abort();
          fail(new Error(`${databaseName} unexpectedly required an upgrade`));
        };
        request.onerror = () => fail(request.error ?? new Error(`${databaseName} open failed`));
        request.onblocked = () => fail(new Error(`${databaseName} open blocked`));
        request.onsuccess = () => (failed ? request.result.close() : resolve(request.result));
      });

      try {
        for (const store of [lastChaptersStore, tabsStore]) {
          if (!database.objectStoreNames.contains(store)) {
            throw new Error(`${databaseName} is missing the ${store} store`);
          }
        }

        const seed = database.transaction(lastChaptersStore, "readwrite");
        const seedDone = transactionDone(seed);
        await requestResult(
          seed.objectStore(lastChaptersStore).put({
            projectId: value.projectId,
            chapterId: value.chapterId,
            updatedAt: new Date(),
          }),
        );
        await seedDone;

        type StoredLastChapter = { projectId?: unknown; chapterId?: unknown };
        const readback = database.transaction(lastChaptersStore, "readonly");
        const readbackDone = transactionDone(readback);
        const memory = await requestResult<StoredLastChapter | undefined>(
          readback.objectStore(lastChaptersStore).get(value.projectId),
        );
        await readbackDone;
        const seededProjectId = memory ? memory.projectId : null;
        const seededChapterId = memory ? memory.chapterId : null;
        if (seededProjectId !== value.projectId || seededChapterId !== value.chapterId) {
          throw new Error(`failed to seed the last chapter memory for ${value.projectId}`);
        }

        const tabs = database.transaction(tabsStore, "readonly");
        const tabsDone = transactionDone(tabs);
        const savedTabs = await requestResult(tabs.objectStore(tabsStore).count(value.projectId));
        await tabsDone;
        if (savedTabs !== 0) {
          throw new Error(`expected no saved tabs for ${value.projectId}, found ${savedTabs}`);
        }
      } finally {
        database.close();
      }
    },
    {
      databaseName: LOCAL_DATABASE_NAME,
      lastChaptersStore: LAST_CHAPTERS_STORE,
      tabsStore: TABS_STORE,
      waitTimeout: DATABASE_WAIT_TIMEOUT,
      projectId,
      chapterId,
    },
  );
}

/** 断言某个 AI 端点的原始请求体形状（不做实现复制，只做严格键校验）。 */
export function expectRequestShape(
  state: AiErrorState,
  endpoint: AiEndpoint,
  index: number,
  keys: string[],
): unknown {
  const matching = state.requests.filter((request) => request.endpoint === endpoint);
  expect(matching.length).toBeGreaterThan(index);
  const body = matching[index].body;
  expect(body).toBeTruthy();
  expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([...keys].sort());
  return body;
}
