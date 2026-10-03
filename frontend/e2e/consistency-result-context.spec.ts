/** Actual selectors / check buttons with controlled synthetic HTTP responses. */
import { expect, test, type Page } from "@playwright/test";

import type {
  ConsistencyCheckResult,
  ConsistencyScope,
} from "../src/features/consistency/lib/consistency-api";

test.use({
  serviceWorkers: "block", trace: "off", video: "off", screenshot: "off",
  viewport: { width: 1440, height: 1000 },
});

const ALPHA = { id: "context-alpha", title: "Alpha Context Novel" };
const BETA = { id: "context-beta", title: "Beta Context Novel" };
const EMPTY = { id: "context-empty", title: "Empty Context Novel" };
const PROJECTS = [ALPHA, BETA, EMPTY];
const TIMESTAMP = "2026-10-03T08:00:00Z";
interface CheckPayload {
  scope: ConsistencyScope;
  chapter_id: string | null;
  volume_id: string | null;
}
type Outcome = { kind: "success"; marker: string } | { kind: "error"; marker: string };
interface HeldCheck {
  projectId: string;
  payload: CheckPayload;
  clientSequence: number;
  settled: boolean;
  release: (outcome: Outcome) => void;
}
interface CheckTransportRecord {
  sequence: number;
  projectId: string;
  completed: boolean;
}
interface AppState {
  checks: HeldCheck[];
  analyses: Array<{ projectId: string; payload: unknown }>;
  treeRequests: string[];
  treeResponses: string[];
  unexpectedRequests: string[];
  unexpectedSocketEvents: string[];
  pageErrors: string[];
  releaseTree: () => void;
  moveFirstChapter: () => void;
}
const appStates = new WeakMap<Page, AppState>();

/** Observe native check POST and chapter-tree GET completion without reading bodies or replacing handlers. */
async function installCheckTransportObserver(page: Page) {
  await page.addInitScript((projectIds: string[]) => {
    const records: CheckTransportRecord[] = [];
    const treeRecords: CheckTransportRecord[] = [];
    const syntheticIds = new Set(projectIds);
    const opened = new WeakMap<XMLHttpRequest, { projectId: string; kind: "check" | "tree" }>();
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
        if (typeof args[0] === "string") {
          const method = args[0].toUpperCase();
          const path = new URL(String(args[1]), window.location.href).pathname;
          const check = method === "POST" ? path.match(/^\/api\/v1\/projects\/([^/]+)\/consistency\/check$/) : null;
          const tree = method === "GET" ? path.match(/^\/api\/v1\/projects\/([^/]+)\/chapters$/) : null;
          const match = check ?? tree;
          if (match && syntheticIds.has(match[1])) opened.set(this, { projectId: match[1], kind: check ? "check" : "tree" });
        }
        return Reflect.apply(nativeOpen, this, args);
      },
    });
    Object.defineProperty(prototype, "send", {
      configurable: true, writable: true,
      value: function (this: XMLHttpRequest, ...args: unknown[]) {
        const request = opened.get(this);
        if (request) {
          const target = request.kind === "check" ? records : treeRecords;
          const record: CheckTransportRecord = { sequence: target.length + 1, projectId: request.projectId, completed: false };
          target.push(record);
          this.addEventListener("loadend", () => { record.completed = true; }, { once: true });
        }
        return Reflect.apply(nativeSend, this, args);
      },
    });
    (window as unknown as { __consistencyCheckTransport: CheckTransportRecord[] }).__consistencyCheckTransport = records;
    (window as unknown as { __consistencyTreeTransport: CheckTransportRecord[] }).__consistencyTreeTransport = treeRecords;
  }, PROJECTS.map((project) => project.id));
}

async function readCheckTransport(page: Page): Promise<CheckTransportRecord[]> {
  return page.evaluate(() => {
    const records = (window as unknown as { __consistencyCheckTransport: CheckTransportRecord[] }).__consistencyCheckTransport;
    return records.map((record) => ({ ...record }));
  });
}

async function readTreeTransport(page: Page): Promise<CheckTransportRecord[]> {
  return page.evaluate(() => {
    const records = (window as unknown as { __consistencyTreeTransport: CheckTransportRecord[] }).__consistencyTreeTransport;
    return records.map((record) => ({ ...record }));
  });
}

