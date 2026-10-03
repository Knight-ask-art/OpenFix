/** Actual Consistency / AI pages with synthetic HTTP, Socket.IO and local preferences. */
import { expect, test, type Page } from "@playwright/test";

import type { ConsistencyCheckResult } from "../src/features/consistency/lib/consistency-api";

test.use({
  serviceWorkers: "block", trace: "off", video: "off", screenshot: "off",
  viewport: { width: 1440, height: 1000 },
});

interface SyntheticProject { id: string; title: string }
const ALPHA: SyntheticProject = { id: "selection-alpha", title: "Alpha Novel" };
const BETA: SyntheticProject = { id: "selection-beta", title: "Beta Novel" };
const OFF_PAGE: SyntheticProject = { id: "selection-off-page", title: "Off Page Novel" };
const MISSING: SyntheticProject = { id: "selection-missing", title: "Missing Novel" };
const PROJECTS = [ALPHA, BETA, OFF_PAGE];
const TIMESTAMP = "2026-10-03T08:00:00Z";
const PAGES = [
  { name: "consistency", path: "/consistency", chooser: ".consistency-page__header", key: "openfix.consistency.projectId" },
  { name: "ai", path: "/ai", chooser: ".ai-tasks-page__project-select", key: "openfix.ai.projectId" },
] as const;
type TargetPage = (typeof PAGES)[number];

function projectPayload(project: SyntheticProject) {
  return {
    ...project, description: null, word_count: 0, chapter_count: 1, cover_url: null,
    created_at: TIMESTAMP, updated_at: TIMESTAMP,
  };
}

function chapterTree(projectId: string) {
  const volumeId = `${projectId}-volume`;
  return {
    volumes: [{
      id: volumeId, project_id: projectId, title: `${projectId} Volume`, order: 1,
      description: null, chapter_count: 1, created_at: TIMESTAMP, updated_at: TIMESTAMP,
      chapters: [{
        id: `${projectId}-chapter`, project_id: projectId, volume_id: volumeId,
        title: `${projectId} Chapter`, order: 1, word_count: 0,
        created_at: TIMESTAMP, updated_at: TIMESTAMP,
      }],
    }],
    total_chapters: 1,
  };
}

function projectIndex(project: SyntheticProject) {
  return {
    project_id: project.id, title: project.title, enabled: false, status: "disabled",
    total_chapters: 1, indexed_count: 0, pending_count: 0, in_progress_count: 0,
    failed_count: 0, empty_content_count: 0, last_error: null, progress: 0,
  };
}

interface AppState {
  metadataRequests: string[];
  metadataResponses: string[];
  domainProjectIds: string[];
  assistantProjectIds: string[];
  socketProjectIds: string[];
  checks: string[];
  unexpectedRequests: string[];
  unexpectedSocketEvents: string[];
  pageErrors: string[];
  heldIds: () => string[];
  release: (projectId: string) => void;
}

const appStates = new WeakMap<Page, AppState>();

interface MetadataTransportRecord { sequence: number; projectId: string; completed: boolean }

/** Observe only synthetic metadata GET completion; native transport and response bodies are untouched. */
async function installMetadataObserver(page: Page) {
  await page.addInitScript((projectIds: string[]) => {
    const records: MetadataTransportRecord[] = [];
    const syntheticIds = new Set(projectIds);
    const opened = new WeakMap<XMLHttpRequest, string>();
    const prototype = XMLHttpRequest.prototype;
    const nativeOpen: unknown = Object.getOwnPropertyDescriptor(prototype, "open")?.value;
    const nativeSend: unknown = Object.getOwnPropertyDescriptor(prototype, "send")?.value;
    if (typeof nativeOpen !== "function" || typeof nativeSend !== "function") {
      throw new Error("Native XHR methods are unavailable");
    }
    Object.defineProperty(prototype, "open", {
      configurable: true, writable: true,
      value: function (this: XMLHttpRequest, ...args: unknown[]) {
        opened.delete(this);
        if (typeof args[0] === "string" && args[0].toUpperCase() === "GET") {
          const match = new URL(String(args[1]), window.location.href).pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
          if (match && syntheticIds.has(match[1])) opened.set(this, match[1]);
        }
        return Reflect.apply(nativeOpen, this, args);
      },
    });
    Object.defineProperty(prototype, "send", {
      configurable: true, writable: true,
      value: function (this: XMLHttpRequest, ...args: unknown[]) {
        const projectId = opened.get(this);
        if (projectId) {
          const record: MetadataTransportRecord = { sequence: records.length + 1, projectId, completed: false };
          records.push(record);
          this.addEventListener("loadend", () => { record.completed = true; }, { once: true });
        }
        return Reflect.apply(nativeSend, this, args);
      },
    });
    (window as unknown as { __selectionMetadataTransport: MetadataTransportRecord[] }).__selectionMetadataTransport = records;
  }, [...PROJECTS, MISSING].map((project) => project.id));
}

