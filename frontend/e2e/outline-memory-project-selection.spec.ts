/**
 * 大纲 / 故事记忆项目选择回归测试
 *
 * 覆盖 outline / story-memory 两个页面共享 useProjectSelection 之后的“当前项目”边界：
 * URL 重入（含变为 null 或无效 id）、列表外 URL 的接口校验与选择器 metadata、
 * 本地记住的偏好（localStorage）与最近项目偏好、无效候选回退、
 * 记住的无效项目校验被拒绝后不得继续回退覆盖手动选择、
 * 项目校验与最近项目读取均被挂起时的迟到响应与手动 ABA、
 * 后台列表刷新、同 id 保留编辑状态（含大纲展开状态）、SPA 离开返回连续性。
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
    name: "outline",
    path: "/outline",
    selectScope: ".outline-page__project-select",
    storageKey: "openfix.outline.projectId",
  },
  {
    name: "story-memory",
    path: "/story-memory",
    selectScope: ".story-memory-page__project-select",
    storageKey: "openfix.storyMemory.projectId",
  },
] as const;

function projectPayload(project: SyntheticProject): Record<string, unknown> {
  return {
    id: project.id,
    title: project.title,
    description: null,
    word_count: 0,
    chapter_count: 1,
    cover_url: null,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

/**
 * 大纲节点载荷：根节点必须带一个子节点，
 * 展开/折叠状态（aria-expanded 与子节点可见性）才是可断言的可见行为。
 */
function outlinePayloads(projectId: string): Record<string, unknown>[] {
  const shared = {
    project_id: projectId,
    volume_id: null,
    chapter_id: null,
    content: "",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
  return [
    {
      ...shared,
      id: `${projectId}-node-1`,
      parent_id: null,
      level: "book",
      title: `${projectId} Root`,
      sort_order: 0,
    },
    {
      ...shared,
      id: `${projectId}-node-2`,
      parent_id: `${projectId}-node-1`,
      level: "chapter",
      title: `${projectId} Child`,
      sort_order: 1,
    },
  ];
}

function storyMemoryStatusPayload(projectId: string): Record<string, unknown> {
  return {
    project_id: projectId,
    embedding_configured: true,
    index_status: "ready",
    last_error: null,
    last_ready_at: TIMESTAMP,
    rebuild_job_status: null,
    counts: { characters: 1, world_entries: 2, outlines: 3, notes: 4, chapters: 5 },
  };
}

interface MockApiOptions {
  /** GET /projects 返回的“第一页”项目 */
  pageOneProjects: SyntheticProject[];
  /** GET /projects/:id 可以解析出的项目（不含则为已删除/无效） */
  resolvableProjects: SyntheticProject[];
  /**
   * 这些项目的 GET /projects/:id 会保持挂起，直到测试调用 releaseProjectRequest。
   * 释放后（含 React Query 的重试请求）立即按 resolvableProjects 判定成功或 404；
   * 项目不必出现在 resolvableProjects 中，因此“已删除项目”的校验请求同样可以被挂起。
   */
  deferredProjects?: SyntheticProject[];
}

interface MockApiState {
  /** 便于单个用例切换第一页内容（例如验证回退不依赖列表顺序） */
  setPageOneProjects: (projects: SyntheticProject[]) => void;
  /** 记录被请求过的单个项目 id，用于证明 URL/候选项目确实经过接口校验 */
  requestedProjectIds: string[];
  projectListRequests: number;
  /**
   * 记录领域接口命中的项目 id（outlines / chapters / story-memory status）。
   * 两个页面共用一个数组，任一领域请求携带无效 id 都会被记录，
   * 使「无效 id 不驱动领域请求」在两个页面目标上都不是空断言。
   */
  domainProjectIds: string[];
  /** 释放被挂起的项目请求：响应此刻才会到达页面 */
  releaseProjectRequest: (projectId: string) => void;
  /** 仍被挂起（响应尚未产生）的项目校验请求 id，用于证明请求确实在途 */
  heldProjectIds: () => string[];
}

async function installApiMock(page: Page, options: MockApiOptions): Promise<MockApiState> {
  const state = {
    pageOneProjects: [...options.pageOneProjects],
    requestedProjectIds: [] as string[],
    domainProjectIds: [] as string[],
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

    const outlinesMatch = apiPath.match(/^\/projects\/([^/]+)\/outlines$/);
    if (outlinesMatch) {
      const projectId = decodeURIComponent(outlinesMatch[1]);
      state.domainProjectIds.push(projectId);
      if (!resolvableById.has(projectId)) {
        await route.fulfill({ status: 404, json: { detail: "Project not found" } });
        return;
      }
      await route.fulfill({
        status: 200,
        json: { items: outlinePayloads(projectId), total: 2 },
      });
      return;
    }

    const chaptersMatch = apiPath.match(/^\/projects\/([^/]+)\/chapters$/);
    if (chaptersMatch) {
      state.domainProjectIds.push(decodeURIComponent(chaptersMatch[1]));
      await route.fulfill({ status: 200, json: { volumes: [], total_chapters: 0 } });
      return;
    }

    const storyMemoryMatch = apiPath.match(/^\/projects\/([^/]+)\/story-memory\/status$/);
    if (storyMemoryMatch) {
      const projectId = decodeURIComponent(storyMemoryMatch[1]);
      state.domainProjectIds.push(projectId);
      if (!resolvableById.has(projectId)) {
        await route.fulfill({ status: 404, json: { detail: "Project not found" } });
        return;
      }
      await route.fulfill({ status: 200, json: storyMemoryStatusPayload(projectId) });
      return;
    }

    const projectMatch = apiPath.match(/^\/projects\/([^/]+)$/);
    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]);
      state.requestedProjectIds.push(projectId);
      if (deferredIds.has(projectId)) {
        await new Promise<void>((resolve) => {
          const waiters = state.deferredResolvers.get(projectId) ?? [];
          waiters.push(resolve);
          state.deferredResolvers.set(projectId, waiters);
        });
      }
      const project = resolvableById.get(projectId);
      if (!project) {
        await route.fulfill({ status: 404, json: { detail: "Project not found" } });
        return;
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
    domainProjectIds: state.domainProjectIds,
    get projectListRequests() {
      return state.projectListRequests;
    },
    releaseProjectRequest: (projectId) => {
      const waiters = state.deferredResolvers.get(projectId) ?? [];
      state.deferredResolvers.delete(projectId);
      // 释放后不再挂起该项目的后续请求（例如 React Query 的重试）。
      deferredIds.delete(projectId);
      waiters.forEach((resolve) => resolve());
    },
    heldProjectIds: () =>
      [...state.deferredResolvers.entries()]
        .filter(([, waiters]) => waiters.length > 0)
        .map(([projectId]) => projectId),
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

/** 页面里的项目选择器（两个页面都用 Radix Select 承载当前项目） */
function projectSelectTrigger(page: Page, scope: string) {
  return page.locator(`${scope} [role="combobox"]`).first();
}

/** 在页面里预置本地记住的项目（localStorage 偏好），模拟上次已选中的项目 */
async function seedStoredProject(page: Page, storageKey: string, projectId: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: storageKey, value: projectId },
  );
}