async function waitTreeCompletion(page: Page, projectId: string, afterSequence = 0) {
  await expect.poll(async () => (await readTreeTransport(page)).some((record) =>
    record.projectId === projectId && record.sequence > afterSequence && record.completed,
  )).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
  await settleUi(page);
}

function chapterTree(projectId: string, moved = false) {
  const makeChapter = (number: number, volumeId: string) => ({
    id: `${projectId}-chapter-${number}`, project_id: projectId, volume_id: volumeId,
    title: `${projectId} Chapter ${number}`, order: number, word_count: 0,
    created_at: TIMESTAMP, updated_at: TIMESTAMP,
  });
  const volume = (number: number, chapterNumbers: number[]) => {
    const id = `${projectId}-volume-${number}`;
    return {
      id, project_id: projectId, title: `${projectId} Volume ${number}`, order: number,
      description: null, chapter_count: chapterNumbers.length,
      chapters: chapterNumbers.map((number) => makeChapter(number, id)),
      created_at: TIMESTAMP, updated_at: TIMESTAMP,
    };
  };
  return {
    volumes: projectId === EMPTY.id ? [volume(1, [])] : [
      volume(1, moved ? [2] : [1, 2]), volume(2, moved ? [1, 3] : [3]),
    ],
    total_chapters: projectId === EMPTY.id ? 0 : 3,
  };
}

function resultFor(check: HeldCheck, marker: string): ConsistencyCheckResult {
  return {
    ...check.payload, label: marker, chapter_count: 1, model: "synthetic",
    context_source: "inventory", issues: [{
      type: "general", severity: "info", message: marker, evidence: ["Synthetic evidence"],
      suggestion: "Synthetic suggestion", sources: check.projectId === EMPTY.id ? [] : [{
        chapter_id: check.payload.chapter_id ?? `${check.projectId}-chapter-1`,
        chapter_order: 1, chapter_title: "Synthetic chapter", excerpt: "Synthetic excerpt", quote: "Synthetic quote",
      }],
    }],
  };
}

function readPayload(value: unknown, projectId: string): CheckPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "chapter_id,scope,volume_id") return null;
  const tree = chapterTree(projectId);
  if (raw.scope === "book" && raw.chapter_id === null && raw.volume_id === null) {
    return { scope: "book", chapter_id: null, volume_id: null };
  }
  if (
    raw.scope === "chapter" && raw.volume_id === null && typeof raw.chapter_id === "string" &&
    tree.volumes.some((volume) => volume.chapters.some((chapter) => chapter.id === raw.chapter_id))
  ) return { scope: "chapter", chapter_id: raw.chapter_id, volume_id: null };
  if (
    raw.scope === "volume" && raw.chapter_id === null && typeof raw.volume_id === "string" &&
    tree.volumes.some((volume) => volume.id === raw.volume_id)
  ) return { scope: "volume", chapter_id: null, volume_id: raw.volume_id };
  return null;
}

