/**
 * 首页快捷入口与每日写作目标的浏览器回归（合成接口，不访问真实后端、模型或用户数据）。
 *
 * 覆盖 V1.0 返回型作者的首页缺口：
 *
 * 1. 完成引导后的首页必须直接给出「新建小说 / 导入小说」两个入口，并且分别打开既有的
 *    ProjectFormDialog 与 ImportDialog（首页不另写一套表单或第二套创建/导入实现）。
 * 2. 首页必须显示项目产品属性里已保存的每日字数目标（daily_word_goal），以及同一个
 *    项目的当日字数进度，并提供走既有 profile GET/PUT 的编辑入口。
 *    每日目标按项目保存，所以当日字数也必须按 project_id 统计；本用例让跨项目数字（800）
 *    与该项目数字（500）不同，从而证明目标卡片没有复用跨项目的「今日写作」数字。
 * 3. 保存时只写入 daily_word_goal，其余产品属性（类型、预计字数、状态）保持原值。
 * 4. 目标卡片的降级状态也必须诚实：按项目统计的当日字数读取中或读取失败时，不能显示成
 *    0 / 目标 与 0% 进度；产品属性读取失败时要说明原因并可以重试恢复编辑；输入超过后端
 *    上限（100,000,000）时在前端拦下，而不是把永久性的 400 说成「请重试」。
 * 5. 首页「新建小说」提交成功后必须直接进入新项目。创建成功却留在首页时，新项目既不在首页
 *    的最近项目里（最近项目只记录真正打开过的项目），用户也没有可以立即开始写作的入口。
 *    产品属性保存失败属于部分成功：仍然要进入新项目，同时保留部分失败的提示，不能提示成
 *    创建失败，否则用户会重复创建同一个项目。
 *
 * 引导插件、socket、以及合成项目（PROJECT_ID / PROJECT_TITLE）来自共享的 e2e 夹具
 * ai-model-errors-fixture.ts；本地「最近项目」由测试用例通过应用自身的 IndexedDB
 * （OpenFicDB.recentProjects）预置，与 seedLastChapterMemory 的做法一致。
 *
 *   cd frontend
 *   npm run dev                       # http://127.0.0.1:9000，与 playwright.config.ts 的 baseURL 一致
 *   npx playwright test e2e/home-quick-actions.spec.ts
 *
 * playwright.config.ts 未配置 webServer，需要先手动启动开发服务器；未登记的接口请求、未知 socket
 * 事件与页面异常都会导致断言失败。
 */
import { expect, test, type Page } from "@playwright/test";

import {
  expectNoUnexpected,
  installAiErrorApp,
  PROJECT_ID,
  PROJECT_TITLE,
  TIMESTAMP,
  type Language,
} from "./ai-model-errors-fixture";

test.use({ serviceWorkers: "block" });

/** 用例级 90 秒上限，重试 0 次；等待型断言统一使用配置里的 30 秒 expect 超时。 */
test.describe.configure({ retries: 0, timeout: 90_000 });

/** 应用自身的本地数据库与「最近项目」store，见 src/lib/local-db.ts。 */
const LOCAL_DATABASE_NAME = "OpenFicDB";
const RECENT_PROJECTS_STORE = "recentProjects";
/** 引导完成标记，见 src/features/onboarding/lib/onboarding-state.ts。 */
const ONBOARDING_STORAGE_KEY = "openfix.onboarding.completed";
/** 等待应用自身建库的上限（毫秒）：超时即失败，绝不代为创建或迁移。 */
const DATABASE_WAIT_TIMEOUT = 10_000;

/** 已保存的每日目标，必须来自 profile 读取而不是任何前端默认值。 */
const SAVED_DAILY_GOAL = 2000;
/** 编辑后写入的新目标。 */
const UPDATED_DAILY_GOAL = 1500;
/** 该项目当日写作字数（按 project_id 统计）。 */
const PROJECT_TODAY_WORDS = 500;
/** 跨项目当日写作字数：必须与项目数字不同，用于证明目标卡片的统计范围。 */
const GLOBAL_TODAY_WORDS = 800;
/** 保存后的项目当日进度：500 / 1500。 */
const UPDATED_PROGRESS_PERCENT = 33;
/** 每日目标上限，与后端 project_profile_service.MAX_TARGET_WORD_COUNT 一致。 */
const MAX_DAILY_GOAL = 100_000_000;
/** 上限加一：必须被前端拦下，不能发出 PUT。 */
const OVER_LIMIT_DAILY_GOAL = MAX_DAILY_GOAL + 1;
/** 按项目统计的当日字数延迟返回的毫秒数，用于把卡片停在「读取中」。 */
const PROJECT_STATS_DELAY_MS = 800;
/** 新建小说用例在对话框里真实填写的标题，必须出现在创建请求里。 */
const CREATED_NOVEL_TITLE = "Synthetic Novel Created From Home";