/** 读取页面当前的本地偏好值 */
async function readStoredProject(page: Page, storageKey: string): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), storageKey);
}

/**
 * 通过应用自身的 local-db 写入最近项目，避免在测试里伪造 IndexedDB schema。
 * 模块路径以参数传入，确保浏览器端动态解析而不是被测试 tsconfig 静态解析。
 */
async function seedRecentProject(
  page: Page,
  modulePath: string,
  project: SyntheticProject,
): Promise<void> {
  await page.evaluate(
    async ({ path, projectId, projectTitle }) => {
      const module = (await import(path)) as {
        openRecentProject: (projectId: string, title: string) => Promise<unknown>;
      };
      await module.openRecentProject(projectId, projectTitle);
    },
    { path: modulePath, projectId: project.id, projectTitle: project.title },
  );
}

const LOCAL_DB_MODULE = "/src/lib/local-db.ts";

interface RecentReadGate {
  /** 释放后真正回调完成的读取次数（pending 为仍被挂起的真实读取） */
  settledCount: number;
  pending: Array<() => void>;
  release: () => void;
}

/**
 * 在页面里安装可挂起的 IndexedDB 门闩：命中指定 object store 的真实读取
 * （getAll / openCursor 两条 Dexie 查询路径都覆盖）会被推迟 success 回调，直到测试调用 release()。
 * 只按 object store 名字匹配，不牵连其它表；仅存在于测试侧，不引入任何生产代码钩子。
 */