async function installApp(page: Page, holdTree = false): Promise<AppState> {
  await installCheckTransportObserver(page);
  let treeHeld = holdTree;
  let moved = false;
  const treeWaiters: Array<() => void> = [];
  const state: AppState = {
    checks: [], analyses: [], treeRequests: [], treeResponses: [],
    unexpectedRequests: [], unexpectedSocketEvents: [], pageErrors: [],
    releaseTree: () => { treeHeld = false; treeWaiters.splice(0).forEach((resolve) => resolve()); },
    moveFirstChapter: () => { moved = true; },
  };
  appStates.set(page, state);
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  const preferences = {
    language: "en", theme: "light", theme_preset: "default", font_family: "system-ui",
    code_font_family: "ui-monospace", base_font_size: 14, editor_font_size: 16,
  };
  const projectPayloads = PROJECTS.map((project) => ({
    ...project, description: null, word_count: 0, chapter_count: project.id === EMPTY.id ? 0 : 3,
    cover_url: null, created_at: TIMESTAMP, updated_at: TIMESTAMP,
  }));
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
        mode: "off", embedding_model_configured: false, total_projects: 3, total_chapters: 6,
        indexed_count: 0, pending_count: 0, in_progress_count: 0, failed_count: 0, projects: [],
      });
      if (path === "/projects") return json({ items: projectPayloads, total: 3, page: 1, page_size: 100 });
      const project = projectPayloads.find((item) => path === `/projects/${item.id}`);
      if (project) return json(project);
      const tree = PROJECTS.find((item) => path === `/projects/${item.id}/chapters`);
      if (tree) {
        state.treeRequests.push(tree.id);
        if (treeHeld) await new Promise<void>((resolve) => treeWaiters.push(resolve));
        await json(chapterTree(tree.id, moved));
        state.treeResponses.push(tree.id);
        return;
      }
    }
    const checkProject = PROJECTS.find((item) => path === `/projects/${item.id}/consistency/check`);
    if (method === "POST" && checkProject) {
      const payload = readPayload(request.postDataJSON(), checkProject.id);
      if (!payload) {
        state.unexpectedRequests.push(`invalid check payload for ${checkProject.id}`);
        return json({ detail: "Invalid synthetic payload" }, 422);
      }
      let release: (outcome: Outcome) => void = () => { throw new Error("Check is not held"); };
      const response = new Promise<Outcome>((resolve) => { release = resolve; });
      const check: HeldCheck = { projectId: checkProject.id, payload, clientSequence: 0, settled: false, release };
      state.checks.push(check);
      const outcome = await response;
      await json(outcome.kind === "success" ? resultFor(check, outcome.marker) : { detail: outcome.marker }, outcome.kind === "success" ? 200 : 500);
      check.settled = true;
      return;
    }
    const analysisProject = PROJECTS.find((item) => path === `/projects/${item.id}/consistency/analyze`);
    if (method === "POST" && analysisProject) {
      const payload: unknown = request.postDataJSON();
      state.analyses.push({ projectId: analysisProject.id, payload });
      return json({ model: "synthetic", analysis: "Synthetic current-context analysis" });
    }
    state.unexpectedRequests.push(`${method} ${path}`);
    return json({ detail: "Unexpected synthetic request" }, 501);
  });

  const engineOpen = '0{"sid":"context-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
  const packets: string[] = [];
  const receive = (packet: string, send: (reply: string) => void) => {
    if (packet.startsWith("40")) { send('40{"sid":"context-namespace"}'); return; }
    if (packet === "2") { send("3"); return; }
    if (packet === "3" || packet === "41") return;
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

function projectChooser(page: Page) { return page.locator(".consistency-page__header [role=combobox]").first(); }
function checkButton(page: Page) {
  // Observed Radix loading state repeats the label in the accessible name.
  return page.locator(".consistency-page__header").getByRole("button", {
    name: /^Run check(?: Run check)?$/,
  });
}
function checkingStatus(page: Page) { return page.getByText("Analyzing, please wait...", { exact: true }); }

async function chooseProject(page: Page, project: (typeof PROJECTS)[number]) {
  await projectChooser(page).click();
  await page.getByRole("option", { name: project.title, exact: true }).click();
  await expect(projectChooser(page)).toContainText(project.title);
}

async function chooseScope(page: Page, scope: ConsistencyScope) {
  const names = { chapter: "Current chapter", volume: "Current volume", book: "Whole book" };
  await page.getByRole("combobox", { name: "Check scope", exact: true }).click();
  await page.getByRole("option", { name: names[scope], exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Check scope", exact: true })).toContainText(names[scope]);
}

async function chooseChapter(page: Page, number: number) {
  await page.getByRole("combobox", { name: "Current chapter", exact: true }).click();
  await page.getByRole("option", { name: `${ALPHA.id} Chapter ${number}`, exact: true }).click();
}

async function chooseVolume(page: Page, number: number) {
  await page.getByRole("combobox", { name: "Current volume", exact: true }).click();
  await page.getByRole("option", { name: `${ALPHA.id} Volume ${number}`, exact: true }).click();
}

async function navigateInApp(page: Page, url: string, idx: number) {
  await page.evaluate(({ url, idx }) => {
    window.history.pushState({ idx, key: `context-${idx}`, usr: null }, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, { url, idx });
  await settleUi(page);
}

async function startCheck(page: Page, state: AppState): Promise<HeldCheck> {
  const index = state.checks.length;
  const clientIndex = (await readCheckTransport(page)).length;
  await expect(checkButton(page)).toHaveCount(1);
  await expect(checkButton(page)).toBeEnabled();
  await checkButton(page).click();
  await expect.poll(() => state.checks.length).toBe(index + 1);
  await expect.poll(async () => (await readCheckTransport(page)).length).toBe(clientIndex + 1);
  const observation = (await readCheckTransport(page))[clientIndex];
  expect(observation).toEqual({ sequence: clientIndex + 1, projectId: state.checks[index].projectId, completed: false });
  state.checks[index].clientSequence = observation.sequence;
  await expect(checkingStatus(page)).toBeVisible();
  await expect(checkButton(page)).toHaveCount(1);
  await expect(checkButton(page)).toBeDisabled();
  expect(state.checks[index].settled).toBe(false);
  return state.checks[index];
}

async function settleCheck(page: Page, check: HeldCheck, outcome: Outcome) {
  const response = page.waitForResponse((reply) =>
    reply.request().method() === "POST" && new URL(reply.url()).pathname.endsWith(`/projects/${check.projectId}/consistency/check`),
  );
  check.release(outcome);
  const received = await response;
  expect(received.status()).toBe(outcome.kind === "success" ? 200 : 500);
  expect(await received.finished()).toBeNull();
  await expect.poll(() => check.settled).toBe(true);
  // Sequence distinguishes old/current requests even when ABA restores the identical URL.
  await expect.poll(async () =>
    (await readCheckTransport(page)).find((record) => record.sequence === check.clientSequence)?.completed,
  ).toBe(true);
  // Axios has received loadend; drain its real Promise continuation before the render barrier.
  await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
  await settleUi(page);
}

async function expectCurrentResult(page: Page, state: AppState, check: HeldCheck, marker: string) {
  await settleCheck(page, check, { kind: "success", marker });
  await expect(page.locator(".consistency-issue__message")).toHaveText(marker);
  await expect(checkingStatus(page)).toBeHidden();
  await expect(checkButton(page)).toBeEnabled();
  await page.getByRole("button", { name: "AI analysis", exact: true }).click();
  await expect(page.getByText("Synthetic current-context analysis", { exact: true })).toBeVisible();
  expect(state.analyses.at(-1)).toEqual({
    projectId: check.projectId,
    payload: { ...check.payload, issue: resultFor(check, marker).issues[0] },
  });
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

/** Visible defaults and a real volume-check payload prove the completed GET reached page state. */
async function expectConsumedTree(page: Page, state: AppState, volumeNumber = 1) {
  await chooseScope(page, "chapter");
  await expect(page.getByRole("combobox", { name: "Current chapter", exact: true })).toContainText(`${ALPHA.id} Chapter 1`);
  await chooseScope(page, "volume");
  await expect(page.getByRole("combobox", { name: "Current volume", exact: true })).toContainText(`${ALPHA.id} Volume ${volumeNumber}`);
  const volumeCheck = await startCheck(page, state);
  expect(volumeCheck.payload).toEqual({ scope: "volume", chapter_id: null, volume_id: `${ALPHA.id}-volume-${volumeNumber}` });
  await expectCurrentResult(page, state, volumeCheck, `consumed-tree-volume-${volumeNumber}`);
}

type Transition = "project" | "scope" | "chapter" | "volume" | "project-ABA" | "scope-ABA" | "chapter-ABA" | "volume-ABA";
const TRANSITIONS: Transition[] = ["project", "scope", "chapter", "volume", "project-ABA", "scope-ABA", "chapter-ABA", "volume-ABA"];

async function transition(page: Page, target: Transition): Promise<{ projectId: string; payload: CheckPayload }> {
  const returning = target.endsWith("-ABA");
  if (target.startsWith("project")) {
    await chooseProject(page, BETA);
    if (returning) await chooseProject(page, ALPHA);
    const id = returning ? ALPHA.id : BETA.id;
    return { projectId: id, payload: { scope: "chapter", chapter_id: `${id}-chapter-1`, volume_id: null } };
  }
  if (target.startsWith("scope")) {
    await chooseScope(page, "book");
    if (returning) await chooseScope(page, "chapter");
    return { projectId: ALPHA.id, payload: {
      scope: returning ? "chapter" : "book", chapter_id: returning ? `${ALPHA.id}-chapter-1` : null, volume_id: null,
    } };
  }
  if (target.startsWith("chapter")) {
    await chooseChapter(page, 3);
    if (returning) await chooseChapter(page, 1);
    return { projectId: ALPHA.id, payload: { scope: "chapter", chapter_id: `${ALPHA.id}-chapter-${returning ? 1 : 3}`, volume_id: null } };
  }
  await chooseVolume(page, 2);
  if (returning) await chooseVolume(page, 1);
  return { projectId: ALPHA.id, payload: { scope: "volume", chapter_id: null, volume_id: `${ALPHA.id}-volume-${returning ? 1 : 2}` } };
}

for (const target of TRANSITIONS) {
  for (const outcome of ["success", "error"] as const) {
    test(`${target}: old ${outcome} and finally cannot alter a newer pending check`, async ({ page }) => {
      const state = await installApp(page);
      await page.goto(`/consistency?projectId=${ALPHA.id}`);
      await expect(projectChooser(page)).toContainText(ALPHA.title);
      if (target.startsWith("volume")) await chooseScope(page, "volume");
      const oldCheck = await startCheck(page, state);
      expect(oldCheck.payload).toEqual(target.startsWith("volume")
        ? { scope: "volume", chapter_id: null, volume_id: `${ALPHA.id}-volume-1` }
        : { scope: "chapter", chapter_id: `${ALPHA.id}-chapter-1`, volume_id: null });
      const expected = await transition(page, target);
      await expect(checkingStatus(page)).toBeHidden();
      const currentCheck = await startCheck(page, state);
      expect({ projectId: currentCheck.projectId, payload: currentCheck.payload }).toEqual(expected);
      const staleMarker = `stale-${target}-${outcome}`;
      await settleCheck(page, oldCheck, { kind: outcome, marker: staleMarker });
      await expect(page.getByText(staleMarker, { exact: true })).toHaveCount(0);
      await expect(page.locator(".consistency-issue")).toHaveCount(0);
      await expect(checkingStatus(page)).toBeVisible();
      await expect(checkButton(page)).toBeDisabled();
      expect(currentCheck.settled).toBe(false);
      await expectCurrentResult(page, state, currentCheck, `current-${target}-${outcome}`);
      expect(state.checks).toHaveLength(2);
    });
  }
}

test("a current error is visible, clears busy and permits a successful retry", async ({ page }) => {
  const state = await installApp(page);
  await page.goto(`/consistency?projectId=${ALPHA.id}`);
  const failed = await startCheck(page, state);
  await settleCheck(page, failed, { kind: "error", marker: "synthetic-current-error" });
  await expect(page.getByText("synthetic-current-error", { exact: true })).toBeVisible();
  await expect(checkingStatus(page)).toBeHidden();
  await expect(checkButton(page)).toBeEnabled();
  const retry = await startCheck(page, state);
  await expectCurrentResult(page, state, retry, "synthetic-retry-result");
});

for (const target of ["project", "scope", "chapter", "volume"] as const) {
  test(`${target}: a completed result disappears when the effective target changes`, async ({ page }) => {
    const state = await installApp(page);
    await page.goto(`/consistency?projectId=${ALPHA.id}`);
    if (target === "volume") await chooseScope(page, "volume");
    const check = await startCheck(page, state);
    await expectCurrentResult(page, state, check, `completed-${target}`);
    await transition(page, target);
    await expect(page.locator(".consistency-issue")).toHaveCount(0);
    await expect(page.getByText("Select a chapter, then run the check.", { exact: true })).toBeVisible();
    await expect(checkButton(page)).toBeEnabled();
    expect(state.checks).toHaveLength(1);
  });
}

test("a whole-book request survives late chapter and volume defaults", async ({ page }) => {
  const state = await installApp(page, true);
  await page.goto(`/consistency?projectId=${ALPHA.id}`);
  await expect.poll(() => state.treeRequests).toContain(ALPHA.id);
  expect(state.treeResponses).toEqual([]);
  await chooseScope(page, "book");
  const check = await startCheck(page, state);
  expect(check.payload).toEqual({ scope: "book", chapter_id: null, volume_id: null });
  state.releaseTree();
  await expect.poll(() => state.treeResponses).toContain(ALPHA.id);
  await waitTreeCompletion(page, ALPHA.id);
  await expect(checkingStatus(page)).toBeVisible();
  await expect(checkButton(page)).toBeDisabled();
  await expectCurrentResult(page, state, check, "whole-book-defaults-preserved");
  await expectConsumedTree(page, state);
});

test("a whole-book completed result survives late chapter and volume defaults", async ({ page }) => {
  const state = await installApp(page, true);
  await page.goto(`/consistency?projectId=${ALPHA.id}`);
  await expect.poll(() => state.treeRequests).toContain(ALPHA.id);
  await chooseScope(page, "book");
  const check = await startCheck(page, state);
  await expectCurrentResult(page, state, check, "whole-book-result-preserved");
  state.releaseTree();
  await expect.poll(() => state.treeResponses).toContain(ALPHA.id);
  await waitTreeCompletion(page, ALPHA.id);
  await expect(page.locator(".consistency-issue__message")).toHaveText("whole-book-result-preserved");
  expect(state.checks).toHaveLength(1);
  await expectConsumedTree(page, state);
});

test("a chapter request ignores an updated containing volume for the same chapter", async ({ page }) => {
  await page.clock.install();
  const state = await installApp(page);
  await page.goto(`/consistency?projectId=${ALPHA.id}`);
  const check = await startCheck(page, state);
  const previousReads = state.treeResponses.length;
  const previousSequence = (await readTreeTransport(page)).at(-1)?.sequence ?? 0;
  state.moveFirstChapter();
  await page.clock.fastForward(61_000);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
  await expect.poll(() => state.treeResponses.length).toBeGreaterThan(previousReads);
  await waitTreeCompletion(page, ALPHA.id, previousSequence);
  await expect(checkingStatus(page)).toBeVisible();
  await expect(checkButton(page)).toBeDisabled();
  await expectCurrentResult(page, state, check, "chapter-volume-metadata-preserved");
  await expectConsumedTree(page, state, 2);
});

test("URL navigation to an empty volume cannot reuse the previous project's tree", async ({ page }) => {
  const state = await installApp(page);
  await page.goto(`/consistency?projectId=${ALPHA.id}`);
  await expect(projectChooser(page)).toContainText(ALPHA.title);
  await chooseScope(page, "volume");
  const oldCheck = await startCheck(page, state);
  await navigateInApp(page, `/consistency?projectId=${EMPTY.id}`, 1);
  await expect(projectChooser(page)).toContainText(EMPTY.title);
  await expect(page.getByRole("combobox", { name: "Current volume", exact: true })).toContainText(`${EMPTY.id} Volume 1`);
  const current = await startCheck(page, state);
  expect(current.projectId).toBe(EMPTY.id);
  expect(current.payload).toEqual({ scope: "volume", chapter_id: null, volume_id: `${EMPTY.id}-volume-1` });
  await settleCheck(page, oldCheck, { kind: "success", marker: "old-project-volume" });
  await expect(page.getByText("old-project-volume", { exact: true })).toHaveCount(0);
  await expect(checkingStatus(page)).toBeVisible();
  await expect(checkButton(page)).toBeDisabled();
  await expectCurrentResult(page, state, current, "empty-volume-current-result");
});

for (const outcome of ["success", "error"] as const) {
  test(`unmounted ${outcome} cannot write into a remounted page or emit an error`, async ({ page }) => {
    const state = await installApp(page);
    await page.goto(`/consistency?projectId=${ALPHA.id}`);
    const oldCheck = await startCheck(page, state);
    await navigateInApp(page, "/projects", 1);
    await expect(page.locator(".consistency-page")).toHaveCount(0);
    await navigateInApp(page, `/consistency?projectId=${ALPHA.id}`, 2);
    const current = await startCheck(page, state);
    const marker = `unmounted-${outcome}`;
    await settleCheck(page, oldCheck, { kind: outcome, marker });
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
    await expect(checkingStatus(page)).toBeVisible();
    await expect(checkButton(page)).toBeDisabled();
    await expectCurrentResult(page, state, current, `remounted-current-${outcome}`);
  });
}