const LANGUAGES: Language[] = ["en", "zh-CN"];

interface HomeLabels {
  createNovel: string;
  importNovel: string;
  todayWriting: string;
  dailyGoal: string;
  dailyGoalEdit: string;
  dailyGoalUnset: string;
  dailyGoalSaveFailed: string;
  dailyGoalStatsFailed: string;
  dailyGoalProfileFailed: string;
  dailyGoalProfileRetry: string;
  /** 超限提示含千分位数字，用正则容忍分隔符。 */
  dailyGoalTooLarge: RegExp;
  goalDialogTitle: string;
  goalLabel: string;
  newProjectDialog: string;
  titlePlaceholder: string;
  importDialog: string;
  importStep: string;
  importClose: string;
  cancel: string;
  save: string;
  /** 新建对话框的主按钮，对应 common.create。 */
  create: string;
  /** 创建成功的提示，对应 projects.projectCreated。 */
  projectCreated: string;
  /** 产品属性保存失败的部分成功提示，对应 projects.profileUpdateFailed。 */
  profileUpdateFailed: string;
  /** 项目本身创建失败的提示，对应 projects.createFailed。 */
  createFailed: string;
}

/** 与 src/i18n/locales/{en,zh-CN}.json 的 home / projectForm / import / common 文案一致。 */
const LABELS: Record<Language, HomeLabels> = {
  en: {
    createNovel: "Create novel",
    importNovel: "Import novel",
    todayWriting: "Today",
    dailyGoal: "Daily goal",
    dailyGoalEdit: "Edit daily goal",
    dailyGoalUnset: "Not set",
    dailyGoalSaveFailed: "Could not save the daily goal. Please try again.",
    dailyGoalStatsFailed: "Could not load today's words for this project.",
    dailyGoalProfileFailed: "Could not load the saved daily goal.",
    dailyGoalProfileRetry: "Retry",
    dailyGoalTooLarge: /no more than 100[,.]?000[,.]?000 words per day/,
    goalDialogTitle: "Daily writing goal",
    goalLabel: "Words per day",
    newProjectDialog: "New Project",
    titlePlaceholder: "Enter project title",
    importDialog: "Import Project",
    importStep: "Select File",
    importClose: "Close",
    cancel: "Cancel",
    save: "Save",
    create: "Create",
    projectCreated: "Project created successfully",
    profileUpdateFailed:
      "Project saved, but the genre and target word count could not be saved. Please fill them in again in the project settings later.",
    createFailed: "Creation failed. Please try again.",
  },
  "zh-CN": {
    createNovel: "新建小说",
    importNovel: "导入小说",
    todayWriting: "今日写作",
    dailyGoal: "每日目标",
    dailyGoalEdit: "编辑每日目标",
    dailyGoalUnset: "未设置",
    dailyGoalSaveFailed: "每日目标保存失败，请重试。",
    dailyGoalStatsFailed: "无法读取该项目的今日字数。",
    dailyGoalProfileFailed: "无法读取已保存的每日目标。",
    dailyGoalProfileRetry: "重试",
    dailyGoalTooLarge: /每日字数不能超过 100[,.]?000[,.]?000/,
    goalDialogTitle: "每日写作目标",
    goalLabel: "每日字数",
    newProjectDialog: "新建项目",
    titlePlaceholder: "输入项目标题",
    importDialog: "导入项目",
    importStep: "选择文件",
    importClose: "关闭",
    cancel: "取消",
    save: "保存",
    create: "创建",
    projectCreated: "项目创建成功",
    profileUpdateFailed: "项目已保存，但类型与预计字数保存失败，请稍后在项目设置中重新填写",
    createFailed: "创建失败，请重试",
  },
};

