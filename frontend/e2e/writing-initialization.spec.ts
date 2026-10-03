/**
 * 写作页初始化的浏览器回归：真实写作页 + 严格合成接口 + 原生 IndexedDB 接缝。场景是本地
 * 标签页先就绪（没有持久标签页）而章节树响应被屏障挂起：修复前初始化会在「章节列表为空」
 * 的未知章节树上完成并闩锁，修复后屏障释放时只打开记住的章节，正文与已保存内容一致。
 * 桌面与移动端各一个用例，第一章不是记住的章节，用于证明恢复的是记住的 id。预置与读取都用
 * 原生 IndexedDB，作用于 Playwright 上下文里由应用自身创建的 OpenFicDB，不使用仅 Vite
 * dev server 提供的 /src 模块导入，因此可用于生产构建产物的校验。未登记的请求、socket
 * 事件与页面异常都会导致断言失败。
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import {
  CHAPTER_CONTENT,
  CHAPTER_ID,
  PROJECT_ID,
  TIMESTAMP,
  VOLUME_ID,
  expectNoUnexpected,
  installAiErrorApp,
} from "./ai-model-errors-fixture";

const FIRST_CHAPTER_ID = "ai-error-first-chapter"; // 真实行为绝不会自动打开它
const FIRST_CHAPTER_TITLE = "Synthetic First Chapter";
const CHAPTER_TITLE = "Synthetic Chapter"; // 与夹具返回的章节正文标题保持一致
/** 应用自身通过 Dexie 创建的本地数据库与其 store（见 src/lib/local-db.ts）。 */
const DATABASE_NAME = "OpenFicDB";
const LAST_CHAPTERS_STORE = "projectLastChapters";
const TABS_STORE = "projectTabs";
/** 初始化握手标记：只记录应用真实 projectTabs.get 的完成情况，不改变其结果。 */
const PROBE_KEY = "__writingInitProbe";

const EDITOR_SELECTOR = ".tiptap-editor .ProseMirror";
const LOADING_OVERLAY_SELECTOR = ".writing-page-loading-overlay";
const EXPECT_TIMEOUT = 10_000;

/** 精确匹配章节树端点，不匹配 /chapters/:id 正文请求。 */
const CHAPTER_TREE_PATTERN = new RegExp(`/api/v1/projects/${PROJECT_ID}/chapters(?:\\?|$)`);

test.use({
  serviceWorkers: "block",
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 10_000,
  // 冷启动的 dev server 需要转译写作页模块，因此导航超时与断言超时分开设置。
  navigationTimeout: 30_000,
});

/** 用例级 60 秒上限，重试 0 次；断言与动作超时另由 EXPECT_TIMEOUT / test.use 控制。 */
test.describe.configure({ retries: 0, timeout: 60_000 });

/** 与真实后端 GET /projects/:id/chapters 响应形状一致（消费方为 fetchChapters -> transformVolumeTree）。 */
function chapterTreePayload(): Record<string, unknown> {
  const chapter = (id: string, title: string, order: number) => ({
    id,
    project_id: PROJECT_ID,
    volume_id: VOLUME_ID,
    title,
    order,
    word_count: 5,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  });

  return {
    volumes: [
      {
        id: VOLUME_ID,
        project_id: PROJECT_ID,
        title: "Synthetic Volume",
        order: 1,
        description: null,
        chapter_count: 2,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        chapters: [
          chapter(FIRST_CHAPTER_ID, FIRST_CHAPTER_TITLE, 1),
          chapter(CHAPTER_ID, CHAPTER_TITLE, 2),
        ],
      },
    ],
    total_chapters: 2,
  };
}

interface ChapterTreeBarrier {
  /** 当前被挂起的章节树请求数量。 */
  held: () => number;
  /** 释放全部被挂起的请求，之后的请求立即返回同一份合成章节树。 */
  release: () => Promise<void>;
}

/**
 * 在 installAiErrorApp 之后注册章节树屏障：Playwright 后注册的处理器优先，命中的请求只会
 * 在 release() 之后返回同一份合成数据，不存在匿名放行兜底。
 */
async function installDelayedChapterTree(page: Page): Promise<ChapterTreeBarrier> {
  const heldRequests: Route[] = [];
  let isReleased = false;

  await page.route(CHAPTER_TREE_PATTERN, async (route) => {
    if (isReleased) {
      await route.fulfill({ status: 200, json: chapterTreePayload() });
      return;
    }
    heldRequests.push(route);
  });

  return {
    held: () => heldRequests.length,
    release: async () => {
      isReleased = true;
      const pending = heldRequests.splice(0);
      await Promise.all(
        pending.map((route) => route.fulfill({ status: 200, json: chapterTreePayload() })),
      );
    },
  };
}

// 原生 IndexedDB 接缝：只读写应用自身已创建的数据库

interface PersistedProjectTabs {
  activeTabId: string | null;
  tabs: { id: string | null; refId: string | null; title: string | null }[];
}

type NativeDbOperation =
  | { kind: "wait-for-database" }
  | { kind: "seed-remembered-chapter"; projectId: string; chapterId: string }
  | { kind: "read-project-tabs"; projectId: string };