async function waitMetadataCompletion(page: Page, projectId: string, count: number) {
  await expect.poll(() => page.evaluate(({ projectId }) => {
    const records = (window as unknown as { __selectionMetadataTransport: MetadataTransportRecord[] }).__selectionMetadataTransport;
    return records.filter((record) => record.projectId === projectId && record.completed).length;
  }, { projectId })).toBeGreaterThanOrEqual(count);
  await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
  await settleUi(page);
}

async function installApp(page: Page, deferredIds: string[] = []): Promise<AppState> {
  await installMetadataObserver(page);
  const holding = new Set(deferredIds);
  const waiters = new Map<string, Array<() => void>>();
  const state: AppState = {
    metadataRequests: [], metadataResponses: [], domainProjectIds: [], assistantProjectIds: [], socketProjectIds: [],
    checks: [], unexpectedRequests: [], unexpectedSocketEvents: [], pageErrors: [],
    heldIds: () => [...waiters.keys()],
    release: (id) => {
      holding.delete(id);
      waiters.get(id)?.forEach((resolve) => resolve());
      waiters.delete(id);
    },
  };
  appStates.set(page, state);
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  const preferences = {
    language: "en", theme: "light", theme_preset: "default", font_family: "system-ui",
    code_font_family: "ui-monospace", base_font_size: 14, editor_font_size: 16,
  };
  await page.route("**/runtime-config.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route(/https?:\/\/[^/]*(posthog|sentry)\.[^/]+\//, async (route) => {
    state.unexpectedRequests.push(`telemetry ${route.request().url()}`);
    await route.abort();
  });
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
      if (path === "/settings") return json({
        ...preferences, default_model: "", light_model: "", summary_model: "",
        default_embedding_model: "", index_mode: "off", index_enabled_projects: [],
        agent_tool_permissions: [], agent_bypass_tool_approval: false,
        summary_auto_generate_chapter: false, summary_auto_generate_long_term: false,
        telemetry_enabled: false, audit_persist_details: false,
      });
      if (path === "/settings/agent-session-lock") return json({ is_locked: false });
      if (path === "/models" || path === "/model-providers") return json([]);
      if (path === "/agent-definitions") return json({ definitions: [] });
      if (path === "/retrieval/index/status") return json({
        mode: "off", embedding_model_configured: false, total_projects: 3, total_chapters: 3,
        indexed_count: 0, pending_count: 0, in_progress_count: 0, failed_count: 0,
        projects: PROJECTS.map(projectIndex),
      });
      if (path === "/projects") return json({
        items: [ALPHA, BETA].map(projectPayload), total: 101, page: 1, page_size: 100,
      });
      const metadata = path.match(/^\/projects\/([^/]+)$/);
      if (metadata && [...PROJECTS, MISSING].some((project) => project.id === metadata[1])) {
        const id = metadata[1];
        state.metadataRequests.push(id);
        if (holding.has(id)) await new Promise<void>((resolve) => {
          const pending = waiters.get(id) ?? [];
          pending.push(resolve);
          waiters.set(id, pending);
        });
        const project = PROJECTS.find((item) => item.id === id);
        await json(project ? projectPayload(project) : { detail: "Synthetic project missing" }, project ? 200 : 404);
        state.metadataResponses.push(id);
        return;
      }
      const domain = path.match(/^\/projects\/([^/]+)\/(chapters|tasks|retrieval\/index\/status)$/);
      if (domain) {
        const project = PROJECTS.find((item) => item.id === domain[1]);
        state.domainProjectIds.push(domain[1]);
        if (project) {
          if (domain[2] === "chapters") return json(chapterTree(project.id));
          if (domain[2] === "tasks") {
            state.assistantProjectIds.push(project.id);
            return json({ items: [], total: 0 });
          }
          return json(projectIndex(project));
        }
      }
    }
    const check = path.match(/^\/projects\/([^/]+)\/consistency\/check$/);
    if (method === "POST" && check && PROJECTS.some((project) => project.id === check[1])) {
      const raw: unknown = request.postDataJSON();
      const id = check[1];
      const expected = { scope: "chapter", chapter_id: `${id}-chapter`, volume_id: null };
      expect(raw).toEqual(expected);
      state.checks.push(id);
      const result: ConsistencyCheckResult = {
        ...expected, scope: "chapter", label: "Synthetic selection", chapter_count: 1,
        model: "synthetic", context_source: "inventory", issues: [{
          type: "general", severity: "info", message: `selection-result-${id}`,
          evidence: [], suggestion: "", sources: [],
        }],
      };
      return json(result);
    }
    state.unexpectedRequests.push(`${method} ${path}`);
    return json({ detail: "Unexpected synthetic request" }, 501);
  });

  const engineOpen = '0{"sid":"selection-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
  const packets: string[] = [];
  const receive = (packet: string, send: (reply: string) => void) => {
    if (packet.startsWith("40")) { send('40{"sid":"selection-namespace"}'); return; }
    if (packet === "2") { send("3"); return; }
    if (packet === "3" || packet === "41") return;
    let values: unknown = null;
    try { if (packet.startsWith("42")) values = JSON.parse(packet.slice(2)); } catch { /* Recorded below. */ }
    if (Array.isArray(values) && values.length === 2) {
      const [event, payload] = values as unknown[];
      const id = payload && typeof payload === "object" && "project_id" in payload ? payload.project_id : null;
      if (
        (event === "background:join" || event === "background:leave") &&
        typeof id === "string" && PROJECTS.some((project) => project.id === id) &&
        Object.keys(payload as object).length === 1
      ) {
        if (event === "background:join") {
          state.socketProjectIds.push(id);
          send(`42${JSON.stringify(["background:joined", { project_id: id }])}`);
          send(`42${JSON.stringify(["background:snapshot", {
            project_id: id, project_revision: 1, summary: { statuses: [], maintenance: {} },
          }])}`);
        }
        return;
      }
    }
    state.unexpectedSocketEvents.push(packet);
  };
  await page.routeWebSocket(/\/socket\.io\//, (route) => {
    let answered = false;
    route.onMessage((message) => {
      answered = true;
      receive(typeof message === "string" ? message : message.toString(), (reply) => route.send(reply));
    });
    route.send(engineOpen);
    setTimeout(() => { if (!answered) { try { route.send(engineOpen); } catch { /* Closed page. */ } } }, 300);
  });
  await page.route(/\/socket\.io\//, async (route) => {
    if (route.request().method() === "POST") {
      for (const packet of (route.request().postData() ?? "").split("\x1e")) receive(packet, (reply) => packets.push(reply));
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
      return;
    }
    if (route.request().method() !== "GET") state.unexpectedSocketEvents.push(route.request().method());
    if (!new URL(route.request().url()).searchParams.has("sid")) {
      await route.fulfill({ status: 200, contentType: "text/plain", body: engineOpen });
      return;
    }
    if (packets.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ status: 200, contentType: "text/plain", body: packets.splice(0).join("\x1e") || "2" });
  });
  return state;
}