interface HomeGoalState {
  /** 当前保存的每日目标；由 PUT 请求更新，后续 GET 返回最新值。 */
  goal: number;
  /** 每次产品属性写入的请求体，用于证明只写了 daily_word_goal。 */
  profilePutBodies: Record<string, unknown>[];
  /** 每次 /dashboard/writing 请求的 project_id；null 表示跨项目请求。 */
  writingScopes: (string | null)[];
  /** 置为 true 时产品属性 GET 返回 500，用于验证读取失败与重试恢复。 */
  profileGetsFail: boolean;
  /** 置为 true 时产品属性 PUT 返回 500，用于验证「项目已创建但属性保存失败」的部分成功路径。 */
  profilePutsFail: boolean;
  /** 置为 true 时按项目统计的当日字数返回 500；跨项目请求仍然成功。 */
  projectStatsFail: boolean;
  /** 按项目统计的当日字数延迟返回的毫秒数，用于验证读取中的占位状态。 */
  projectStatsDelayMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function profileBody(dailyWordGoal: number): Record<string, unknown> {
  return {
    project_id: PROJECT_ID,
    genre: "fantasy",
    synopsis: "Synthetic synopsis",
    target_word_count: 300000,
    daily_word_goal: dailyWordGoal,
    status: "drafting",
    updated_at: "2026-10-03T08:00:00Z",
  };
}

/**
 * 在共享夹具之后注册首页特有的窄路由：项目产品属性与写作统计。
 *
 * 后注册的 page.route 先匹配，因此这里覆盖夹具里返回空统计的 /dashboard/writing，
 * 同时夹具的「未登记请求」台账仍然只统计真正没人处理的路径。
 */
async function installHomeGoalStubs(
  page: Page,
  initialGoal: number = SAVED_DAILY_GOAL,
): Promise<HomeGoalState> {
  const state: HomeGoalState = {
    goal: initialGoal,
    profilePutBodies: [],
    writingScopes: [],
    profileGetsFail: false,
    profilePutsFail: false,
    projectStatsFail: false,
    projectStatsDelayMs: 0,
  };

  await page.route(/\/api\/v1\/projects\/[^/]+\/profile/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      if (state.profileGetsFail) {
        await route.fulfill({ status: 500, json: { detail: "synthetic profile read failure" } });
        return;
      }
      await route.fulfill({ status: 200, json: profileBody(state.goal) });
      return;
    }
    if (request.method() === "PUT") {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      state.profilePutBodies.push(body);
      if (state.profilePutsFail) {
        await route.fulfill({ status: 500, json: { detail: "synthetic profile write failure" } });
        return;
      }
      if (typeof body.daily_word_goal === "number") state.goal = body.daily_word_goal;
      await route.fulfill({ status: 200, json: profileBody(state.goal) });
      return;
    }
    await route.fulfill({ status: 501, json: { detail: `unexpected profile ${request.method()}` } });
  });

  await page.route(/\/api\/v1\/dashboard\/writing/, async (route) => {
    const projectId = new URL(route.request().url()).searchParams.get("project_id");
    state.writingScopes.push(projectId);
    // 只有按项目统计的请求可以按需延迟或失败；跨项目请求保持成功，
    // 这样用例既能验证目标卡片的降级状态，也能证明它没有退回跨项目数字。
    if (projectId && state.projectStatsDelayMs > 0) await delay(state.projectStatsDelayMs);
    if (projectId && state.projectStatsFail) {
      await route.fulfill({ status: 500, json: { detail: "synthetic project stats failure" } });
      return;
    }
    const words = projectId ? PROJECT_TODAY_WORDS : GLOBAL_TODAY_WORDS;
    await route.fulfill({
      status: 200,
      json: {
        summary: { active_days: 1, creative_chapters: 1 },
        time_series: [
          {
            date: "2026-10-03",
            user_word_delta: words,
            agent_word_delta: 0,
            import_word_delta: 0,
          },
        ],
      },
    });
  });

  return state;
}

interface CreateNovelState {
  /** 每次 POST /projects 的原始 multipart 请求体，用于确认对话框里填写的标题确实发了出去。 */
  createBodies: string[];
}

/**
 * 在共享夹具之后注册新建小说所需的窄路由：POST /projects（createProject 发送的是 multipart）。
 *
 * 创建结果沿用夹具里已有的项目 id，这样创建成功后跳转到的写作页仍然由夹具已经登记的窄路由
 * 负责，不必为第二个项目复制一整套写作页接口。非 POST 的同名请求交回夹具处理，这里不提供
 * 任何兜底成功，未登记的接口照旧会让用例失败。
 */
