/**
 * Project form boundary regressions
 *
 * Three V1 authoring-data boundary defects are covered here:
 *
 * 1. Editing a project whose product profile failed to load must not overwrite the
 *    stored genre / target word count with empty values, and must offer a localized
 *    retry instead of a fake loading state.
 * 2. One create/update transaction (project POST/PATCH plus the separate profile PUT)
 *    must be submitted exactly once, even while the profile PUT is still in flight.
 * 3. A successful save closes the dialog from the parent (setFormDialogOpen(false)), which
 *    bypasses the dialog's own close handler. That must still end the form session: a second
 *    "New Project" has to start empty instead of reusing the previous session's genre and
 *    target word count.
 *
 * All backend calls are stubbed with isolated synthetic data, so the spec runs against
 * the Vite dev server only. No backend, provider key, or real user data is involved.
 *
 *   cd frontend
 *   npm run dev                       # http://127.0.0.1:9000, matches playwright.config.ts baseURL
 *   npx playwright test e2e/project-form-boundaries.spec.ts
 *
 * frontend/playwright.config.ts pins baseURL to http://127.0.0.1:9000 and does not read the
 * PLAYWRIGHT_TEST_BASE_URL environment variable, so setting that variable has no effect.
 * To run against a Vite server on another port, use the alternate-port config instead of
 * editing frontend/playwright.config.ts (it points testDir at frontend/e2e, matches this spec
 * by file name, and uses baseURL http://127.0.0.1:19003):
 *
 *   pnpm --dir frontend exec playwright test --config ../tmp/openfix-ui-boundaries.playwright.config.mjs
 */

import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const API_PREFIX = "/api/v1";
const PROJECT_ID = "e2e-project-alpha";
const PROJECT_TITLE = "E2E Alpha";
const CREATED_PROJECT_ID = "e2e-project-created";
const SAVED_GENRE = "fantasy";
const SAVED_TARGET_WORD_COUNT = 300000;

interface StubProfile {
  genre: string;
  targetWordCount: number;
}

/** 未单独配置的项目读取产品属性时返回的默认值。 */
const DEFAULT_STUB_PROFILE: StubProfile = {
  genre: SAVED_GENRE,
  targetWordCount: SAVED_TARGET_WORD_COUNT,
};

const APP_PREFERENCES = {
  language: "en",
  theme: "light",
  theme_preset: "default",
  font_family: "system-ui",
  code_font_family: "ui-monospace",
  base_font_size: 14,
  editor_font_size: 16,
};

const APP_SETTINGS = {
  ...APP_PREFERENCES,
  default_model: "",
  light_model: "",
  summary_model: "system-light",
  summary_auto_generate_chapter: true,
  summary_auto_generate_long_term: true,
  summary_min_chapter_word_count: 500,
  summary_batch_size: 10,
  summary_long_term_interval: 10,
  summary_chapter_target_length: 200,
  summary_long_term_target_length: 500,
  default_embedding_model: "",
  index_mode: "off",
  index_enabled_projects: [],
  index_chunk_size: 800,
  index_chunk_overlap: 100,
  index_auto_strategy: "off",
  index_rerank_enabled: false,
  default_rerank_model: "",
  agent_bypass_tool_approval: false,
  agent_tool_permissions: [],
  audit_persist_details: false,
  compress_system_prompts: false,
  telemetry_enabled: false,
  editor_auto_indent: true,
  editor_auto_convert_punctuation: false,
  editor_auto_pair_symbols: false,
  editor_show_line_numbers: false,
};

interface StubState {
  projects: Record<string, unknown>[];
  /** 每个项目的产品属性；未列出的项目读取时返回默认值。 */
  profiles: Record<string, StubProfile>;
  /** 前 N 次产品属性读取返回 500，用于覆盖「读取失败 → 重试」。 */
  profileGetFailuresRemaining: number;
  profileGetDelayMs: number;
  profileGetGate: Promise<void> | null;
  profileGetCalls: number;
  profilePutDelayMs: number;
  profilePutBodies: Record<string, unknown>[];
  projectPostBodies: string[];
  projectPatchBodies: string[];
  projectPostCount: number;
  projectPatchCount: number;
}