/**
 * 在页面里执行一次原生 IndexedDB 操作：先等应用自身创建 OpenFicDB（绝不代为建库或迁移），
 * 再打开现有连接并校验 store；连接、事务与请求错误一律 reject，连接一律关闭。
 */
async function nativeDb<T>(page: Page, operation: NativeDbOperation): Promise<T> {
  const result: unknown = await page.evaluate(
    async (value: {
      operation: NativeDbOperation;
      databaseName: string;
      lastChaptersStore: string;
      tabsStore: string;
      waitTimeout: number;
    }): Promise<unknown> => {
      const { databaseName, lastChaptersStore, tabsStore, waitTimeout, operation: current } = value;

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

      const openDatabase = (): Promise<IDBDatabase> =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(databaseName);
          request.onupgradeneeded = () => {
            request.transaction?.abort();
            reject(new Error(`${databaseName} unexpectedly required an upgrade`));
          };
          request.onerror = () => reject(request.error ?? new Error(`${databaseName} open failed`));
          request.onblocked = () => reject(new Error(`${databaseName} open blocked`));
          request.onsuccess = () => resolve(request.result);
        });

      const deadline = Date.now() + waitTimeout;
      for (;;) {
        const databases = await indexedDB.databases();
        if (databases.some((entry) => entry.name === databaseName)) break;
        if (Date.now() > deadline) throw new Error(`${databaseName} was not created by the app`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const database = await openDatabase();
      try {
        for (const store of [lastChaptersStore, tabsStore]) {
          if (!database.objectStoreNames.contains(store)) {
            throw new Error(`${databaseName} is missing the ${store} store`);
          }
        }

        if (current.kind === "wait-for-database") return undefined;

        if (current.kind === "seed-remembered-chapter") {
          const writeTransaction = database.transaction(lastChaptersStore, "readwrite");
          const writeDone = transactionDone(writeTransaction);
          const writeRequest = writeTransaction.objectStore(lastChaptersStore).put({
            projectId: current.projectId,
            chapterId: current.chapterId,
            updatedAt: new Date(),
          });
          await requestResult(writeRequest);
          await writeDone;

          const tabsTransaction = database.transaction(tabsStore, "readonly");
          const tabsDone = transactionDone(tabsTransaction);
          const savedTabs = await requestResult(
            tabsTransaction.objectStore(tabsStore).count(current.projectId),
          );
          await tabsDone;
          if (savedTabs !== 0) {
            throw new Error(`expected no saved tabs for ${current.projectId}, found ${savedTabs}`);
          }
          return undefined;
        }

        const readTransaction = database.transaction(tabsStore, "readonly");
        const readDone = transactionDone(readTransaction);
        const record = await requestResult<unknown>(
          readTransaction.objectStore(tabsStore).get(current.projectId),
        );
        await readDone;
        if (!record) return null;

        const saved = record as { tabs?: unknown; activeTabId?: unknown };
        const tabs = Array.isArray(saved.tabs) ? saved.tabs : [];
        return {
          activeTabId: typeof saved.activeTabId === "string" ? saved.activeTabId : null,
          tabs: tabs.map((tab) => {
            const entry = tab as { id?: unknown; refId?: unknown; title?: unknown };
            return {
              id: typeof entry.id === "string" ? entry.id : null,
              refId: typeof entry.refId === "string" ? entry.refId : null,
              title: typeof entry.title === "string" ? entry.title : null,
            };
          }),
        };
      } finally {
        database.close();
      }
    },
    {
      operation,
      databaseName: DATABASE_NAME,
      lastChaptersStore: LAST_CHAPTERS_STORE,
      tabsStore: TABS_STORE,
      waitTimeout: EXPECT_TIMEOUT,
    },
  );

  return result as T;
}

/** 用原生 IndexedDB 读取应用持久化的标签页记录。 */
function readSavedTabs(page: Page): Promise<PersistedProjectTabs | null> {
  return nativeDb<PersistedProjectTabs | null>(page, {
    kind: "read-project-tabs",
    projectId: PROJECT_ID,
  });
}

/** 等应用自身建库，然后只预置原始（未加前缀）的最后访问章节，并确认该项目没有已保存标签页。 */
async function seedRememberedChapter(page: Page): Promise<void> {
  await page.goto("/");
  await nativeDb(page, { kind: "wait-for-database" });
  await nativeDb(page, {
    kind: "seed-remembered-chapter",
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
  });
}

// 初始化握手：观测应用真实的 projectTabs.get 完成情况

/** 单次原生 get 的完成情况：记录不存在，或记录存在时的形状（顶层键与 tabs 长度）。 */
interface ProjectTabsProbe {
  completions: { empty: boolean; keys: string[] | null; tabCount: number | null }[];
}

/**
 * 在页面脚本之前安装观测器：转发原生 IDBObjectStore.get 的 this 与实参，仅当读取的是
 * OpenFicDB/projectTabs/当前项目 时记录原生 success 的完成情况与结果形状；纯观测，
 * 不修改 get 结果，也不触发任何产品行为。
 */