async function installCreateNovelStub(page: Page): Promise<CreateNovelState> {
  const state: CreateNovelState = { createBodies: [] };

  await page.route(
    (url) => url.pathname === "/api/v1/projects",
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      state.createBodies.push(route.request().postDataBuffer()?.toString("utf8") ?? "");
      await route.fulfill({
        status: 201,
        json: {
          id: PROJECT_ID,
          title: CREATED_NOVEL_TITLE,
          description: null,
          word_count: 0,
          chapter_count: 0,
          cover_url: null,
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
        },
      });
    },
  );

  return state;
}

/** sonner 的全局提示；Toaster 挂在路由之外，所以跳转后提示仍然存在。 */
function toastWithText(page: Page, text: string) {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

/**
 * 预置「返回型作者」的本地状态：标记引导已完成，并写入一条真实的最近项目。
 *
 * 只读写应用自身已创建的 OpenFicDB：先等它出现，再以无版本方式打开现有连接，
 * 写入记录并回读校验。连接、事务与请求错误一律 reject，连接一律在 finally 中关闭。
 */
async function seedReturningAuthor(page: Page): Promise<void> {
  await page.evaluate(
    async (value: {
      databaseName: string;
      storeName: string;
      onboardingKey: string;
      waitTimeout: number;
      projectId: string;
      title: string;
    }): Promise<void> => {
      const { databaseName, storeName, onboardingKey, waitTimeout } = value;

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

      window.localStorage.setItem(onboardingKey, "1");

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
        if (!database.objectStoreNames.contains(storeName)) {
          throw new Error(`${databaseName} is missing the ${storeName} store`);
        }

        const seed = database.transaction(storeName, "readwrite");
        const seedDone = transactionDone(seed);
        await requestResult(
          seed.objectStore(storeName).put({
            slot: 0,
            projectId: value.projectId,
            title: value.title,
            color: "blue",
            openedAt: new Date(),
          }),
        );
        await seedDone;

        type StoredRecentProject = { projectId?: unknown; title?: unknown };
        const readback = database.transaction(storeName, "readonly");
        const readbackDone = transactionDone(readback);
        const stored = await requestResult<StoredRecentProject | undefined>(
          readback.objectStore(storeName).get(0),
        );
        await readbackDone;
        if (stored?.projectId !== value.projectId || stored?.title !== value.title) {
          throw new Error(`failed to seed the recent project for ${value.projectId}`);
        }
      } finally {
        database.close();
      }
    },
    {
      databaseName: LOCAL_DATABASE_NAME,
      storeName: RECENT_PROJECTS_STORE,
      onboardingKey: ONBOARDING_STORAGE_KEY,
      waitTimeout: DATABASE_WAIT_TIMEOUT,
      projectId: PROJECT_ID,
      title: PROJECT_TITLE,
    },
  );
}

/** 打开首页并把本地状态预置为「引导已完成 + 有最近项目」的返回型作者。 */
async function openReturningAuthorHome(page: Page, labels: HomeLabels): Promise<void> {
  await page.goto("/");
  await seedReturningAuthor(page);
  await page.reload();
  await expect(page.getByRole("button", { name: labels.createNovel })).toBeVisible();
  // 引导已完成：首次使用向导不得再遮挡首页。
  await expect(page.locator(".onboarding-dialog")).toHaveCount(0);
}

function statCard(page: Page, label: string) {
  return page.locator(".writing-stat-card").filter({ hasText: label });
}

/**
 * 打开首页并把本地状态预置为「引导已完成、还没有任何项目」的首次使用者。
 *
 * 与 openReturningAuthorHome 的唯一区别是不写入最近项目：本地没有任何项目记录时，
 * /projects/:id 只可能由新建流程跳转到达，导航断言因此不会被预置的最近项目蒙混过关。
 */
