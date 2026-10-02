/**
 * 项目选择深层链接回归测试
 *
 * 覆盖 characters / world-info 两个页面的“当前项目”初始化边界：
 * URL 项目不在第一页、缓存偏好晚于 URL 返回、URL 变更、应用后手动选择、
 * 无效/已删除 URL 回退。
 *
 * 本文件完全使用合成接口与 WebSocket 拦截，不依赖真实后端或真实模型提供商。
 */

import { expect, test, type Page } from "@playwright/test";

interface SyntheticProject {
  id: string;
  title: string;
}

const ALPHA: SyntheticProject = { id: "proj-alpha", title: "Alpha Project" };
const BETA: SyntheticProject = { id: "proj-beta", title: "Beta Project" };
const OFF_PAGE: SyntheticProject = { id: "proj-off-page", title: "Off Page Project" };
const MISSING: SyntheticProject = { id: "proj-missing", title: "Missing Project" };

const TIMESTAMP = "2026-01-01T00:00:00Z";

const PAGES = [
  {
    name: "characters",
    path: "/characters",
    selectScope: ".characters-list-project-select",
    preferenceKey: "characters.lastProjectId",
    storeModule: "/src/features/characters/store/use-characters-store.ts",
    storeExport: "useCharactersStore",
    selectionKey: "currentCharacterId",
  },
  {
    name: "world-info",
    path: "/world-info",
    selectScope: ".world-info-page-sidebar--left",
    preferenceKey: "worldInfo.lastProjectId",
    storeModule: "/src/features/world-info/store/use-world-info-store.ts",
    storeExport: "useWorldInfoStore",
    selectionKey: "currentEntryId",
  },
] as const;