async function installRecentReadGate(page: Page, heldStoreName: string): Promise<void> {
  await page.addInitScript((storeName: string) => {
    let holding = true;
    const gate: RecentReadGate = {
      settledCount: 0,
      pending: [],
      release: () => {
        holding = false;
        gate.pending.splice(0).forEach((settle) => settle());
      },
    };

    // 记录读取并推迟它的 success 回调：只有「读取已真正完成」且「测试已释放」时才回调。
    const holdRequest = (request: IDBRequest<unknown>): void => {
      let handler: ((event: Event) => void) | null = null;
      let completed = false;
      let released = false;
      const finish = () => {
        if (!released || !completed || !handler) return;
        const settledHandler = handler;
        handler = null;
        // 先还原原生 onsuccess，避免释放后游标续跑代码里的重新赋值被再次立即触发。
        Reflect.deleteProperty(request, "onsuccess");
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
    };

    const patch = (source: IDBObjectStore | IDBIndex, method: "getAll" | "openCursor"): void => {
      const original: unknown = Object.getOwnPropertyDescriptor(source, method)?.value;
      if (typeof original !== "function") return;
      Object.defineProperty(source, method, {
        configurable: true,
        writable: true,
        value: function (this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
          const request = Reflect.apply(original, this, args) as IDBRequest<unknown>;
          const owner = this instanceof IDBIndex ? this.objectStore.name : this.name;
          if (holding && owner === storeName) holdRequest(request);
          return request;
        },
      });
    };

    patch(IDBObjectStore.prototype, "getAll");
    patch(IDBObjectStore.prototype, "openCursor");
    patch(IDBIndex.prototype, "getAll");
    patch(IDBIndex.prototype, "openCursor");

    (window as unknown as { __recentReadGate: RecentReadGate }).__recentReadGate = gate;
  }, heldStoreName);
}

/** 门闩观测值；未安装时返回 0，让断言失败而不是静默通过 */
async function recentReadGateCount(page: Page, field: "pending" | "settledCount"): Promise<number> {
  return page.evaluate((key) => {
    const gate = (window as unknown as { __recentReadGate?: RecentReadGate }).__recentReadGate;
    if (!gate) return 0;
    return key === "pending" ? gate.pending.length : gate.settledCount;
  }, field);
}

/**
 * 等待并确认真实读取仍被挂起：既用于等到应用真的发起读取，
 * 也用于证明后续断言发生在读取完成之前（真实计数握手，不用固定等待）。
 */
async function expectHeldRecentReadPending(page: Page): Promise<void> {
  await expect.poll(() => recentReadGateCount(page, "pending")).toBeGreaterThan(0);
}

/** 释放门闩，并等待被挂起的读取确实完成了 success 回调 */
async function releaseHeldRecentRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __recentReadGate: RecentReadGate }).__recentReadGate.release();
  });
  await expect.poll(() => recentReadGateCount(page, "settledCount")).toBeGreaterThan(0);
}

/**
 * 进入目标页面，并停在「真实 recentProjects 读取被挂起」的状态：
 * 先在尚未安装门闩的文档里用应用自身的 local-db 写入最近项目（种子写入不会被挂起），
 * 再安装门闩并导航到全新文档，确保这次读取必然经过门闩而不是命中已预热的查询。
 */
async function openPageWithHeldRecents(
  page: Page,
  target: (typeof PAGES)[number],
  query = "",
): Promise<{ api: MockApiState; trigger: ReturnType<typeof projectSelectTrigger> }> {
  const api = await installApiMock(page, {
    pageOneProjects: [ALPHA, BETA],
    resolvableProjects: [ALPHA, BETA, OFF_PAGE],
  });
  await mockSocketIo(page);
  await page.goto("/projects");
  await seedRecentProject(page, LOCAL_DB_MODULE, OFF_PAGE);
  await installRecentReadGate(page, "recentProjects");
  await page.goto(`${target.path}${query}`);
  await expectHeldRecentReadPending(page);
  return { api, trigger: projectSelectTrigger(page, target.selectScope) };
}

/** 通过选择器完成一次用户手动选择，并确认触发器已经显示该项目 */
async function selectProjectFromChooser(
  page: Page,
  scope: string,
  project: SyntheticProject,
): Promise<void> {
  await projectSelectTrigger(page, scope).click();
  await page.getByRole("option", { name: project.title, exact: true }).click();
  await expect(projectSelectTrigger(page, scope)).toContainText(project.title);
}