async function openFirstRunAuthorHome(page: Page, labels: HomeLabels): Promise<void> {
  await page.goto("/");
  await page.evaluate((onboardingKey: string) => {
    window.localStorage.setItem(onboardingKey, "1");
  }, ONBOARDING_STORAGE_KEY);
  await page.reload();

  await expect(page.getByRole("button", { name: labels.createNovel })).toBeVisible();
  await expect(page.locator(".onboarding-dialog")).toHaveCount(0);
  // 空首页：没有最近项目列表，继续写作卡片停在空状态而不是编造一个项目。
  await expect(page.locator(".recent-projects-list")).toHaveCount(0);
  await expect(page.locator(".continue-writing-card--empty")).toHaveCount(1);
}

test("home: returning author sees the persisted daily goal with the project-scoped count", async ({
  page,
}) => {
  const labels = LABELS.en;
  const state = await installAiErrorApp(page, { language: "en" });
  const goal = await installHomeGoalStubs(page);
  await openReturningAuthorHome(page, labels);

  // 两个入口都来自既有对话框，而不是首页自建的表单。
  await expect(page.getByRole("button", { name: labels.createNovel })).toBeVisible();
  await expect(page.getByRole("button", { name: labels.importNovel })).toBeVisible();

  // 目标卡片显示的是已保存的目标，以及同一个项目的当日字数。
  const goalCard = statCard(page, labels.dailyGoal);
  await expect(goalCard).toHaveCount(1);
  await expect(goalCard).toContainText(PROJECT_TITLE);
  await expect(goalCard).toContainText(/500\s*\/\s*2[\s,.]?000/);
  await expect(goalCard.locator('[role="progressbar"], .rt-ProgressRoot').first()).toBeVisible();
  // 该项目当日字数必须来自 project_id 维度的统计，不能复用跨项目的今日数字。
  await expect(goalCard).not.toContainText(String(GLOBAL_TODAY_WORDS));

  const todayCard = statCard(page, labels.todayWriting);
  await expect(todayCard).toHaveCount(1);
  await expect(todayCard).toContainText(String(GLOBAL_TODAY_WORDS));

  expect(goal.writingScopes).toContain(PROJECT_ID);
  expect(goal.writingScopes).toContain(null);

  // 编辑入口走既有的 profile GET/PUT，只写入 daily_word_goal。
  await goalCard.getByRole("button", { name: labels.dailyGoalEdit }).click();
  const dialog = page.getByRole("dialog", { name: labels.goalDialogTitle });
  await expect(dialog).toBeVisible();
  const goalInput = dialog.getByRole("textbox", { name: labels.goalLabel });
  await expect(goalInput).toHaveValue(String(SAVED_DAILY_GOAL));
  await goalInput.fill(String(UPDATED_DAILY_GOAL));
  await dialog.getByRole("button", { name: labels.save, exact: true }).click();

  await expect(dialog).toBeHidden();
  expect(goal.profilePutBodies).toEqual([{ daily_word_goal: UPDATED_DAILY_GOAL }]);
  await expect(goalCard).toContainText(/500\s*\/\s*1[\s,.]?500/);
  await expect(
    goalCard.locator('[role="progressbar"], .rt-ProgressRoot').first(),
  ).toHaveAttribute("aria-valuenow", String(UPDATED_PROGRESS_PERCENT));

  await expectNoUnexpected(page, state);
});

for (const language of LANGUAGES) {
  test(`home (${language}): quick actions open the existing create and import dialogs`, async ({
    page,
  }) => {
    const labels = LABELS[language];
    const state = await installAiErrorApp(page, { language });
    await installHomeGoalStubs(page, 0);
    await openReturningAuthorHome(page, labels);

    // 每日目标卡片同样本地化；没有设置过目标时显示「未设置」而不是编造数字。
    const goalCard = statCard(page, labels.dailyGoal);
    await expect(goalCard).toHaveCount(1);
    await expect(goalCard.getByText(labels.dailyGoalUnset, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: labels.createNovel }).click();
    const createDialog = page.getByRole("dialog", { name: labels.newProjectDialog });
    await expect(createDialog).toBeVisible();
    await expect(createDialog.getByPlaceholder(labels.titlePlaceholder)).toBeVisible();
    await createDialog.getByRole("button", { name: labels.cancel, exact: true }).click();
    await expect(createDialog).toBeHidden();

    await page.getByRole("button", { name: labels.importNovel }).click();
    const importDialog = page.getByRole("dialog", { name: labels.importDialog });
    await expect(importDialog).toBeVisible();
    await expect(importDialog.getByText(labels.importStep)).toBeVisible();
    await importDialog
      .getByRole("button", { name: labels.importClose, exact: true })
      .first()
      .click();
    await expect(importDialog).toBeHidden();

    await expectNoUnexpected(page, state);
  });
}