function projectPayload(project: SyntheticProject): Record<string, unknown> {
  return {
    id: project.id,
    title: project.title,
    description: null,
    word_count: 0,
    chapter_count: 0,
    cover_url: null,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

interface MockApiOptions {
  /** GET /projects 返回的“第一页”项目 */
  pageOneProjects: SyntheticProject[];
  /** GET /projects/:id 可以解析出的项目（不含则为已删除/无效） */
  resolvableProjects: SyntheticProject[];
  /** 这些项目的 GET /projects/:id 会保持挂起，直到测试调用 releaseProjectRequest */
  deferredProjects?: SyntheticProject[];
  withSelectionItems?: boolean;
  selectionProject?: SyntheticProject;
}

interface MockApiState {
  /** 便于单个用例切换第一页内容（例如验证回退不依赖列表顺序） */
  setPageOneProjects: (projects: SyntheticProject[]) => void;
  /** 记录被请求过的单个项目 id，用于证明 URL 项目确实经过接口校验 */
  requestedProjectIds: string[];
  projectListRequests: number;
  /** 释放被挂起的项目请求：响应此刻才会到达页面 */
  releaseProjectRequest: (projectId: string) => void;
}

async function installApiMock(page: Page, options: MockApiOptions): Promise<MockApiState> {
  const state = {
    pageOneProjects: [...options.pageOneProjects],
    requestedProjectIds: [] as string[],
    projectListRequests: 0,
    deferredResolvers: new Map<string, Array<() => void>>(),
  };
  const resolvableById = new Map(options.resolvableProjects.map((project) => [project.id, project]));
  const deferredIds = new Set((options.deferredProjects ?? []).map((project) => project.id));

  await page.route("**/runtime-config.json", (route) => route.fulfill({ status: 404, body: "" }));

  await page.route("**/api/v1/**", async (route) => {
    const apiPath = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, "");

    if (apiPath === "/auth/status") {
      await route.fulfill({ status: 200, json: { enabled: false, authenticated: true } });
      return;
    }
    if (apiPath === "/auth/preferences") {
      await route.fulfill({
        status: 200,
        json: {
          language: "zh-CN",
          theme: "light",
          font_family: "noto-sans-sc",
          code_font_family: "jetbrains-mono",
          base_font_size: 14,
          editor_font_size: 16,
        },
      });
      return;
    }
    if (apiPath === "/health") {
      await route.fulfill({ status: 200, json: { status: "ok", version: "test" } });
      return;
    }
    if (apiPath === "/settings") {
      await route.fulfill({
        status: 200,
        json: {
          language: "zh-CN",
          theme: "light",
          font_family: "noto-sans-sc",
          code_font_family: "jetbrains-mono",
          base_font_size: 14,
          editor_font_size: 16,
        },
      });
      return;
    }
    if (apiPath === "/runtime-config") {
      await route.fulfill({
        status: 200,
        json: { posthog_enabled: false, posthog_api_key: "", posthog_host: "" },
      });
      return;
    }
    if (apiPath === "/projects") {
      state.projectListRequests += 1;
      await route.fulfill({
        status: 200,
        json: {
          items: state.pageOneProjects.map(projectPayload),
          total: state.pageOneProjects.length,
          page: 1,
          page_size: 100,
        },
      });
      return;
    }

    const charactersMatch = apiPath.match(/^\/projects\/([^/]+)\/characters$/);
    if (charactersMatch) {
      const items = options.withSelectionItems ? [{ id: "selected-item", project_id: charactersMatch[1], name: "Synthetic Selected Item", description: "Synthetic fixture", image_url: null, token_count: 1, is_favorited: false, created_at: TIMESTAMP, updated_at: TIMESTAMP }] : [];
      await route.fulfill({ status: 200, json: { items, total: items.length } });
      return;
    }

    const tasksMatch = apiPath.match(/^\/projects\/([^/]+)\/tasks$/);
    if (tasksMatch) {
      await route.fulfill({ status: 200, json: { items: [] } });
      return;
    }

    const worldInfoMatch = apiPath.match(/^\/projects\/([^/]+)\/world-info$/);
    if (worldInfoMatch) {
      await route.fulfill({
        status: 200,
        json: {
          id: `wi-${worldInfoMatch[1]}`,
          project_id: worldInfoMatch[1],
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
        },
      });
      return;
    }

    const entriesMatch = apiPath.match(/^\/world-info\/([^/]+)\/entries$/);
    if (entriesMatch) {
      const items = options.withSelectionItems ? [{ id: "selected-item", world_info_id: entriesMatch[1], uid: 1, name: "Synthetic Selected Item", order: 0, content: "Synthetic fixture", token_count: 1, is_enabled: true, created_at: TIMESTAMP, updated_at: TIMESTAMP }] : [];
      await route.fulfill({ status: 200, json: { items, total: items.length } });
      return;
    }

    if (options.withSelectionItems && apiPath === "/characters/selected-item") {
      await route.fulfill({ status: 200, json: { id: "selected-item", project_id: (options.selectionProject ?? ALPHA).id, name: "Synthetic Selected Item", description: "Synthetic fixture", image_url: null, is_favorited: false, created_at: TIMESTAMP, updated_at: TIMESTAMP } });
      return;
    }
    if (options.withSelectionItems && apiPath === "/world-info-entries/selected-item") {
      await route.fulfill({ status: 200, json: { id: "selected-item", world_info_id: `wi-${(options.selectionProject ?? ALPHA).id}`, uid: 1, name: "Synthetic Selected Item", order: 0, content: "Synthetic fixture", token_count: 1, is_enabled: true, created_at: TIMESTAMP, updated_at: TIMESTAMP } });
      return;
    }

    const projectMatch = apiPath.match(/^\/projects\/([^/]+)$/);
    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]);
      state.requestedProjectIds.push(projectId);
      const project = resolvableById.get(projectId);
      if (!project) {
        await route.fulfill({ status: 404, json: { detail: "Project not found" } });
        return;
      }
      if (deferredIds.has(projectId)) {
        await new Promise<void>((resolve) => {
          const waiters = state.deferredResolvers.get(projectId) ?? [];
          waiters.push(resolve);
          state.deferredResolvers.set(projectId, waiters);
        });
      }
      await route.fulfill({ status: 200, json: projectPayload(project) });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: "Not mocked" } });
  });

  return {
    setPageOneProjects: (projects) => {
      state.pageOneProjects = [...projects];
    },
    requestedProjectIds: state.requestedProjectIds,
    get projectListRequests() { return state.projectListRequests; },
    releaseProjectRequest: (projectId) => {
      const waiters = state.deferredResolvers.get(projectId) ?? [];
      state.deferredResolvers.delete(projectId);
      waiters.forEach((resolve) => resolve());
    },
  };
}