/** 打开选择器面板并断言某个项目确实作为选项存在，然后关闭面板 */
async function expectChooserContains(page: Page, scope: string, project: SyntheticProject) {
  await projectSelectTrigger(page, scope).click();
  await expect(page.getByRole("option", { name: project.title, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
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

for (const target of PAGES) {
  test.describe(`${target.name} 项目选择边界`, () => {
    test("URL 项目应用后手动改选，再经无 projectId 导航回到同一 URL 时必须重新应用", async ({
      page,
    }) => {
      await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${ALPHA.id}`);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(ALPHA.title, {
        timeout: 30000,
      });

      // 手动改选 BETA 后，同一导航周期内的重渲染不得把它拉回 URL 项目。
      await selectProjectFromChooser(page, target.selectScope, BETA);
      await settleUi(page);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(BETA.title);

      // A -> null：保留手动选择。
      await changeUrlInApp(page, target.path, 1);
      await settleUi(page);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(BETA.title);

      // null -> A：新的导航周期必须重新应用 URL 上的 A。
      await changeUrlInApp(page, `${target.path}?projectId=${ALPHA.id}`, 2);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(ALPHA.title);
      await settleUi(page);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(ALPHA.title);
    });

    test("URL 项目应用后手动改选，再经无效 URL 回到原 URL 时必须重新应用", async ({ page }) => {
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${ALPHA.id}`);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(ALPHA.title, {
        timeout: 30000,
      });

      await selectProjectFromChooser(page, target.selectScope, BETA);

      // 无效 URL：校验失败后保留手动选择。
      await changeUrlInApp(page, `${target.path}?projectId=${MISSING.id}`, 1);
      await expect.poll(() => api.requestedProjectIds.includes(MISSING.id)).toBe(true);
      await settleUi(page);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(BETA.title);
      // 无效 URL 不得进入任何领域请求；BETA 的领域请求证明记录器在本页确实生效。
      await expect.poll(() => api.domainProjectIds.includes(BETA.id)).toBe(true);
      expect(api.domainProjectIds).not.toContain(MISSING.id);

      // 回到原 URL：新的导航周期必须重新应用 A。
      await changeUrlInApp(page, `${target.path}?projectId=${ALPHA.id}`, 2);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(ALPHA.title);
      await settleUi(page);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(ALPHA.title);
    });

    test("列表外 URL 项目经接口校验后选中并出现在选择器中", async ({ page }) => {
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${OFF_PAGE.id}`);

      const trigger = projectSelectTrigger(page, target.selectScope);
      await expect(trigger).toContainText(OFF_PAGE.title, { timeout: 30000 });
      expect(api.requestedProjectIds).toContain(OFF_PAGE.id);

      await expectChooserContains(page, target.selectScope, OFF_PAGE);
      await settleUi(page);
      await expect(trigger).toContainText(OFF_PAGE.title);
    });

    test("无效 URL 回退到本地记住的列表外项目且不产生未捕获异常", async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
      });
      await mockSocketIo(page);
      await seedStoredProject(page, target.storageKey, OFF_PAGE.id);

      await page.goto(`${target.path}?projectId=${MISSING.id}`);

      const trigger = projectSelectTrigger(page, target.selectScope);
      await expect(trigger).toContainText(OFF_PAGE.title, { timeout: 30000 });
      expect(api.requestedProjectIds).toContain(MISSING.id);
      expect(api.requestedProjectIds).toContain(OFF_PAGE.id);
      // 无效 URL 不得驱动领域请求；OFF_PAGE 的领域请求证明记录器在本页确实生效。
      await expect.poll(() => api.domainProjectIds.includes(OFF_PAGE.id)).toBe(true);
      expect(api.domainProjectIds).not.toContain(MISSING.id);

      await settleUi(page);
      await expect(trigger).toContainText(OFF_PAGE.title);
      expect(pageErrors).toEqual([]);
    });

    test("已删除的记住项目不得永久污染选择，回退到第一页并改写本地偏好", async ({ page }) => {
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
      });
      await mockSocketIo(page);
      await seedStoredProject(page, target.storageKey, MISSING.id);

      await page.goto(target.path);

      const trigger = projectSelectTrigger(page, target.selectScope);
      await expect(trigger).toContainText(ALPHA.title, { timeout: 30000 });
      expect(api.requestedProjectIds).toContain(MISSING.id);
      // 无效的记住项目同样不得驱动领域请求；ALPHA 的领域请求证明记录器在本页确实生效。
      await expect.poll(() => api.domainProjectIds.includes(ALPHA.id)).toBe(true);
      expect(api.domainProjectIds).not.toContain(MISSING.id);
      // 无效偏好不得留在本地。
      await expect.poll(() => readStoredProject(page, target.storageKey)).toBe(ALPHA.id);

      await settleUi(page);
      await expect(trigger).toContainText(ALPHA.title);
    });

    test("最近项目中的列表外项目经接口校验后恢复", async ({ page }) => {
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
      });
      await mockSocketIo(page);

      // 先进入应用一次，用应用自身的 local-db 写入最近项目。
      await page.goto("/projects");
      await seedRecentProject(page, LOCAL_DB_MODULE, OFF_PAGE);

      await page.goto(target.path);

      const trigger = projectSelectTrigger(page, target.selectScope);
      await expect(trigger).toContainText(OFF_PAGE.title, { timeout: 30000 });
      expect(api.requestedProjectIds).toContain(OFF_PAGE.id);
      await expectChooserContains(page, target.selectScope, OFF_PAGE);
    });

    test("最近项目读取挂起时 URL 选择生效且不被迟到结果覆盖", async ({ page }) => {
      const { api, trigger } = await openPageWithHeldRecents(page, target, `?projectId=${ALPHA.id}`);

      // 真实读取仍挂起（preference 未就绪）时，URL 项目已经生效。
      await expect(trigger).toContainText(ALPHA.title, { timeout: 30000 });
      await expectHeldRecentReadPending(page);
      // 释放读取：迟到的最近项目（列表外的 OFF_PAGE）既不得改选，也不得被校验请求。
      await releaseHeldRecentRead(page);
      await settleUi(page);
      await expect(trigger).toContainText(ALPHA.title);
      expect(api.requestedProjectIds).not.toContain(OFF_PAGE.id);
    });

    test("最近项目读取挂起时手动 A -> B -> A 不被释放结果覆盖", async ({ page }) => {
      const { api, trigger } = await openPageWithHeldRecents(page, target);

      await selectProjectFromChooser(page, target.selectScope, ALPHA);
      await selectProjectFromChooser(page, target.selectScope, BETA);
      await selectProjectFromChooser(page, target.selectScope, ALPHA);
      await expectHeldRecentReadPending(page);
      await releaseHeldRecentRead(page);
      await settleUi(page);
      await expect(trigger).toContainText(ALPHA.title);
      expect(api.requestedProjectIds).not.toContain(OFF_PAGE.id);
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
      const trigger = projectSelectTrigger(page, target.selectScope);
      await expect(trigger).toContainText(ALPHA.title, { timeout: 30000 });

      // 客户端导航到离页项目 X：校验请求保持挂起。
      await changeUrlInApp(page, `${target.path}?projectId=${OFF_PAGE.id}`, 1);
      await expect.poll(() => api.requestedProjectIds.includes(OFF_PAGE.id)).toBe(true);

      // 请求挂起期间用户手动 A -> B -> A。
      await selectProjectFromChooser(page, target.selectScope, BETA);
      await selectProjectFromChooser(page, target.selectScope, ALPHA);

      // 释放迟到的 X 响应：以“X 出现在选择器中”作为响应已被处理的握手。
      api.releaseProjectRequest(OFF_PAGE.id);
      await expectChooserContains(page, target.selectScope, OFF_PAGE);

      await settleUi(page);
      await expect(trigger).toContainText(ALPHA.title);
    });

    test("等待离页 URL 时手动选择后，后台列表刷新不能恢复旧 URL 选择", async ({ page }) => {
      await page.clock.install();
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
        deferredProjects: [OFF_PAGE],
      });
      await mockSocketIo(page);

      await page.goto(target.path);
      const trigger = projectSelectTrigger(page, target.selectScope);
      await expect(trigger).toContainText(ALPHA.title);

      await changeUrlInApp(page, `${target.path}?projectId=${OFF_PAGE.id}`, 1);
      await expect.poll(() => api.requestedProjectIds.includes(OFF_PAGE.id)).toBe(true);
      await selectProjectFromChooser(page, target.selectScope, BETA);

      const readsBeforeRefetch = api.projectListRequests;
      const addedProject: SyntheticProject = { id: "proj-refetched", title: "Refetched Project" };
      api.setPageOneProjects([ALPHA, BETA, addedProject]);
      await page.clock.fastForward(61_000);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
        window.dispatchEvent(new Event("online"));
      });
      await expect.poll(() => api.projectListRequests).toBeGreaterThan(readsBeforeRefetch);
      await expectChooserContains(page, target.selectScope, addedProject);

      const response = page.waitForResponse((result) =>
        new URL(result.url()).pathname.endsWith(`/projects/${OFF_PAGE.id}`),
      );
      api.releaseProjectRequest(OFF_PAGE.id);
      await response;
      await settleUi(page);
      await expect(trigger).toContainText(BETA.title);
    });

    test("离页项目在无 URL 与无效 URL 下都保留，SPA 离开返回后继续显示", async ({ page }) => {
      const api = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA, OFF_PAGE],
      });
      await mockSocketIo(page);

      await page.goto(`${target.path}?projectId=${OFF_PAGE.id}`);
      const trigger = projectSelectTrigger(page, target.selectScope);
      await expect(trigger).toContainText(OFF_PAGE.title, { timeout: 30000 });

      // SPA 离开：选择器消失。
      await changeUrlInApp(page, "/projects", 1);
      await expect(projectSelectTrigger(page, target.selectScope)).toHaveCount(0);

      // 返回且不带 URL：必须经接口从本地偏好恢复列表外项目及其选择器 metadata。
      await changeUrlInApp(page, target.path, 2);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(OFF_PAGE.title);
      await expectChooserContains(page, target.selectScope, OFF_PAGE);

      // 无效 URL 不得清掉当前离页选择，也不得进入任何领域请求。
      await changeUrlInApp(page, `${target.path}?projectId=${MISSING.id}`, 3);
      await expect.poll(() => api.requestedProjectIds.includes(MISSING.id)).toBe(true);
      await settleUi(page);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(OFF_PAGE.title);
      await expect.poll(() => api.domainProjectIds.includes(OFF_PAGE.id)).toBe(true);
      expect(api.domainProjectIds).not.toContain(MISSING.id);
    });

    test("记住的无效项目校验被拒绝后，不得继续回退覆盖手动选择", async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      // 已删除项目的校验请求：分别等待首次响应与其重试响应真正到达页面。
      const isMissingProjectRequest = (result: { url(): string }) =>
        new URL(result.url()).pathname.endsWith(`/projects/${MISSING.id}`);

      // 场景一：唯一候选（本地记住的已删除项目）校验失败后的第一页回退。
      const fallbackApi = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
        deferredProjects: [MISSING],
      });
      await mockSocketIo(page);
      await seedStoredProject(page, target.storageKey, MISSING.id);

      await page.goto(target.path);
      // 真实握手：校验请求仍在挂起，404 响应尚未产生。
      await expect.poll(() => fallbackApi.heldProjectIds()).toContain(MISSING.id);

      // 请求在途期间用户手动选择 BETA。
      await selectProjectFromChooser(page, target.selectScope, BETA);

      // 释放 404：React Query 会重试一次，两次响应都必须真正到达页面。
      const firstMissingResponse = page.waitForResponse(isMissingProjectRequest);
      fallbackApi.releaseProjectRequest(MISSING.id);
      await firstMissingResponse;
      const retriedMissingResponse = page.waitForResponse(isMissingProjectRequest);
      await retriedMissingResponse;
      await settleUi(page);

      // 候选耗尽后不得落到第一页回退（此处回退目标是 ALPHA），
      // 也不得丢弃手动选择、本地偏好与已选项目的领域上下文。
      expect(fallbackApi.requestedProjectIds.filter((id) => id === MISSING.id)).toHaveLength(2);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(BETA.title);
      await expect.poll(() => readStoredProject(page, target.storageKey)).toBe(BETA.id);
      await expect.poll(() => fallbackApi.domainProjectIds.includes(BETA.id)).toBe(true);
      expect(fallbackApi.domainProjectIds).not.toContain(MISSING.id);
      expect(fallbackApi.domainProjectIds).not.toContain(ALPHA.id);

      // 场景二：拒绝后仍有列表内的后续候选（最近项目 ALPHA）可供回退。
      // 本地记住的项目仍是已删除的 MISSING：seedStoredProject 的初始化脚本在每次导航时重写该 key。
      await page.unroute("**/api/v1/**");
      const listedApi = await installApiMock(page, {
        pageOneProjects: [ALPHA, BETA],
        resolvableProjects: [ALPHA, BETA],
        deferredProjects: [MISSING],
      });
      await page.goto("/projects");
      await seedRecentProject(page, LOCAL_DB_MODULE, ALPHA);

      await page.goto(target.path);
      await expect.poll(() => listedApi.heldProjectIds()).toContain(MISSING.id);

      // 请求在途期间用户手动 BETA -> ALPHA -> BETA：最终选择与后续候选 ALPHA 不同。
      await selectProjectFromChooser(page, target.selectScope, BETA);
      await selectProjectFromChooser(page, target.selectScope, ALPHA);
      await selectProjectFromChooser(page, target.selectScope, BETA);

      const listedFirstResponse = page.waitForResponse(isMissingProjectRequest);
      listedApi.releaseProjectRequest(MISSING.id);
      await listedFirstResponse;
      const listedRetryResponse = page.waitForResponse(isMissingProjectRequest);
      await listedRetryResponse;
      await settleUi(page);

      // 拒绝后不得继续消费列表内的后续候选，也不得丢弃最后一次手动选择。
      expect(listedApi.requestedProjectIds.filter((id) => id === MISSING.id)).toHaveLength(2);
      await expect(projectSelectTrigger(page, target.selectScope)).toContainText(BETA.title);
      await expect.poll(() => readStoredProject(page, target.storageKey)).toBe(BETA.id);
      await expect.poll(() => listedApi.domainProjectIds.includes(BETA.id)).toBe(true);
      expect(listedApi.domainProjectIds).not.toContain(MISSING.id);
      expect(pageErrors).toEqual([]);
    });
  });
}

/** 大纲树中带子节点节点的展开/折叠按钮（aria-expanded 反映展开状态） */
function outlineNodeExpander(page: Page, title: string) {
  return page.locator(".outline-tree__row", { hasText: title }).locator(".outline-tree__expander");
}

test.describe("outline 编辑器状态", () => {
  test("只有真正切换项目才清空节点选中、草稿与展开状态，同 id 选择保留编辑内容", async ({
    page,
  }) => {
    await installApiMock(page, {
      pageOneProjects: [ALPHA, BETA],
      resolvableProjects: [ALPHA, BETA],
    });
    await mockSocketIo(page);

    const scope = ".outline-page__project-select";
    const trigger = projectSelectTrigger(page, scope);
    await page.goto(`/outline?projectId=${ALPHA.id}`);
    await expect(trigger).toContainText(ALPHA.title, { timeout: 30000 });

    // 选中节点并制造未保存草稿。
    const alphaNode = page.locator(".outline-tree__label", { hasText: `${ALPHA.id} Root` });
    await expect(alphaNode).toBeVisible({ timeout: 30000 });
    await alphaNode.click();
    const editorTitle = page.locator(".outline-editor input").first();
    await expect(editorTitle).toHaveValue(`${ALPHA.id} Root`);
    await editorTitle.fill(`${ALPHA.id} Root draft`);
    await expect(editorTitle).toHaveValue(`${ALPHA.id} Root draft`);

    // 展开根节点：只有展开时才渲染子节点，使展开状态成为可断言的可见行为。
    const alphaExpander = outlineNodeExpander(page, `${ALPHA.id} Root`);
    const alphaChild = page.locator(".outline-tree__label", { hasText: `${ALPHA.id} Child` });
    await expect(alphaExpander).toHaveAttribute("aria-expanded", "false");
    await expect(alphaChild).toBeHidden();
    await alphaExpander.click();
    await expect(alphaExpander).toHaveAttribute("aria-expanded", "true");
    await expect(alphaChild).toBeVisible();

    // 重复选择当前项目不得清空编辑器，也不得折叠已展开的节点。
    await selectProjectFromChooser(page, scope, ALPHA);
    await settleUi(page);
    await expect(editorTitle).toHaveValue(`${ALPHA.id} Root draft`);
    await expect(alphaExpander).toHaveAttribute("aria-expanded", "true");
    await expect(alphaChild).toBeVisible();

    // 同一 URL 重新应用（A -> null -> A）仍保留节点选中、草稿与展开状态。
    await changeUrlInApp(page, "/outline", 1);
    await settleUi(page);
    await expect(editorTitle).toHaveValue(`${ALPHA.id} Root draft`);
    await changeUrlInApp(page, `/outline?projectId=${ALPHA.id}`, 2);
    await settleUi(page);
    await expect(editorTitle).toHaveValue(`${ALPHA.id} Root draft`);
    await expect(alphaExpander).toHaveAttribute("aria-expanded", "true");
    await expect(alphaChild).toBeVisible();

    // 真正切换项目：节点选中、草稿与展开状态按既有语义被清空，并加载新项目的大纲。
    await changeUrlInApp(page, `/outline?projectId=${BETA.id}`, 3);
    await expect(page.getByRole("alertdialog")).toContainText("放弃未保存的修改？");
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(trigger).toContainText(BETA.title);
    await expect(page.locator(".outline-editor")).toHaveCount(0);
    await expect(
      page.locator(".outline-tree__label", { hasText: `${BETA.id} Root` }),
    ).toBeVisible();

    // 回到 A（B -> A）：A 之前的展开状态与草稿/选中同样不得复活。
    await changeUrlInApp(page, `/outline?projectId=${ALPHA.id}`, 4);
    await expect(trigger).toContainText(ALPHA.title);
    await expect(
      page.locator(".outline-tree__label", { hasText: `${ALPHA.id} Root` }),
    ).toBeVisible();
    await expect(alphaExpander).toHaveAttribute("aria-expanded", "false");
    await expect(alphaChild).toBeHidden();
    await expect(page.locator(".outline-editor")).toHaveCount(0);
  });

  test("搜索会展开匹配路径，层级选择只显示符合父子结构的选项", async ({ page }) => {
    await installApiMock(page, {
      pageOneProjects: [ALPHA],
      resolvableProjects: [ALPHA],
    });
    let nodes = outlinePayloads(ALPHA.id);
    await page.route(`**/api/v1/projects/${ALPHA.id}/outlines`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, json: { items: nodes, total: nodes.length } });
        return;
      }
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON() as {
          level: string;
          title: string;
          content?: string;
          parent_id: string | null;
        };
        const created = {
          ...nodes[0],
          id: `${ALPHA.id}-node-3`,
          parent_id: payload.parent_id,
          level: payload.level,
          title: payload.title,
          content: payload.content ?? "",
          sort_order: nodes.filter((node) => node.parent_id === payload.parent_id).length + 1,
        };
        nodes = [...nodes, created];
        await route.fulfill({ status: 201, json: created });
        return;
      }
      await route.fallback();
    });
    await mockSocketIo(page);

    await page.goto(`/outline?projectId=${ALPHA.id}`);
    await expect(projectSelectTrigger(page, ".outline-page__project-select")).toContainText(
      ALPHA.title,
      { timeout: 30000 },
    );

    await expect(page.locator(".outline-page__tree-help")).toContainText("点击节点编辑");
    const search = page.locator(".outline-page__search input");
    await search.fill(`${ALPHA.id} Child`);
    await expect(
      page.locator(".outline-tree__label", { hasText: `${ALPHA.id} Child` }),
    ).toBeVisible();
    await expect(page.locator(".outline-page__tree-heading")).toContainText("显示 2 / 2");

    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    const rootLabel = page.locator(".outline-tree__label", { hasText: `${ALPHA.id} Root` });
    await rootLabel.click();
    await expect(page.locator(".outline-tree__row").filter({ has: rootLabel })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page.locator(".outline-editor [aria-label='层级']").click();
    await expect(page.getByRole("option", { name: "篇章" })).toBeVisible();
    await expect(page.getByRole("option", { name: "卷" })).toBeVisible();
    await expect(page.getByRole("option", { name: "章", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await search.fill(`${ALPHA.id} Child`);
    const rootRow = page.locator(".outline-tree__row").filter({
      hasText: `${ALPHA.id} Root`,
    });
    await rootRow.getByRole("button", { name: "新建子节点", exact: true }).click();
    await expect(search).toHaveValue("");
    await expect(page.locator(".outline-tree__label", { hasText: "篇章" })).toBeVisible();
    await expect(page.locator(".outline-editor input").first()).toBeFocused();
  });

  test("新建子节点后切回全书节点不会重复渲染 AI 操作栏", async ({ page }) => {
    await installApiMock(page, {
      pageOneProjects: [ALPHA],
      resolvableProjects: [ALPHA],
    });
    let nodes = [outlinePayloads(ALPHA.id)[0]];
    await page.route(`**/api/v1/projects/${ALPHA.id}/outlines`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, json: { items: nodes, total: nodes.length } });
        return;
      }
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON() as {
          level: string;
          title: string;
          content?: string;
          parent_id: string | null;
        };
        const created = {
          ...nodes[0],
          id: `${ALPHA.id}-child-1`,
          parent_id: payload.parent_id,
          level: payload.level,
          title: payload.title,
          content: payload.content ?? "",
          sort_order: 1,
        };
        nodes = [...nodes, created];
        await route.fulfill({ status: 201, json: created });
        return;
      }
      await route.fallback();
    });
    await mockSocketIo(page);

    await page.goto(`/outline?projectId=${ALPHA.id}`);
    await expect(projectSelectTrigger(page, ".outline-page__project-select")).toContainText(
      ALPHA.title,
      { timeout: 30000 },
    );

    const rootRow = page.locator(".outline-tree__row").filter({ hasText: `${ALPHA.id} Root` });
    await rootRow.getByRole("button", { name: "新建子节点", exact: true }).click();
    await expect(page.locator(".outline-tree__label", { hasText: "篇章" })).toBeVisible();
    await expect(page.locator(".outline-page__editor .outline-ai")).toHaveCount(1);

    await rootRow.locator(".outline-tree__label").click();
    const aiActions = page.locator(".outline-page__editor .outline-ai");
    await expect(aiActions).toHaveCount(1);
    await expect(aiActions.getByRole("button", { name: "AI 完善大纲", exact: true })).toHaveCount(1);
    await expect(aiActions.getByText("请先选择一个卷节点再拆分章节。", { exact: true }))
      .toHaveCount(1);
  });

  test("编辑器可直接新增同级节点，并用回车从标题进入内容", async ({ page }) => {
    await installApiMock(page, {
      pageOneProjects: [ALPHA],
      resolvableProjects: [ALPHA],
    });
    let nodes = outlinePayloads(ALPHA.id);
    let createdPayload: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/projects/${ALPHA.id}/outlines`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, json: { items: nodes, total: nodes.length } });
        return;
      }
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON() as {
          level: string;
          title: string;
          content?: string;
          parent_id: string | null;
        };
        createdPayload = payload;
        const created = {
          ...nodes[0],
          id: `${ALPHA.id}-node-3`,
          parent_id: payload.parent_id,
          level: payload.level,
          title: payload.title,
          content: payload.content ?? "",
          sort_order: nodes.filter((node) => node.parent_id === payload.parent_id).length + 1,
        };
        nodes = [...nodes, created];
        await route.fulfill({ status: 201, json: created });
        return;
      }
      await route.fallback();
    });
    await mockSocketIo(page);

    await page.goto(`/outline?projectId=${ALPHA.id}`);
    await expect(projectSelectTrigger(page, ".outline-page__project-select")).toContainText(
      ALPHA.title,
      { timeout: 30000 },
    );
    const root = page.locator(".outline-tree__row").filter({ hasText: `${ALPHA.id} Root` });
    await root.locator(".outline-tree__expander").click();
    await page.locator(".outline-tree__label", { hasText: `${ALPHA.id} Child` }).click();
    await expect(page.locator(".outline-ai")).toHaveCount(1);
    const deleteButton = page.getByRole("button", { name: "删除", exact: true });
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();
    await expect(page.getByRole("alertdialog")).toContainText(`${ALPHA.id} Child`);
    await page.getByRole("button", { name: "取消", exact: true }).click();

    await page.getByRole("button", { name: "新增同级", exact: true }).click();
    const title = page.locator(".outline-editor input").first();
    const content = page.locator(".outline-editor textarea").first();
    await expect(title).toBeFocused();
    expect(createdPayload).toMatchObject({
      level: "chapter",
      parent_id: `${ALPHA.id}-node-1`,
    });

    await title.fill("下一章");
    await title.press("Enter");
    await expect(content).toBeFocused();
  });

  test("空大纲提供明确的新建入口与分层说明", async ({ page }) => {
    await installApiMock(page, {
      pageOneProjects: [ALPHA],
      resolvableProjects: [ALPHA],
    });
    await page.route(`**/api/v1/projects/${ALPHA.id}/outlines`, async (route) => {
      await route.fulfill({ status: 200, json: { items: [], total: 0 } });
    });
    await mockSocketIo(page);

    await page.goto(`/outline?projectId=${ALPHA.id}`);
    await expect(projectSelectTrigger(page, ".outline-page__project-select")).toContainText(
      ALPHA.title,
      { timeout: 30000 },
    );
    await expect(page.locator(".outline-tree__empty-copy")).toContainText(
      "从清晰的故事骨架开始",
    );
    await expect(page.locator(".outline-tree__empty-copy")).toContainText(
      "先建全书大纲",
    );
    await expect(
      page.locator(".outline-tree__empty").getByRole("button", {
        name: "新建全书大纲",
        exact: true,
      }),
    ).toBeVisible();
  });
});