/**
 * 新建小说：提交首页对话框后必须直接进入新项目，而不是留在首页看一条提示。
 *
 * 前置状态是「首次使用者」（本地没有任何项目），所以 /projects/:id 只可能由这次创建跳转到达，
 * 断言不会被预置的最近项目蒙混过关。创建接口与创建成功后的写作页都走合成窄路由。
 */
for (const language of LANGUAGES) {
  test(`home (${language}): creating a novel opens the new project`, async ({ page }) => {
    const labels = LABELS[language];
    const state = await installAiErrorApp(page, { language });
    const goal = await installHomeGoalStubs(page, 0);
    const create = await installCreateNovelStub(page);
    await openFirstRunAuthorHome(page, labels);

    await page.getByRole("button", { name: labels.createNovel }).click();
    const createDialog = page.getByRole("dialog", { name: labels.newProjectDialog });
    await expect(createDialog).toBeVisible();
    await createDialog.getByPlaceholder(labels.titlePlaceholder).fill(CREATED_NOVEL_TITLE);
    await createDialog.getByRole("button", { name: labels.create, exact: true }).click();

    // 创建成功：目的地是新建小说的写作页本身，不再停在首页。
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}$`));
    await expect(page.locator(".writing-page-root")).toBeVisible();
    await expect(createDialog).toBeHidden();
    await expect(toastWithText(page, labels.projectCreated).first()).toBeVisible();

    // 创建请求确实带着对话框里填写的标题，产品属性也按同一笔事务写入。
    expect(create.createBodies).toHaveLength(1);
    expect(create.createBodies[0]).toContain(CREATED_NOVEL_TITLE);
    expect(goal.profilePutBodies[0]).toEqual({ genre: "", target_word_count: 0 });

    await expectNoUnexpected(page, state);
  });
}

/**
 * 产品属性保存失败是部分成功：项目本身已经创建成功，必须仍然进入新项目，并且提示的是
 * 「类型与预计字数没有保存」而不是「创建失败」，否则用户会重复创建同一个项目。
 * 只固定一个语种：这条分支与语言无关，两种语言的文案已在 LABELS 中声明。
 */
test("home (en): a failed profile write still opens the created project", async ({ page }) => {
  const labels = LABELS.en;
  const state = await installAiErrorApp(page, { language: "en" });
  const goal = await installHomeGoalStubs(page, 0);
  goal.profilePutsFail = true;
  const create = await installCreateNovelStub(page);
  await openFirstRunAuthorHome(page, labels);

  await page.getByRole("button", { name: labels.createNovel }).click();
  const createDialog = page.getByRole("dialog", { name: labels.newProjectDialog });
  await expect(createDialog).toBeVisible();
  await createDialog.getByPlaceholder(labels.titlePlaceholder).fill(CREATED_NOVEL_TITLE);
  await createDialog.getByRole("button", { name: labels.create, exact: true }).click();

  // 部分失败：提示类型与预计字数没有保存，但新项目仍然可以立即进入。
  await expect(toastWithText(page, labels.profileUpdateFailed).first()).toBeVisible();
  await expect(toastWithText(page, labels.createFailed)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}$`));
  await expect(page.locator(".writing-page-root")).toBeVisible();

  expect(create.createBodies).toHaveLength(1);
  expect(goal.profilePutBodies[0]).toEqual({ genre: "", target_word_count: 0 });

  await expectNoUnexpected(page, state);
});

/**
 * 每日目标卡片的降级状态。
 *
 * 这三条都不是正常路径，但都出现在真实使用里，而且都会退化成误导性的界面：
 * 当日字数读不到时显示成 0、产品属性读不到时编辑入口永久禁用、超限输入被后端 400 拒绝后
 * 提示用户「请重试」。所以每条都由浏览器用例固定住。
 */