function buildProjectRow(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    description: "",
    word_count: 1200,
    chapter_count: 3,
    cover_url: null,
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-02T08:00:00.000Z",
  };
}

function createStubState(overrides: Partial<StubState> = {}): StubState {
  return {
    projects: [buildProjectRow(PROJECT_ID, PROJECT_TITLE)],
    profiles: {},
    profileGetFailuresRemaining: 0,
    profileGetDelayMs: 0,
    profileGetGate: null,
    profileGetCalls: 0,
    profilePutDelayMs: 0,
    profilePutBodies: [],
    projectPostBodies: [],
    projectPatchBodies: [],
    projectPostCount: 0,
    projectPatchCount: 0,
    ...overrides,
  };
}

/** 从 multipart 表单体里取出字段值（创建/更新项目走 FormData）。 */
function readMultipartField(postData: string | null, name: string): string | null {
  if (!postData) return null;
  const match = postData.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`));
  return match?.[1] ?? null;
}

function readJsonBody(request: Request): Record<string, unknown> | null {
  try {
    const parsed = request.postDataJSON() as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function installStubs(page: Page, state: StubState): Promise<void> {
  await page.route("**/runtime-config.json", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "" }),
  );

  // 初始化必须等到 socket 连接成功；用协议级 mock 让它立刻 connect：
  // Engine.IO open 包 -> Socket.IO connect 包 `40` -> connect ack `40{"sid":...}`。
  await page.routeWebSocket(/socket\.io/, (socket) => {
    const openPacket =
      '0{"sid":"e2e-socket","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
    let clientAnswered = false;
    const sendOpen = () => {
      try {
        socket.send(openPacket);
      } catch {
        // 页面关闭时忽略。
      }
    };

    socket.onMessage((message) => {
      clientAnswered = true;
      const data = typeof message === "string" ? message : message.toString();
      if (data.startsWith("40")) {
        socket.send('40{"sid":"e2e-socket"}');
        return;
      }
      if (data === "2") socket.send("3");
    });

    sendOpen();
    // 兜底：若 open 包早于页面 WebSocket 的 open 事件而丢失，再补发一次。
    setTimeout(() => {
      if (!clientAnswered) sendOpen();
    }, 300);
  });

  // 若客户端退回 HTTP 长轮询，也要能完成握手（正常路径走上面的 WebSocket mock）。
  let pollingPhase: "open" | "connect-ack" | "idle" = "open";
  await page.route("**/socket.io/**", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
      return;
    }
    if (pollingPhase === "open") {
      pollingPhase = "connect-ack";
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: '0{"sid":"e2e-polling","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}',
      });
      return;
    }
    if (pollingPhase === "connect-ack") {
      pollingPhase = "idle";
      await route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: '40{"sid":"e2e-polling"}',
      });
      return;
    }
    // 空响应会让客户端判定解析错误，这里按长轮询挂起后再发一个 ping。
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      await route.fulfill({ status: 200, contentType: "text/plain", body: "2" });
    } catch {
      // 用例结束时页面可能已关闭。
    }
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    // ---- 应用初始化 ----
    if (path === `${API_PREFIX}/auth/status`) return json({ enabled: false, authenticated: true });
    if (path === `${API_PREFIX}/auth/preferences`) return json(APP_PREFERENCES);
    if (path === `${API_PREFIX}/health`) return json({ status: "ok", version: "e2e" });
    if (path === `${API_PREFIX}/settings`) return json(APP_SETTINGS);
    if (path === `${API_PREFIX}/models`) return json([]);

    // ---- 项目列表 / 创建 ----
    if (path === `${API_PREFIX}/projects`) {
      if (method === "GET") {
        return json({
          items: state.projects,
          total: state.projects.length,
          page: 1,
          page_size: 40,
        });
      }
      if (method === "POST") {
        state.projectPostCount += 1;
        const postData = request.postData();
        state.projectPostBodies.push(postData ?? "");
        // 每次创建返回不同 id，避免合成数据里出现重复项目 id。
        const row = buildProjectRow(
          `${CREATED_PROJECT_ID}-${state.projectPostCount}`,
          readMultipartField(postData, "title") ?? "Untitled",
        );
        state.projects = [...state.projects, row];
        return json(row);
      }
    }

    // ---- 产品属性 ----
    const profileMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/profile$/);
    if (profileMatch) {
      const projectId = profileMatch[1];

      if (method === "GET") {
        state.profileGetCalls += 1;
        if (state.profileGetGate) await state.profileGetGate;
        if (state.profileGetDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.profileGetDelayMs));
        }
        if (state.profileGetFailuresRemaining > 0) {
          state.profileGetFailuresRemaining -= 1;
          return json({ detail: "profile unavailable" }, 500);
        }
        const stored = state.profiles[projectId] ?? DEFAULT_STUB_PROFILE;
        return json({
          project_id: projectId,
          genre: stored.genre,
          synopsis: "",
          target_word_count: stored.targetWordCount,
          daily_word_goal: 0,
          status: "drafting",
          updated_at: "2026-10-02T08:00:00.000Z",
        });
      }

      if (method === "PUT") {
        if (state.profilePutDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.profilePutDelayMs));
        }
        const body: Record<string, unknown> = readJsonBody(request) ?? {};
        state.profilePutBodies.push(body);
        const stored: StubProfile = {
          genre: typeof body.genre === "string" ? body.genre : "",
          targetWordCount: typeof body.target_word_count === "number" ? body.target_word_count : 0,
        };
        // 持久化本次写入，后续读取（例如保存后重新打开编辑）能看到最新值。
        state.profiles[projectId] = stored;
        return json({
          project_id: projectId,
          genre: stored.genre,
          synopsis: "",
          target_word_count: stored.targetWordCount,
          daily_word_goal: 0,
          status: "drafting",
          updated_at: "2026-10-02T08:00:00.000Z",
        });
      }
    }

    // ---- 单个项目 ----
    const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (projectMatch) {
      const projectId = projectMatch[1];

      if (method === "PATCH") {
        state.projectPatchCount += 1;
        const postData = request.postData();
        state.projectPatchBodies.push(postData ?? "");
        const existing = state.projects.find((project) => project.id === projectId);
        const updated = {
          ...(existing ?? buildProjectRow(projectId ?? PROJECT_ID, PROJECT_TITLE)),
          title: readMultipartField(postData, "title") ?? PROJECT_TITLE,
          description: readMultipartField(postData, "description") ?? "",
        };
        state.projects = state.projects.map((project) =>
          project.id === projectId ? updated : project,
        );
        return json(updated);
      }

      if (method === "GET") {
        const existing = state.projects.find((project) => project.id === projectId);
        if (!existing) return json({ detail: "not found" }, 404);
        return json(existing);
      }
    }

    // 其余接口与本用例无关：显式 404，避免意外连到真实后端。
    return json({ detail: `unhandled e2e stub: ${method} ${path}` }, 404);
  });
}

async function openProjectsPage(page: Page): Promise<void> {
  await page.goto("/projects");
  await expect(page.getByRole("button", { name: "New Project" })).toBeVisible();
}

/** 对话框定位：优先用可访问名称，必要时兜底按标题文本过滤。 */
function projectFormDialog(page: Page, title: "New Project" | "Edit Project") {
  return page
    .getByRole("dialog", { name: title })
    .or(page.getByRole("dialog").filter({ hasText: title }))
    .first();
}

async function openEditDialog(page: Page, projectTitle: string = PROJECT_TITLE) {
  // 项目卡片根节点是 Radix Themes Card；同时兜底用「包含标题且含操作按钮的最近祖先」定位。
  const card = page
    .locator(".rt-Card")
    .filter({ hasText: projectTitle })
    .or(page.locator(`xpath=//*[text()="${projectTitle}"]/ancestor::*[.//button][1]`))
    .first();
  await expect(card).toBeVisible();
  // 卡片内第一个按钮即编辑入口（随后是删除）。
  await card.getByRole("button").first().click();

  const dialog = projectFormDialog(page, "Edit Project");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 在对话框里选择类型（Radix Select 的选项渲染在 body 下的 portal 中）。 */
async function selectGenre(page: Page, dialog: Locator, optionLabel: string): Promise<void> {
  await dialog.getByRole("combobox", { name: "Genre" }).click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

test("projects page: failed profile read keeps stored values and sends no profile write", async ({
  page,
}) => {
  const state = createStubState({ profileGetFailuresRemaining: Number.POSITIVE_INFINITY });
  await installStubs(page, state);
  await openProjectsPage(page);

  const dialog = await openEditDialog(page);
  const targetWordCount = dialog.getByPlaceholder("e.g. 300000");

  // 读取失败必须是明确的错误 + 重试，而不是一直禁用的假加载状态。
  await expect(dialog.getByText(/could not be loaded/i).first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry loading" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Genre" })).toBeDisabled();
  await expect(targetWordCount).toBeDisabled();
  // 未读取成功前不显示空值，也不把它当成用户输入。
  await expect(targetWordCount).toHaveValue("");

  await dialog.getByPlaceholder("Enter project title").fill("E2E Alpha renamed");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(dialog).toBeHidden();
  expect(state.projectPatchCount).toBe(1);
  expect(readMultipartField(state.projectPatchBodies[0] ?? null, "title")).toBe(
    "E2E Alpha renamed",
  );
  // 关键断言：没有任何产品属性写入，已保存的类型与预计字数不会被清空覆盖。
  expect(state.profilePutBodies).toHaveLength(0);
});

