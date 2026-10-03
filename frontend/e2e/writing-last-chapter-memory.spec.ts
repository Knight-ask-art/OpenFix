/**
 * 记忆章节（最后访问章节）恢复的浏览器回归：真实写作页 + strict 合成接口 + 原生 IndexedDB 接缝。
 *
 * 四种组合（旧版原始 / 带 "chapter:" 前缀记忆 × 桌面 / 移动）各自在全新上下文中：预置应用自身已创建的
 * OpenFicDB 的 projectLastChapters（原始或前缀键），确认该项目没有持久标签页，然后正常进入项目（不手动
 * 打开任何章节）。修复前初始化读取的是带前缀的标签页 id，无法匹配章节，移动端会错开第一章；修复后必须
 * 打开记住的章节。第一章 id 与记住的章节不同，且夹具没有登记它的正文路由，一旦被错误选中会以未预期请求
 * 失败，而不是静默通过。
 *
 * 章节树只覆盖本项目精确的 chapters 路由，其它请求仍走夹具（未登记即 501 并记录）。断言当前显示的正文与
 * 标题、原生 projectTabs 的 id/ref/title，并轮询已记住的章节被生产者写回规范原始 id；随后回到首页，用原生
 * 已提交事务删除本项目唯一的 projectTabs 记录，再次进入项目，证明恢复来自 projectLastChapters 而不是
 * 持久标签页。全程断言零 AI 请求、无未预期 API/socket/页面错误。
 */
import { expect, test, type Page } from "@playwright/test";

import {
  CHAPTER_CONTENT,
  CHAPTER_ID,
  PROJECT_ID,
  TIMESTAMP,
  VOLUME_ID,
  expectNoUnexpected,
  installAiErrorApp,
} from "./ai-model-errors-fixture";

const FIRST_CHAPTER_ID = "ai-error-first-chapter"; // 真实行为绝不会自动打开它（夹具未登记其正文路由）
const FIRST_CHAPTER_TITLE = "Synthetic First Chapter";
const CHAPTER_TITLE = "Synthetic Chapter"; // 与夹具 /chapters/:id 返回的章节标题一致
/** 应用自身通过 Dexie 创建的本地数据库与其 store（见 src/lib/local-db.ts）。 */
const DATABASE_NAME = "OpenFicDB";
const LAST_CHAPTERS_STORE = "projectLastChapters";
const TABS_STORE = "projectTabs";
const EDITOR_SELECTOR = ".tiptap-editor .ProseMirror";
/** 只匹配章节编辑器内的标题输入框。 */
const TITLE_SELECTOR = ".chapter-editor-content input";
const EXPECT_TIMEOUT = 10_000;
/** 精确匹配本项目章节树端点，不匹配 /chapters/:id 正文请求。 */
const CHAPTER_TREE_PATTERN = new RegExp(`/api/v1/projects/${PROJECT_ID}/chapters(?:\\?|$)`);