for (const language of LANGUAGES) {
  test(`home (${language}): a pending or failed project stats request is never shown as a zero goal`, async ({
    page,
  }) => {
    const labels = LABELS[language];
    const state = await installAiErrorApp(page, { language });
    const goal = await installHomeGoalStubs(page);
    // 目标已经保存，但按项目统计的当日字数先是慢、随后失败。
    goal.projectStatsDelayMs = PROJECT_STATS_DELAY_MS;
    goal.projectStatsFail = true;
    await openReturningAuthorHome(page, labels);

    const goalCard = statCard(page, labels.dailyGoal);
    await expect(goalCard).toHaveCount(1);
    // 编辑入口可用说明产品属性已经读到，计数请求因此已经发出、但还停在 800ms 的延迟里。
    await expect(goalCard.getByRole("button", { name: labels.dailyGoalEdit })).toBeEnabled();

    // 读取中：没有进度条，也不能把「还不知道」写成 0 / 2,000。
    await expect(goalCard.locator('[role="progressbar"], .rt-ProgressRoot')).toHaveCount(0);
    await expect(goalCard).not.toContainText(/0\s*\/\s*2[\s,.]?000/);

    // 读取失败：说明失败原因，进度仍然不伪装成 0，也不回退到跨项目的今日数字。
    await expect(goalCard).toContainText(labels.dailyGoalStatsFailed);
    await expect(goalCard.locator('[role="progressbar"], .rt-ProgressRoot')).toHaveCount(0);
    await expect(goalCard).not.toContainText(/0\s*\/\s*2[\s,.]?000/);
    await expect(goalCard).not.toContainText(String(GLOBAL_TODAY_WORDS));

    // 当日字数仍然只按当前项目统计。
    expect(goal.writingScopes).toContain(PROJECT_ID);

    await expectNoUnexpected(page, state);
  });

  test(`home (${language}): a failed profile read explains itself and retry restores editing`, async ({
    page,
  }) => {
    const labels = LABELS[language];
    const state = await installAiErrorApp(page, { language });
    const goal = await installHomeGoalStubs(page);
    // 产品属性读取失败：编辑入口不能就此永久禁用。
    goal.profileGetsFail = true;
    await openReturningAuthorHome(page, labels);

    const goalCard = statCard(page, labels.dailyGoal);
    await expect(goalCard).toHaveCount(1);
    await expect(goalCard).toContainText(labels.dailyGoalProfileFailed);
    const editButton = goalCard.getByRole("button", { name: labels.dailyGoalEdit });
    await expect(editButton).toBeDisabled();

    // 读取恢复后，同一个查询的重试必须让卡片回到真实目标，并重新允许编辑。
    goal.profileGetsFail = false;
    await goalCard.getByRole("button", { name: labels.dailyGoalProfileRetry }).click();

    await expect(editButton).toBeEnabled();
    await expect(goalCard).toContainText(/500\s*\/\s*2[\s,.]?000/);
    await expect(goalCard).not.toContainText(labels.dailyGoalProfileFailed);

    await expectNoUnexpected(page, state);
  });

  test(`home (${language}): the daily goal input enforces the backend maximum`, async ({ page }) => {
    const labels = LABELS[language];
    const state = await installAiErrorApp(page, { language });
    const goal = await installHomeGoalStubs(page);
    await openReturningAuthorHome(page, labels);

    const goalCard = statCard(page, labels.dailyGoal);
    await goalCard.getByRole("button", { name: labels.dailyGoalEdit }).click();
    const dialog = page.getByRole("dialog", { name: labels.goalDialogTitle });
    await expect(dialog).toBeVisible();
    const goalInput = dialog.getByRole("textbox", { name: labels.goalLabel });

    // 超过上限：给出明确的校验提示，不发请求，更不能说成「保存失败，请重试」。
    await goalInput.fill(String(OVER_LIMIT_DAILY_GOAL));
    await expect(dialog).toContainText(labels.dailyGoalTooLarge);
    await expect(dialog).not.toContainText(labels.dailyGoalSaveFailed);
    await expect(dialog.getByRole("button", { name: labels.save, exact: true })).toBeDisabled();
    expect(goal.profilePutBodies).toEqual([]);

    // 恰好等于上限：必须被接受，说明上限就是 100,000,000 而不是更小。
    await goalInput.fill(String(MAX_DAILY_GOAL));
    await expect(dialog).not.toContainText(labels.dailyGoalTooLarge);
    await dialog.getByRole("button", { name: labels.save, exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(goal.profilePutBodies).toEqual([{ daily_word_goal: MAX_DAILY_GOAL }]);

    await expectNoUnexpected(page, state);
  });
}