test("projects page: retry loads stored values, late reads keep edits, intentional edits save once", async ({
  page,
}) => {
  const state = createStubState({
    // 初始读取 + React Query 的自动重试都失败后才进入错误态，随后用户手动重试成功。
    profileGetFailuresRemaining: 2,
    profileGetDelayMs: 500,
  });
  await installStubs(page, state);
  await openProjectsPage(page);

  const dialog = await openEditDialog(page);
  const titleInput = dialog.getByPlaceholder("Enter project title");
  const targetWordCount = dialog.getByPlaceholder("e.g. 300000");

  // 首次读取在途/失败时，标题仍可编辑，且不会被随后到达的读取结果覆盖。
  await titleInput.fill("Edited while profile loads");
  await expect(dialog.getByText(/could not be loaded/i).first()).toBeVisible();

  await dialog.getByRole("button", { name: "Retry loading" }).click();
  await expect(dialog.getByRole("combobox", { name: "Genre" })).toContainText("Fantasy");
  await expect(targetWordCount).toHaveValue(String(SAVED_TARGET_WORD_COUNT));
  await expect(titleInput).toHaveValue("Edited while profile loads");

  // 用户的显式修改只提交一次，并且保留用户意图。
  await targetWordCount.fill("450000");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(dialog).toBeHidden();
  expect(state.profilePutBodies).toHaveLength(1);
  expect(state.profilePutBodies[0]).toMatchObject({
    genre: SAVED_GENRE,
    target_word_count: 450000,
  });
});