/**
 * Socket.IO 连接是应用初始化的一部分，这里同时拦截 WebSocket 与长轮询。
 */
async function mockSocketIo(page: Page): Promise<void> {
  const engineOpen = `0{"sid":"mock-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}`;

  await page.routeWebSocket(/\/socket\.io\//, (webSocket) => {
    webSocket.onMessage((message) => {
      const payload = typeof message === "string" ? message : message.toString("utf8");
      if (payload === "2") {
        webSocket.send("3");
        return;
      }
      if (payload.startsWith("40")) {
        webSocket.send(`40{"sid":"mock-namespace"}`);
      }
    });
    webSocket.send(engineOpen);
  });

  // 兜底：WebSocket 未被拦截时，Engine.IO 会退回 HTTP 长轮询。
  let namespaceConnected = false;
  await page.route(/\/socket\.io\//, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 200, contentType: "text/html", body: "ok" });
      return;
    }

    const hasSession = new URL(route.request().url()).searchParams.has("sid");
    if (!hasSession) {
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=UTF-8",
        body: engineOpen,
      });
      return;
    }

    if (!namespaceConnected) {
      namespaceConnected = true;
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=UTF-8",
        body: `40{"sid":"mock-namespace"}`,
      });
      return;
    }

    // 保持长轮询：等待一个 ping 周期后再下发服务端 ping，避免空转。
    try {
      await new Promise((resolve) => setTimeout(resolve, 20000));
      await route.fulfill({ status: 200, contentType: "text/plain; charset=UTF-8", body: "2" });
    } catch {
      // 页面在长轮询挂起期间关闭时忽略。
    }
  });
}

function projectSelectInput(page: Page, scope: string) {
  return page
    .locator(`${scope} .project-select-field__trigger input, ${scope} input.project-select-field__input`)
    .first();
}

async function readPreference(page: Page, key: string): Promise<string | null> {
  return page.evaluate(async (preferenceKey) => {
    return await new Promise<string | null>((resolve) => {
      const request = indexedDB.open("OpenFicDB");
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("userPreferences")) {
          resolve(null);
          return;
        }
        const getRequest = db
          .transaction("userPreferences", "readonly")
          .objectStore("userPreferences")
          .get(preferenceKey);
        getRequest.onsuccess = () =>
          resolve((getRequest.result as { value?: string } | undefined)?.value ?? null);
        getRequest.onerror = () => resolve(null);
      };
    });
  }, key);
}

/**
 * 只改变 URL（不刷新页面），模拟应用内深层链接导航。
 * 追加的 history state 保持与 react-router 一致的形状，确保 popstate 被正常处理。
 */
async function changeUrlInApp(page: Page, nextUrl: string, historyIndex: number): Promise<void> {
  await page.evaluate(
    ({ url, idx }) => {
      window.history.pushState({ idx, key: `e2e-${idx}`, usr: null }, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    { url: nextUrl, idx: historyIndex },
  );
}

/**
 * 等待 React 提交完成：两个 rAF 加一个宏任务，足以覆盖 React 调度器，
 * 避免用固定 wall-time 等待来判断“没有发生回写”。
 */
async function settleUi(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(), 0)));
      }),
  );
}

/** 通过选择器完成一次用户手动选择，并确认输入框已经显示该项目 */
async function selectProjectFromChooser(
  page: Page,
  scope: string,
  project: SyntheticProject,
): Promise<void> {
  const input = projectSelectInput(page, scope);
  await input.click();
  await page.locator(".project-grid-selector__card").filter({ hasText: project.title }).click();
  await expect(input).toHaveValue(project.title);
}

interface PreferenceReadGate {
  pending: Array<() => void>;
  settledCount: number;
  release: () => void;
}

/**
 * 在页面里安装可挂起的 IndexedDB 偏好读取门闩：
 * 命中指定 key 的 objectStore.get 会被推迟 onsuccess 回调，直到测试调用 release()。
 * 仅存在于测试侧，不引入任何生产代码钩子。
 */