async function settleUi(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }));
}

test.afterEach(async ({ page }) => {
  const state = appStates.get(page);
  if (!state) return;
  await settleUi(page);
  expect(state.unexpectedRequests).toEqual([]);
  expect(state.unexpectedSocketEvents).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

function chooser(page: Page, target: TargetPage) {
  return page.locator(`${target.chooser} [role="combobox"]`).first();
}

async function chooseProject(page: Page, target: TargetPage, project: SyntheticProject) {
  await chooser(page, target).click();
  await page.getByRole("option", { name: project.title, exact: true }).click();
  await expect(chooser(page, target)).toContainText(project.title);
}

async function expectOption(page: Page, target: TargetPage, project: SyntheticProject) {
  await chooser(page, target).click();
  await expect(page.getByRole("option", { name: project.title, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

async function navigateInApp(page: Page, url: string, idx: number) {
  await page.evaluate(({ url, idx }) => {
    window.history.pushState({ idx, key: `selection-${idx}`, usr: null }, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, { url, idx });
  await settleUi(page);
}

async function seedStored(page: Page, target: TargetPage, project: SyntheticProject) {
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), { key: target.key, id: project.id });
}

async function seedRecent(page: Page, project: SyntheticProject) {
  await page.goto("/projects");
  await page.evaluate(async ({ path, project }) => {
    const module = await import(path) as {
      openRecentProject: (id: string, title: string) => Promise<unknown>;
    };
    await module.openRecentProject(project.id, project.title);
  }, { path: "/src/lib/local-db.ts", project });
}

async function expectContext(page: Page, state: AppState, target: TargetPage, project: SyntheticProject) {
  await expect(chooser(page, target)).toContainText(project.title);
  await expect.poll(() => state.domainProjectIds).toContain(project.id);
  if (target.name === "ai") {
    await expect.poll(() => state.assistantProjectIds).toContain(project.id);
    await expect.poll(() => state.socketProjectIds).toContain(project.id);
  }
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), target.key)).toBe(project.id);
}

interface RecentReadGate {
  settled: number;
  pending: Array<() => void>;
  release: () => void;
}

/** Delay actual Dexie success callbacks for recentProjects, using the established fixture seam. */
async function installRecentGate(page: Page) {
  await page.addInitScript(() => {
    let holding = true;
    const gate: RecentReadGate = {
      settled: 0, pending: [],
      release: () => { holding = false; gate.pending.splice(0).forEach((settle) => settle()); },
    };
    const hold = (request: IDBRequest<unknown>) => {
      let handler: ((event: Event) => void) | null = null;
      let completed = false;
      let released = false;
      const finish = () => {
        if (!released || !completed || !handler) return;
        const callback = handler;
        handler = null;
        Reflect.deleteProperty(request, "onsuccess");
        gate.settled += 1;
        callback.call(request, { target: request } as unknown as Event);
      };
      request.addEventListener("success", () => { completed = true; finish(); });
      Object.defineProperty(request, "onsuccess", {
        configurable: true, get: () => handler,
        set: (next: ((event: Event) => void) | null) => { handler = next; finish(); },
      });
      gate.pending.push(() => { released = true; finish(); });
    };
    const patch = (source: IDBObjectStore | IDBIndex, method: "getAll" | "openCursor") => {
      const original: unknown = Object.getOwnPropertyDescriptor(source, method)?.value;
      if (typeof original !== "function") return;
      Object.defineProperty(source, method, {
        configurable: true, writable: true,
        value: function (this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
          const request = Reflect.apply(original, this, args) as IDBRequest<unknown>;
          const name = this instanceof IDBIndex ? this.objectStore.name : this.name;
          if (holding && name === "recentProjects") hold(request);
          return request;
        },
      });
    };
    patch(IDBObjectStore.prototype, "getAll");
    patch(IDBObjectStore.prototype, "openCursor");
    patch(IDBIndex.prototype, "getAll");
    patch(IDBIndex.prototype, "openCursor");
    (window as unknown as { __selectionRecentGate: RecentReadGate }).__selectionRecentGate = gate;
  });
}

async function gateCount(page: Page, field: "pending" | "settled") {
  return page.evaluate((field) => {
    const gate = (window as unknown as { __selectionRecentGate: RecentReadGate }).__selectionRecentGate;
    return field === "pending" ? gate.pending.length : gate.settled;
  }, field);
}

for (const target of PAGES) {
  test.describe(`${target.name}: project selection`, () => {
    test("off-page URL is admitted only after actual metadata HTTP succeeds", async ({ page }) => {
      const state = await installApp(page, [OFF_PAGE.id]);
      await page.goto(`${target.path}?projectId=${OFF_PAGE.id}`);
      await expect.poll(state.heldIds).toContain(OFF_PAGE.id);
      expect(state.domainProjectIds).not.toContain(OFF_PAGE.id);
      const response = page.waitForResponse((reply) => new URL(reply.url()).pathname.endsWith(`/projects/${OFF_PAGE.id}`));
      state.release(OFF_PAGE.id);
      const received = await response;
      expect(received.status()).toBe(200);
      expect(await received.finished()).toBeNull();
      await waitMetadataCompletion(page, OFF_PAGE.id, 1);
      await expectContext(page, state, target, OFF_PAGE);
      await expectOption(page, target, OFF_PAGE);
      if (target.name === "ai") {
        await page.getByRole("button", { name: /Check consistency/ }).click();
        await expect(page).toHaveURL(new RegExp(`/consistency\\?projectId=${OFF_PAGE.id}$`));
        await expect(chooser(page, PAGES[0])).toContainText(OFF_PAGE.title);
      }
    });

    for (const source of ["remembered", "recent"] as const) {
      test(`off-page ${source} project is validated and displayed`, async ({ page }) => {
        const state = await installApp(page);
        if (source === "remembered") await seedStored(page, target, OFF_PAGE);
        else await seedRecent(page, OFF_PAGE);
        await page.goto(target.path);
        await expectContext(page, state, target, OFF_PAGE);
        await waitMetadataCompletion(page, OFF_PAGE.id, 1);
        expect(state.metadataRequests).toContain(OFF_PAGE.id);
        expect(state.metadataResponses).toContain(OFF_PAGE.id);
        await expectOption(page, target, OFF_PAGE);
      });
    }

    for (const middle of ["null", "invalid"] as const) {
      test(`URL A -> ${middle} -> A reapplies A after a manual selection`, async ({ page }) => {
        const state = await installApp(page);
        await page.goto(`${target.path}?projectId=${ALPHA.id}`);
        await expectContext(page, state, target, ALPHA);
        await chooseProject(page, target, BETA);
        await navigateInApp(page, target.path + (middle === "invalid" ? `?projectId=${MISSING.id}` : ""), 1);
        if (middle === "invalid") {
          await expect.poll(() => state.metadataResponses.filter((id) => id === MISSING.id).length).toBe(2);
          await waitMetadataCompletion(page, MISSING.id, 2);
        }
        await expectContext(page, state, target, BETA);
        await navigateInApp(page, `${target.path}?projectId=${ALPHA.id}`, 2);
        await expectContext(page, state, target, ALPHA);
        expect(state.domainProjectIds).not.toContain(MISSING.id);
      });
    }

    test("invalid URL and remembered id fall back to a valid project without domain requests", async ({ page }) => {
      const state = await installApp(page);
      await seedStored(page, target, MISSING);
      await page.goto(`${target.path}?projectId=${MISSING.id}`);
      await expectContext(page, state, target, ALPHA);
      await waitMetadataCompletion(page, MISSING.id, 2);
      expect(state.metadataRequests).toContain(MISSING.id);
      expect(state.domainProjectIds).not.toContain(MISSING.id);
      expect(state.socketProjectIds).not.toContain(MISSING.id);
    });

    test("a late recent-project read cannot override manual A -> B -> A", async ({ page }) => {
      const state = await installApp(page);
      await seedRecent(page, OFF_PAGE);
      await installRecentGate(page);
      await page.goto(target.path);
      await expect.poll(() => gateCount(page, "pending")).toBeGreaterThan(0);
      await chooseProject(page, target, ALPHA);
      await chooseProject(page, target, BETA);
      await chooseProject(page, target, ALPHA);
      await page.evaluate(() => {
        (window as unknown as { __selectionRecentGate: RecentReadGate }).__selectionRecentGate.release();
      });
      await expect.poll(() => gateCount(page, "settled")).toBeGreaterThan(0);
      await settleUi(page);
      await expectContext(page, state, target, ALPHA);
      expect(state.metadataRequests).not.toContain(OFF_PAGE.id);
      expect(state.domainProjectIds).not.toContain(OFF_PAGE.id);
    });

    test("a late URL metadata success cannot override manual A -> B -> A", async ({ page }) => {
      const state = await installApp(page, [OFF_PAGE.id]);
      await page.goto(`${target.path}?projectId=${ALPHA.id}`);
      await expectContext(page, state, target, ALPHA);
      await navigateInApp(page, `${target.path}?projectId=${OFF_PAGE.id}`, 1);
      await expect.poll(state.heldIds).toContain(OFF_PAGE.id);
      await chooseProject(page, target, BETA);
      await chooseProject(page, target, ALPHA);
      state.release(OFF_PAGE.id);
      await expect.poll(() => state.metadataResponses).toContain(OFF_PAGE.id);
      await waitMetadataCompletion(page, OFF_PAGE.id, 1);
      await expectOption(page, target, OFF_PAGE);
      await expectContext(page, state, target, ALPHA);
      expect(state.domainProjectIds).not.toContain(OFF_PAGE.id);
    });

    for (const withRecent of [false, true]) {
      test(`a rejected remembered id cannot continue ${withRecent ? "to the next candidate" : "to the default"} after manual ABA`, async ({ page }) => {
        const state = await installApp(page, [MISSING.id]);
        await seedStored(page, target, MISSING);
        if (withRecent) await seedRecent(page, ALPHA);
        await page.goto(target.path);
        await expect.poll(state.heldIds).toContain(MISSING.id);
        await chooseProject(page, target, BETA);
        await chooseProject(page, target, ALPHA);
        await chooseProject(page, target, BETA);
        state.release(MISSING.id);
        // Global Query retry=1: await both real 404 responses before the negative assertion.
        await expect.poll(() => state.metadataResponses.filter((id) => id === MISSING.id).length).toBe(2);
        await waitMetadataCompletion(page, MISSING.id, 2);
        await expectContext(page, state, target, BETA);
        expect(state.domainProjectIds).not.toContain(MISSING.id);
      });
    }

    test("off-page selection and metadata survive a cold document remount", async ({ page }) => {
      const state = await installApp(page);
      await page.goto(`${target.path}?projectId=${OFF_PAGE.id}`);
      await expectContext(page, state, target, OFF_PAGE);
      const previousReads = state.metadataRequests.filter((id) => id === OFF_PAGE.id).length;
      await page.goto("/projects");
      await page.goto(target.path);
      await expectContext(page, state, target, OFF_PAGE);
      await expectOption(page, target, OFF_PAGE);
      expect(state.metadataRequests.filter((id) => id === OFF_PAGE.id).length).toBeGreaterThan(previousReads);
    });
  });
}

test("consistency: same-id chooser and URL reentry preserve a completed result", async ({ page }) => {
  const target = PAGES[0];
  const state = await installApp(page);
  await page.goto(`${target.path}?projectId=${ALPHA.id}`);
  await expectContext(page, state, target, ALPHA);
  await page.getByRole("button", { name: "Run check", exact: true }).click();
  const message = page.locator(".consistency-issue__message");
  await expect(message).toHaveText(`selection-result-${ALPHA.id}`);
  await chooseProject(page, target, ALPHA);
  await navigateInApp(page, target.path, 1);
  await navigateInApp(page, `${target.path}?projectId=${ALPHA.id}`, 2);
  await expect(message).toHaveText(`selection-result-${ALPHA.id}`);
  expect(state.checks).toEqual([ALPHA.id]);
});

test("AI: same-id URL reentry preserves the preset prompt and assistant context", async ({ page }) => {
  const target = PAGES[1];
  const state = await installApp(page);
  await page.goto(`${target.path}?projectId=${ALPHA.id}`);
  await expectContext(page, state, target, ALPHA);
  await page.getByRole("button", { name: /Continue writing/ }).click();
  const composer = page.locator(".agent-composer-editor .tiptap");
  await expect(composer).toContainText("Read the current chapter and the recent plot");
  await chooseProject(page, target, ALPHA);
  await navigateInApp(page, target.path, 1);
  await navigateInApp(page, `${target.path}?projectId=${ALPHA.id}`, 2);
  await expectContext(page, state, target, ALPHA);
  await expect(composer).toContainText("Read the current chapter and the recent plot");
  expect(state.checks).toEqual([]);
});