test("projects page: repeated submit during a slow profile write creates one project", async ({
  page,
}) => {
  const state = createStubState({ projects: [], profilePutDelayMs: 1200 });
  await installStubs(page, state);
  await openProjectsPage(page);

  await page.getByRole("button", { name: "New Project" }).click();
  const dialog = projectFormDialog(page, "New Project");
  await expect(dialog).toBeVisible();

  const titleInput = dialog.getByPlaceholder("Enter project title");
  await titleInput.fill("Repeated submit");
  await dialog.getByPlaceholder("e.g. 300000").fill("120000");

  const profilePutStarted = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().includes("/profile"),
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  // POST 已完成、产品属性 PUT 仍在途：这正是修复前会二次创建的时间窗。
  await profilePutStarted;

  await titleInput.press("Enter");
  // 提交按钮在整笔事务期间保持禁用；这里用 force click 直接尝试触发重复提交。
  await dialog
    .locator('button[type="submit"]')
    .click({ force: true, timeout: 2000 })
    .catch(() => undefined);

  await expect(dialog).toBeHidden({ timeout: 15000 });
  expect(state.projectPostCount).toBe(1);
  expect(state.profilePutBodies).toHaveLength(1);
});

test("onboarding: repeated submit during a slow profile write creates one project", async ({
  page,
}) => {
  const state = createStubState({ projects: [], profilePutDelayMs: 1200 });
  await installStubs(page, state);
  await page.goto("/");

  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Create a new novel" }).click();

  const dialog = projectFormDialog(page, "New Project");
  await expect(dialog).toBeVisible();

  const titleInput = dialog.getByPlaceholder("Enter project title");
  await titleInput.fill("Onboarding repeat");
  await dialog.getByPlaceholder("e.g. 300000").fill("90000");

  const profilePutStarted = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().includes("/profile"),
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await profilePutStarted;

  await titleInput.press("Enter");
  await dialog
    .locator('button[type="submit"]')
    .click({ force: true, timeout: 2000 })
    .catch(() => undefined);

  await expect.poll(() => state.projectPostCount, { timeout: 15000 }).toBe(1);
  // 给潜在的第二次提交留出足够时间，再确认没有额外创建与额外写入。
  await page.waitForTimeout(1500);
  expect(state.projectPostCount).toBe(1);
  expect(state.profilePutBodies).toHaveLength(1);
});