async function installPreferenceReadGate(page: Page, preferenceKey: string): Promise<void> {
  await page.addInitScript((holdKey: string) => {
    const gate: PreferenceReadGate & { holdKeys: string[] } = {
      holdKeys: [holdKey],
      pending: [],
      settledCount: 0,
      release: () => {
        gate.holdKeys.length = 0;
        const pending = gate.pending.splice(0);
        pending.forEach((release) => release());
      },
    };

    const originalGet: unknown = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "get")?.value;
    if (typeof originalGet !== "function") throw new Error("IndexedDB get method is unavailable");
    IDBObjectStore.prototype.get = function (
      this: IDBObjectStore,
      query: IDBValidKey | IDBKeyRange,
    ): IDBRequest<unknown> {
      const request = Reflect.apply(originalGet, this, [query]) as IDBRequest<unknown>;
      if (typeof query !== "string" || !gate.holdKeys.includes(query)) return request;

      let handler: ((event: Event) => void) | null = null;
      let completed = false;
      let released = false;
      const finish = () => {
        if (!released || !completed || !handler) return;
        const settledHandler = handler;
        handler = null;
        gate.settledCount += 1;
        settledHandler.call(request, { target: request } as unknown as Event);
      };

      request.addEventListener("success", () => {
        completed = true;
        finish();
      });
      Object.defineProperty(request, "onsuccess", {
        configurable: true,
        get: () => handler,
        set: (next: ((event: Event) => void) | null) => {
          handler = next;
          finish();
        },
      });
      gate.pending.push(() => {
        released = true;
        finish();
      });
      return request;
    };

    (window as unknown as { __prefReadGate: typeof gate }).__prefReadGate = gate;
  }, preferenceKey);
}

/** 等待 hook 真的发起偏好读取并处于挂起状态（可观测握手，不依赖固定等待） */
async function waitForHeldPreferenceRead(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const gate = (window as unknown as { __prefReadGate?: PreferenceReadGate }).__prefReadGate;
    return Boolean(gate && gate.pending.length > 0);
  });
}

/** 释放门闩，并等待被挂起的读取确实完成（settledCount 由门闩自己计数） */
async function releaseHeldPreferenceRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __prefReadGate: PreferenceReadGate }).__prefReadGate.release();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __prefReadGate?: PreferenceReadGate }).__prefReadGate
            ?.settledCount ?? 0,
      ),
    )
    .toBeGreaterThan(0);
}