test.use({
  serviceWorkers: "block",
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 10_000,
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

// 原生 IndexedDB 接缝：只读写应用自身已创建的数据库

interface PersistedProjectTabs {
  activeTabId: string | null;
  tabs: { id: string | null; refId: string | null; title: string | null }[];
}

type NativeDbOperation =
  | { kind: "wait-for-database" }
  | { kind: "seed-remembered-chapter"; projectId: string; chapterId: string }
  | { kind: "read-remembered-chapter"; projectId: string }
  | { kind: "read-project-tabs"; projectId: string }
  | { kind: "delete-project-tabs"; projectId: string };

/**
 * 在页面里执行一次原生 IndexedDB 操作：先等应用自身创建 OpenFicDB（绝不代为建库或迁移），再打开现有
 * 连接并校验 store；连接、事务与请求错误一律 reject，连接一律关闭。
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
          const seedWrite = database.transaction(lastChaptersStore, "readwrite");
          const seedDone = transactionDone(seedWrite);
          await requestResult(
            seedWrite.objectStore(lastChaptersStore).put({
              projectId: current.projectId,
              chapterId: current.chapterId,
              updatedAt: new Date(),
            }),
          );
          await seedDone;

          const tabsCheck = database.transaction(tabsStore, "readonly");
          const tabsCheckDone = transactionDone(tabsCheck);
          const savedTabs = await requestResult(
            tabsCheck.objectStore(tabsStore).count(current.projectId),
          );
          await tabsCheckDone;
          if (savedTabs !== 0) {
            throw new Error(`expected no saved tabs for ${current.projectId}, found ${savedTabs}`);
          }
          return undefined;
        }

        if (current.kind === "read-remembered-chapter") {
          const memoryRead = database.transaction(lastChaptersStore, "readonly");
          const memoryDone = transactionDone(memoryRead);
          const memory = await requestResult<{ chapterId?: unknown } | undefined>(
            memoryRead.objectStore(lastChaptersStore).get(current.projectId),
          );
          await memoryDone;
          return typeof memory?.chapterId === "string" ? memory.chapterId : null;
        }

        if (current.kind === "delete-project-tabs") {
          const deleteWrite = database.transaction(tabsStore, "readwrite");
          const deleteDone = transactionDone(deleteWrite);
          await requestResult(deleteWrite.objectStore(tabsStore).delete(current.projectId));
          await deleteDone;
          return undefined;
        }

        const tabsRead = database.transaction(tabsStore, "readonly");
        const tabsReadDone = transactionDone(tabsRead);
        const saved = await requestResult<{ tabs?: unknown; activeTabId?: unknown } | undefined>(
          tabsRead.objectStore(tabsStore).get(current.projectId),
        );
        await tabsReadDone;
        if (!saved) return null;

        const restoredTabs = Array.isArray(saved.tabs) ? saved.tabs : [];
        return {
          activeTabId: typeof saved.activeTabId === "string" ? saved.activeTabId : null,
          tabs: restoredTabs.map((tab) => {
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

/** 应用持久化标签页的规范记录：唯一打开的活动章节就是记住的章节。 */
const CANONICAL_TABS: PersistedProjectTabs = {
  activeTabId: `chapter:${CHAPTER_ID}`,
  tabs: [{ id: `chapter:${CHAPTER_ID}`, refId: CHAPTER_ID, title: CHAPTER_TITLE }],
};

const readTabs = (page: Page) =>
  nativeDb<PersistedProjectTabs | null>(page, { kind: "read-project-tabs", projectId: PROJECT_ID });
const readRemembered = (page: Page) =>
  nativeDb<string | null>(page, { kind: "read-remembered-chapter", projectId: PROJECT_ID });

/** 断言写作页当前显示的正是记住的章节（正文字与标题），并最终没有未预期请求。 */
async function expectRememberedChapterVisible(page: Page): Promise<void> {
  await expect(page.locator(EDITOR_SELECTOR)).toHaveText(CHAPTER_CONTENT, {
    timeout: EXPECT_TIMEOUT,
  });
  await expect(page.locator(TITLE_SELECTOR)).toHaveValue(CHAPTER_TITLE, { timeout: EXPECT_TIMEOUT });
}

for (const memory of [
  { name: "原始记忆", stored: CHAPTER_ID },
  { name: "前缀记忆", stored: `chapter:${CHAPTER_ID}` },
] as const) {
  for (const viewport of [
    { name: "桌面端", size: { width: 1440, height: 1000 } },
    { name: "移动端", size: { width: 390, height: 844 } },
  ] as const) {
    test.describe(`记忆章节恢复（${memory.name} / ${viewport.name}）`, () => {
      test.use({ viewport: viewport.size });

      test("通过真实读取器恢复记住的章节并由生产者写回规范 id", async ({ page }) => {
        const state = await installAiErrorApp(page, { language: "en" });
        await page.route(CHAPTER_TREE_PATTERN, (route) =>
          route.fulfill({ status: 200, json: chapterTreePayload() }),
        );

        try {
          // 预置：等应用自身建库，只写入记忆（原始或前缀），并证明该项目没有持久标签页。
          await page.goto("/");
          await nativeDb(page, { kind: "wait-for-database" });
          await nativeDb(page, {
            kind: "seed-remembered-chapter",
            projectId: PROJECT_ID,
            chapterId: memory.stored,
          });

          // 正常进入项目，不手动打开任何章节。
          await page.goto(`/projects/${PROJECT_ID}`);
          await expectRememberedChapterVisible(page);
          await expect
            .poll(() => readTabs(page), { timeout: EXPECT_TIMEOUT })
            .toEqual(CANONICAL_TABS);
          // 生产者证明：记住的章节被写回规范原始 id（前缀记忆也被规范化）。
          await expect
            .poll(() => readRemembered(page), { timeout: EXPECT_TIMEOUT })
            .toBe(CHAPTER_ID);

          // 第二阶段：回到首页，用已提交事务删除本项目唯一的标签页记录，证明恢复来自记忆而不是持久标签页。
          await page.goto("/");
          await nativeDb(page, { kind: "delete-project-tabs", projectId: PROJECT_ID });
          expect(await readTabs(page)).toBeNull();

          await page.goto(`/projects/${PROJECT_ID}`);
          await expectRememberedChapterVisible(page);
          await expect
            .poll(() => readRemembered(page), { timeout: EXPECT_TIMEOUT })
            .toBe(CHAPTER_ID);
          await expect
            .poll(() => readTabs(page), { timeout: EXPECT_TIMEOUT })
            .toEqual(CANONICAL_TABS);

          expect(state.requests).toEqual([]);
          await expectNoUnexpected(page, state);
        } finally {
          await page.unroute(CHAPTER_TREE_PATTERN);
        }
      });
    });
  }
}