test("projects page: reopening New Project after a successful create starts empty", async ({
  page,
}) => {
  const state = createStubState({ projects: [] });
  await installStubs(page, state);
  await openProjectsPage(page);

  // 第一次创建：填写非默认的类型与预计字数。
  await page.getByRole("button", { name: "New Project" }).click();
  const firstDialog = projectFormDialog(page, "New Project");
  await expect(firstDialog).toBeVisible();
  await firstDialog.getByPlaceholder("Enter project title").fill("Session Alpha");
  await selectGenre(page, firstDialog, "Fantasy");
  await firstDialog.getByPlaceholder("e.g. 300000").fill(String(SAVED_TARGET_WORD_COUNT));
  await firstDialog.getByRole("button", { name: "Create", exact: true }).click();

  // 保存成功后由父页面直接关闭对话框（setFormDialogOpen(false)），不经过对话框自身的关闭处理。
  await expect(firstDialog).toBeHidden({ timeout: 15000 });
  expect(state.projectPostCount).toBe(1);
  expect(state.profilePutBodies[0]).toMatchObject({
    genre: SAVED_GENRE,
    target_word_count: SAVED_TARGET_WORD_COUNT,
  });

  // 再次新建：必须回到空值，而不是沿用刚刚那个 "create" 会话的类型与预计字数。
  await page.getByRole("button", { name: "New Project" }).click();
  const secondDialog = projectFormDialog(page, "New Project");
  await expect(secondDialog).toBeVisible();
  await expect(secondDialog.getByPlaceholder("Enter project title")).toHaveValue("");
  await expect(secondDialog.getByRole("combobox", { name: "Genre" })).toContainText("Not set");
  await expect(secondDialog.getByPlaceholder("e.g. 300000")).toHaveValue("");

  // 只填标题直接创建：不得把上一个项目的产品属性带过去。
  await secondDialog.getByPlaceholder("Enter project title").fill("Session Beta");
  await secondDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(secondDialog).toBeHidden({ timeout: 15000 });

  expect(state.projectPostCount).toBe(2);
  expect(state.profilePutBodies).toHaveLength(2);
  expect(state.profilePutBodies[1]).toMatchObject({ genre: "", target_word_count: 0 });
});