for (const target of PAGES) {
  test.describe(`${target.name} 项目选择边界`, () => {
    test("URL 项目不在第一页时经接口校验后选中并显示在选择器中", async ({ page }) => {
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${OFF_PAGE.id}`);

      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(OFF_PAGE.title, { timeout: 30000 });
      expect(api.requestedProjectIds).toContain(OFF_PAGE.id);

      await input.click();
      await expect(
        page.locator(".project-grid-selector__card").filter({ hasText: OFF_PAGE.title }),
      ).toBeVisible();
    });

    for (const navigation of ["missing-parameter", "invalid-project"] as const) {
      test(`离页项目经 ${navigation} 导航后保留名称、选择器选项与实际选择`, async ({ page }) => {
        const api = await installApiMock(page, {
          pageOneProjects: [ALPHA, BETA],
          resolvableProjects: [ALPHA, BETA, OFF_PAGE],
        });
        await mockSocketIo(page);
        await page.goto(`${target.path}?projectId=${OFF_PAGE.id}`);
        const input = projectSelectInput(page, target.selectScope);
        await expect(input).toHaveValue(OFF_PAGE.title, { timeout: 30000 });

        const destination = navigation === "invalid-project"
          ? `${target.path}?projectId=${MISSING.id}`
          : target.path;
        await changeUrlInApp(page, destination, 1);
        if (navigation === "invalid-project") {
          await expect.poll(() => api.requestedProjectIds.includes(MISSING.id)).toBe(true);
        }
        await settleUi(page);
        await expect(input).toHaveValue(OFF_PAGE.title);
        const selectedProjectId = await page.evaluate(async ({ storeModule, storeExport }) => {
          const module = await import(storeModule) as Record<string, {
            getState: () => { currentProjectId: string | null };
          }>;
          return module[storeExport].getState().currentProjectId;
        }, { storeModule: target.storeModule, storeExport: target.storeExport });
        expect(selectedProjectId).toBe(OFF_PAGE.id);
        await input.click();
        await expect(
          page.locator(".project-grid-selector__card").filter({ hasText: OFF_PAGE.title }),
        ).toBeVisible();
        await page.keyboard.press("Escape");

        // 改选后，旧离页项目不再作为当前选择保留在 chooser 中。
        await selectProjectFromChooser(page, target.selectScope, ALPHA);
        await input.click();
        await expect(
          page.locator(".project-grid-selector__card").filter({ hasText: OFF_PAGE.title }),
        ).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(input).toHaveValue(ALPHA.title);
      });
    }

    test("离页项目在 SPA 离开再返回后恢复名称和选项且保留实际选择", async ({ page }) => {
      await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
        withSelectionItems: true,
        selectionProject: OFF_PAGE,
      });
      await mockSocketIo(page);
      await page.goto(`${target.path}?projectId=${OFF_PAGE.id}`);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(OFF_PAGE.title, { timeout: 30000 });
      await page.getByText("Synthetic Selected Item", { exact: true }).first().click();

      await changeUrlInApp(page, "/projects", 1);
      await expect(input).toHaveCount(0);
      await changeUrlInApp(page, target.path, 2);
      await expect(input).toHaveValue(OFF_PAGE.title);
      const selection = await page.evaluate(async ({ storeModule, storeExport, selectionKey }) => {
        const module = await import(storeModule) as Record<string, {
          getState: () => Record<string, unknown>;
        }>;
        const state = module[storeExport].getState();
        return { projectId: state.currentProjectId, selectedItemId: state[selectionKey] };
      }, { storeModule: target.storeModule, storeExport: target.storeExport, selectionKey: target.selectionKey });
      expect(selection).toEqual({ projectId: OFF_PAGE.id, selectedItemId: "selected-item" });
      await input.click();
      await expect(
        page.locator(".project-grid-selector__card").filter({ hasText: OFF_PAGE.title }),
      ).toBeVisible();
    });

    test("缓存偏好晚于 URL 返回时不得覆盖 URL 选中的项目", async ({ page }) => {
      await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
      });
      await mockSocketIo(page);

      // 第一次访问不带 URL：自动选中第一项并写入本地缓存。
      await page.goto(target.path);
      await expect(projectSelectInput(page, target.selectScope)).toHaveValue(ALPHA.title, {
        timeout: 30000,
      });
      await expect.poll(() => readPreference(page, target.preferenceKey)).toBe(ALPHA.id);

      // 第二次带 URL 访问：缓存偏好在 URL 之后异步返回，也必须让 URL 项目胜出。
      await page.goto(`${target.path}?projectId=${BETA.id}`);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(BETA.title, { timeout: 30000 });

      await settleUi(page);
      await expect(input).toHaveValue(BETA.title);
    });

    test("同一页面内 URL 变更时应用新的 URL 项目", async ({ page }) => {
      await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${ALPHA.id}`);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(ALPHA.title, { timeout: 30000 });

      await changeUrlInApp(page, `${target.path}?projectId=${OFF_PAGE.id}`, 1);
      await expect(input).toHaveValue(OFF_PAGE.title);

      await changeUrlInApp(page, `${target.path}?projectId=${BETA.id}`, 2);
      await expect(input).toHaveValue(BETA.title);

      await settleUi(page);
      await expect(input).toHaveValue(BETA.title);
    });

    test("URL 项目已应用后手动选择不被回写覆盖", async ({ page }) => {
      await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${OFF_PAGE.id}`);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(OFF_PAGE.title, { timeout: 30000 });

      await input.click();
      await page
        .locator(".project-grid-selector__card")
        .filter({ hasText: ALPHA.title })
        .click();
      await expect(input).toHaveValue(ALPHA.title);

      await settleUi(page);
      await expect(input).toHaveValue(ALPHA.title);
    });

    test("无效或已删除的 URL 项目回退到本地缓存且不产生未捕获异常", async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
      });
      await mockSocketIo(page);

      // 第一次访问建立缓存偏好 ALPHA。
      await page.goto(target.path);
      await expect(projectSelectInput(page, target.selectScope)).toHaveValue(ALPHA.title, {
        timeout: 30000,
      });
      await expect.poll(() => readPreference(page, target.preferenceKey)).toBe(ALPHA.id);

      // 第二次让第一页以 BETA 开头，回退必须来自缓存而不是列表顺序。
      api.setPageOneProjects([BETA, ALPHA]);
      await page.goto(`${target.path}?projectId=${MISSING.id}`);

      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(ALPHA.title, { timeout: 30000 });
      expect(api.requestedProjectIds).toContain(MISSING.id);

      await settleUi(page);
      await expect(input).toHaveValue(ALPHA.title);
      expect(pageErrors).toEqual([]);
    });

    test("无 URL 且偏好读取挂起时，客户端导航选中 B 后迟到的偏好不得回写", async ({ page }) => {
      await installPreferenceReadGate(page, target.preferenceKey);
      await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
      });
      await mockSocketIo(page);

      // 首次进入无 URL：回退逻辑发起偏好读取，并被门闩挂起。
      await page.goto(target.path);
      await waitForHeldPreferenceRead(page);

      // 读取仍挂起时在应用内导航到 URL 项目 B。
      await changeUrlInApp(page, `${target.path}?projectId=${BETA.id}`, 1);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(BETA.title);

      // 释放迟到的偏好读取：其结果不得覆盖 URL 选中的 B。
      await releaseHeldPreferenceRead(page);
      await settleUi(page);
      await expect(input).toHaveValue(BETA.title);
      await expect.poll(() => readPreference(page, target.preferenceKey)).toBe(BETA.id);
    });

    test("URL 项目应用后手动改选，再经无 projectId 导航回到同一 URL 时必须重新应用", async ({
      page,
    }) => {
      await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${ALPHA.id}`);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(ALPHA.title, { timeout: 30000 });

      // 手动改选 BETA，并确认同一导航周期内的重渲染不会把它拉回 URL 项目。
      await selectProjectFromChooser(page, target.selectScope, BETA);
      await settleUi(page);
      await expect(input).toHaveValue(BETA.title);

      // A -> null：保留手动选择。
      await changeUrlInApp(page, target.path, 1);
      await settleUi(page);
      await expect(input).toHaveValue(BETA.title);

      // null -> A：新的导航周期必须重新应用 URL 上的 A。
      await changeUrlInApp(page, `${target.path}?projectId=${ALPHA.id}`, 2);
      await expect(input).toHaveValue(ALPHA.title);
      await settleUi(page);
      await expect(input).toHaveValue(ALPHA.title);
    });

    test("URL 项目应用后手动改选，再经无效 URL 回到原 URL 时必须重新应用", async ({ page }) => {
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${ALPHA.id}`);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(ALPHA.title, { timeout: 30000 });

      await selectProjectFromChooser(page, target.selectScope, BETA);

      // 无效 URL：校验失败后保留手动选择。
      await changeUrlInApp(page, `${target.path}?projectId=${MISSING.id}`, 1);
      await expect.poll(() => api.requestedProjectIds.includes(MISSING.id)).toBe(true);
      await settleUi(page);
      await expect(input).toHaveValue(BETA.title);

      // 回到原 URL：新的导航周期必须重新应用 A。
      await changeUrlInApp(page, `${target.path}?projectId=${ALPHA.id}`, 2);
      await expect(input).toHaveValue(ALPHA.title);
      await settleUi(page);
      await expect(input).toHaveValue(ALPHA.title);
    });

    test("离页项目校验挂起期间手动 A -> B -> A，迟到的响应不得覆盖", async ({ page }) => {
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
        deferredProjects: [OFF_PAGE],
      });
      await mockSocketIo(page);

      // 无 URL 进入：回退选中 A。
      await page.goto(target.path);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(ALPHA.title, { timeout: 30000 });

      // 客户端导航到离页项目 X：校验请求保持挂起。
      await changeUrlInApp(page, `${target.path}?projectId=${OFF_PAGE.id}`, 1);
      await expect.poll(() => api.requestedProjectIds.includes(OFF_PAGE.id)).toBe(true);

      // 请求挂起期间用户手动 A -> B -> A。
      await selectProjectFromChooser(page, target.selectScope, BETA);
      await selectProjectFromChooser(page, target.selectScope, ALPHA);

      // 释放迟到的 X 响应：以“X 出现在选择器列表”作为响应已被处理的握手。
      api.releaseProjectRequest(OFF_PAGE.id);
      await input.click();
      await expect(
        page.locator(".project-grid-selector__card").filter({ hasText: OFF_PAGE.title }),
      ).toBeVisible();
      await page.keyboard.press("Escape");

      await settleUi(page);
      await expect(input).toHaveValue(ALPHA.title);
    });

    test("等待 URL 项目时手动选择后，后台列表刷新不能恢复旧 URL 选择", async ({ page }) => {
      await page.clock.install();
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
        deferredProjects: [OFF_PAGE],
      });
      await mockSocketIo(page);
      await page.goto(target.path);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(ALPHA.title);
      await changeUrlInApp(page, `${target.path}?projectId=${OFF_PAGE.id}`, 1);
      await expect.poll(() => api.requestedProjectIds.includes(OFF_PAGE.id)).toBe(true);
      await selectProjectFromChooser(page, target.selectScope, BETA);
      const readsBeforeRefetch = api.projectListRequests;
      const addedProject = { id: "proj-refetched", title: "Refetched Project" };
      api.setPageOneProjects([ALPHA, BETA, addedProject]);
      await page.clock.fastForward(61_000);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("online"));
      });
      await expect.poll(() => api.projectListRequests).toBeGreaterThan(readsBeforeRefetch);
      await input.click();
      await expect(page.locator(".project-grid-selector__card").filter({ hasText: addedProject.title })).toBeVisible();
      await page.keyboard.press("Escape");
      const response = page.waitForResponse((result) => new URL(result.url()).pathname.endsWith(`/projects/${OFF_PAGE.id}`));
      api.releaseProjectRequest(OFF_PAGE.id);
      await response;
      await settleUi(page);
      await expect(input).toHaveValue(BETA.title);
    });

    test("重复选择当前项目保留当前角色或条目", async ({ page }) => {
      await installApiMock(page, { pageOneProjects: [ALPHA], resolvableProjects: [ALPHA], withSelectionItems: true });
      await mockSocketIo(page);
      await page.goto(`${target.path}?projectId=${ALPHA.id}`);
      const input = projectSelectInput(page, target.selectScope);
      await expect(input).toHaveValue(ALPHA.title);
      await page.getByText("Synthetic Selected Item", { exact: true }).first().click();
      const readSelection = () => page.evaluate(async ({ storeModule, storeExport, selectionKey }) => {
        const module = await import(storeModule) as Record<string, { getState: () => Record<string, unknown> }>;
        return module[storeExport].getState()[selectionKey];
      }, { storeModule: target.storeModule, storeExport: target.storeExport, selectionKey: target.selectionKey });
      await expect.poll(readSelection).toBe("selected-item");
      await page.evaluate(async ({ storeModule, storeExport, selectionKey }) => {
        const module = await import(storeModule) as Record<string, {
          subscribe: (listener: (state: Record<string, unknown>) => void) => () => void;
        }>;
        const changes: unknown[] = [];
        const unsubscribe = module[storeExport].subscribe((state) => { changes.push(state[selectionKey]); });
        (window as unknown as { __selectionTrace: { changes: unknown[]; unsubscribe: () => void } }).__selectionTrace = { changes, unsubscribe };
      }, { storeModule: target.storeModule, storeExport: target.storeExport, selectionKey: target.selectionKey });
      await selectProjectFromChooser(page, target.selectScope, ALPHA);
      await settleUi(page);
      await expect.poll(readSelection).toBe("selected-item");
      const transitions = await page.evaluate(() => {
        const trace = (window as unknown as { __selectionTrace: { changes: unknown[]; unsubscribe: () => void } }).__selectionTrace;
        trace.unsubscribe();
        return trace.changes;
      });
      expect(transitions).not.toContain(null);
    });
  });
}