async function installProjectTabsProbe(page: Page): Promise<void> {
  await page.addInitScript(
    (config: { key: string; databaseName: string; storeName: string; projectId: string }) => {
      const probe: ProjectTabsProbe = { completions: [] };
      (window as unknown as Record<string, unknown>)[config.key] = probe;

      const nativeGetDescriptor = Object.getOwnPropertyDescriptor(
        IDBObjectStore.prototype,
        "get",
      );
      const nativeGetValue: unknown = nativeGetDescriptor?.value;
      if (typeof nativeGetValue !== "function") {
        throw new Error("IDBObjectStore.prototype.get is not a function");
      }
      const nativeGet = nativeGetValue as (
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ) => IDBRequest<unknown>;
      IDBObjectStore.prototype.get = function (
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        const request: IDBRequest<unknown> = nativeGet.call(this, query);
        if (
          this.name === config.storeName &&
          this.transaction.db.name === config.databaseName &&
          query === config.projectId
        ) {
          request.addEventListener("success", () => {
            const stored = request.result as { tabs?: unknown } | undefined;
            const tabs = Array.isArray(stored?.tabs) ? stored.tabs : null;
            probe.completions.push({
              empty: stored === undefined,
              keys: stored ? Object.keys(stored).sort() : null,
              tabCount: tabs ? tabs.length : null,
            });
          });
        }
        return request;
      };
    },
    { key: PROBE_KEY, databaseName: DATABASE_NAME, storeName: TABS_STORE, projectId: PROJECT_ID },
  );
}

async function readTabsProbe(page: Page): Promise<ProjectTabsProbe | null> {
  return page.evaluate(
    (key: string) =>
      ((window as unknown as Record<string, unknown>)[key] as ProjectTabsProbe | undefined) ?? null,
    PROBE_KEY,
  );
}

/** 探针是否记录了「该项目没有已保存标签页」：至少完成一次，且每次都没有标签页。 */
function hasNoSavedTabs(probe: ProjectTabsProbe | null): boolean {
  if (!probe || probe.completions.length === 0) return false;
  return probe.completions.every((completion) => completion.empty || completion.tabCount === 0);
}

/** 等待 React 提交完成：两个 rAF 加一个宏任务。 */
async function settleUi(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }),
  );
}

for (const viewport of [
  { name: "桌面端", size: { width: 1440, height: 1000 } },
  { name: "移动端", size: { width: 390, height: 844 } },
] as const) {
  test.describe(`写作页初始化（${viewport.name}）`, () => {
    test.use({ viewport: viewport.size });

    test("章节树延迟到达时恢复记住的章节而不是永久闩锁", async ({ page }) => {
      const state = await installAiErrorApp(page, { language: "en" });
      const barrier = await installDelayedChapterTree(page);

      try {
        await installProjectTabsProbe(page);
        await seedRememberedChapter(page);
        await page.goto(`/projects/${PROJECT_ID}`);

        // 章节树被挂起：真实 projectTabs 读取必须先完成且没有记录，此阶段绝不自动打开章节。
        await expect.poll(() => barrier.held(), { timeout: EXPECT_TIMEOUT }).toBeGreaterThan(0);
        await expect
          .poll(async () => hasNoSavedTabs(await readTabsProbe(page)), { timeout: EXPECT_TIMEOUT })
          .toBe(true);
        await settleUi(page);

        const completions = (await readTabsProbe(page))?.completions ?? [];
        expect(completions.length).toBeGreaterThan(0);
        expect(completions.every((c) => c.empty || c.tabCount === 0)).toBe(true);

        await expect(page.locator(LOADING_OVERLAY_SELECTOR)).toBeVisible({
          timeout: EXPECT_TIMEOUT,
        });
        await expect(page.locator(EDITOR_SELECTOR)).toHaveCount(0, { timeout: EXPECT_TIMEOUT });
        await expect(page.getByText(CHAPTER_CONTENT)).toHaveCount(0, { timeout: EXPECT_TIMEOUT });

        await barrier.release();

        // 章节树就绪：只打开记住的章节，正文与原生持久化的标签页都必须与之一致且未被改写。
        await expect(page.locator(EDITOR_SELECTOR)).toBeVisible({ timeout: EXPECT_TIMEOUT });
        await expect(page.locator(EDITOR_SELECTOR)).toHaveText(CHAPTER_CONTENT, {
          timeout: EXPECT_TIMEOUT,
        });
        await expect
          .poll(() => readSavedTabs(page), { timeout: EXPECT_TIMEOUT })
          .toEqual({
            activeTabId: `chapter:${CHAPTER_ID}`,
            tabs: [{ id: `chapter:${CHAPTER_ID}`, refId: CHAPTER_ID, title: CHAPTER_TITLE }],
          });
        await expect(page.locator(LOADING_OVERLAY_SELECTOR)).toHaveCount(0, {
          timeout: EXPECT_TIMEOUT,
        });

        await expectNoUnexpected(page, state);
      } finally {
        await barrier.release();
        await page.unroute(CHAPTER_TREE_PATTERN);
      }
    });
  });
}