test("projects page: create, edit and create again keep each form session isolated", async ({
  page,
}) => {
  const state = createStubState({ projects: [] });
  await installStubs(page, state);
  await openProjectsPage(page);

  // 1) 新建：非默认产品属性。
  await page.getByRole("button", { name: "New Project" }).click();
  const createDialog = projectFormDialog(page, "New Project");
  await expect(createDialog).toBeVisible();
  await createDialog.getByPlaceholder("Enter project title").fill("Profile Carrier");
  await selectGenre(page, createDialog, "Science fiction");
  await createDialog.getByPlaceholder("e.g. 300000").fill("150000");
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(createDialog).toBeHidden({ timeout: 15000 });

  // 2) 编辑同一个项目：产品属性来自这次读取的结果，而不是上一个会话的残留。
  const editDialog = await openEditDialog(page, "Profile Carrier");
  await expect(editDialog.getByRole("combobox", { name: "Genre" })).toContainText(
    "Science fiction",
  );
  await expect(editDialog.getByPlaceholder("e.g. 300000")).toHaveValue("150000");
  await editDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(editDialog).toBeHidden();

  // 3) 再新建：必须回到空值，而不是沿用创建或编辑会话里的产品属性。
  await page.getByRole("button", { name: "New Project" }).click();
  const nextCreateDialog = projectFormDialog(page, "New Project");
  await expect(nextCreateDialog).toBeVisible();
  await expect(nextCreateDialog.getByRole("combobox", { name: "Genre" })).toContainText("Not set");
  await expect(nextCreateDialog.getByPlaceholder("e.g. 300000")).toHaveValue("");
  await nextCreateDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(nextCreateDialog).toBeHidden();
});

test("projects page: switching the edited project loads that project's own profile", async ({
  page,
}) => {
  const state = createStubState({
    projects: [
      buildProjectRow("proj-alpha", "Alpha Novel"),
      buildProjectRow("proj-beta", "Beta Novel"),
    ],
    profiles: {
      "proj-alpha": { genre: "fantasy", targetWordCount: 300000 },
      "proj-beta": { genre: "mystery", targetWordCount: 80000 },
    },
  });
  await installStubs(page, state);
  await openProjectsPage(page);

  const alphaDialog = await openEditDialog(page, "Alpha Novel");
  await expect(alphaDialog.getByRole("combobox", { name: "Genre" })).toContainText("Fantasy");
  await expect(alphaDialog.getByPlaceholder("e.g. 300000")).toHaveValue("300000");
  await alphaDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(alphaDialog).toBeHidden();

  // 切换编辑对象：不得残留上一个项目的类型与预计字数，而是重新读取自己的产品属性。
  const betaDialog = await openEditDialog(page, "Beta Novel");
  await expect(betaDialog.getByRole("combobox", { name: "Genre" })).toContainText("Mystery");
  await expect(betaDialog.getByPlaceholder("e.g. 300000")).toHaveValue("80000");
  await betaDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(betaDialog).toBeHidden();
});

test("projects page: reopening before profile refetch finishes uses the saved profile", async ({ page }) => {
  const state = createStubState();
  await installStubs(page, state);
  await openProjectsPage(page);
  const dialog = await openEditDialog(page);
  await expect(dialog.getByPlaceholder("e.g. 300000")).toHaveValue(String(SAVED_TARGET_WORD_COUNT));
  await selectGenre(page, dialog, "Mystery");
  await dialog.getByPlaceholder("e.g. 300000").fill("80000");
  let releaseReads = () => {};
  state.profileGetGate = new Promise<void>((resolve) => { releaseReads = resolve; });
  const readsBeforeSave = state.profileGetCalls;
  try {
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => state.profileGetCalls).toBeGreaterThan(readsBeforeSave);
    const reopened = await openEditDialog(page);
    await expect(reopened.getByRole("combobox", { name: "Genre" })).toContainText("Mystery");
    await expect(reopened.getByPlaceholder("e.g. 300000")).toHaveValue("80000");
    await reopened.getByPlaceholder("Enter project title").fill("E2E Alpha renamed");
    await reopened.getByRole("button", { name: "Save", exact: true }).click();
    await expect(reopened).toBeHidden();
    expect(state.profilePutBodies).toHaveLength(2);
    expect(state.profilePutBodies[1]).toMatchObject({ genre: "mystery", target_word_count: 80000 });
  } finally {
    state.profileGetGate = null;
    releaseReads();
  }
});
