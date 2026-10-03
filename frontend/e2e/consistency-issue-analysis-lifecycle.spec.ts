/** Actual Consistency page / IssueCard with held synthetic analysis HTTP and native completion barriers. */
import { expect, test, type Page } from "@playwright/test";

import type {
  ConsistencyCheckResult,
  ConsistencyIssue,
  ConsistencyScope,
} from "../src/features/consistency/lib/consistency-api";

test.use({
  serviceWorkers: "block", trace: "off", video: "off", screenshot: "off",
  viewport: { width: 1440, height: 1000 },
});

const ALPHA = { id: "analysis-alpha", title: "Alpha Analysis Novel" };
const BETA = { id: "analysis-beta", title: "Beta Analysis Novel" };
const PROJECTS = [ALPHA, BETA];
const TIMESTAMP = "2026-10-03T08:00:00Z";
interface CheckPayload {
  scope: ConsistencyScope;
  chapter_id: string | null;
  volume_id: string | null;
}
interface AnalysisPayload extends CheckPayload { issue: ConsistencyIssue }
type Outcome = { kind: "success"; marker: string } | { kind: "error"; marker: string };
interface HeldRequest {
  kind: "check" | "analyze";
  projectId: string;
  clientSequence: number;
  settled: boolean;
  release: (outcome: Outcome) => void;
}
interface HeldCheck extends HeldRequest {
  kind: "check";
  payload: CheckPayload;
  result: ConsistencyCheckResult | null;
}
interface HeldAnalysis extends HeldRequest {
  kind: "analyze";
  payload: unknown;
  expectedPayload: AnalysisPayload;
}
interface TransportRecord {
  sequence: number;
  projectId: string;
  kind: "check" | "analyze";
  completed: boolean;
}
interface AppState {
  checks: HeldCheck[];
  analyses: HeldAnalysis[];
  unexpectedRequests: string[];
  unexpectedSocketEvents: string[];
  pageErrors: string[];
}
const appStates = new WeakMap<Page, AppState>();

/** Observe the native POST send/loadend; do not replace transport handlers or read response bodies. */
async function installTransportObserver(page: Page) {
  await page.addInitScript((projectIds: string[]) => {
    const records: TransportRecord[] = [];
    const syntheticIds = new Set(projectIds);
    const opened = new WeakMap<XMLHttpRequest, { projectId: string; kind: "check" | "analyze" }>();
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
        if (typeof args[0] === "string" && args[0].toUpperCase() === "POST") {
          const path = new URL(String(args[1]), window.location.href).pathname;
          const match = path.match(/^\/api\/v1\/projects\/([^/]+)\/consistency\/(check|analyze)$/);
          if (match && syntheticIds.has(match[1])) {
            opened.set(this, { projectId: match[1], kind: match[2] as "check" | "analyze" });
          }
        }
        return Reflect.apply(nativeOpen, this, args);
      },
    });
    Object.defineProperty(prototype, "send", {
      configurable: true, writable: true,
      value: function (this: XMLHttpRequest, ...args: unknown[]) {
        const request = opened.get(this);
        if (request) {
          const record: TransportRecord = { sequence: records.length + 1, ...request, completed: false };
          records.push(record);
          this.addEventListener("loadend", () => { record.completed = true; }, { once: true });
        }
        return Reflect.apply(nativeSend, this, args);
      },
    });
    (window as unknown as { __issueAnalysisTransport: TransportRecord[] }).__issueAnalysisTransport = records;
  }, PROJECTS.map((project) => project.id));
}

async function readTransport(page: Page): Promise<TransportRecord[]> {
  return page.evaluate(() => {
    const records = (window as unknown as { __issueAnalysisTransport: TransportRecord[] }).__issueAnalysisTransport;
    return records.map((record) => ({ ...record }));
  });
}

function chapterTree(projectId: string) {
  const volume = (number: number, chapters: number[]) => {
    const id = `${projectId}-volume-${number}`;
    return {
      id, project_id: projectId, title: `${projectId} Volume ${number}`, order: number,
      description: null, chapter_count: chapters.length, created_at: TIMESTAMP, updated_at: TIMESTAMP,
      chapters: chapters.map((chapter) => ({
        id: `${projectId}-chapter-${chapter}`, project_id: projectId, volume_id: id,
        title: `${projectId} Chapter ${chapter}`, order: chapter, word_count: 0,
        created_at: TIMESTAMP, updated_at: TIMESTAMP,
      })),
    };
  };
  return { volumes: [volume(1, [1, 2]), volume(2, [3])], total_chapters: 3 };
}

function resultFor(check: HeldCheck, marker: string): ConsistencyCheckResult {
  return {
    ...check.payload, label: marker, chapter_count: 1, model: "synthetic-check",
    context_source: "inventory", issues: [{
      type: "character_age", severity: "warning", message: `issue-${marker}`,
      evidence: [`evidence-one-${marker}`, `evidence-two-${marker}`],
      suggestion: `suggestion-${marker}`, sources: [{
        chapter_id: check.payload.chapter_id ?? `${check.projectId}-chapter-1`,
        chapter_order: 1, chapter_title: `source-title-${marker}`,
        excerpt: `source-excerpt-${marker}`, quote: `source-quote-${marker}`,
      }],
    }],
  };
}

function readCheckPayload(value: unknown, projectId: string): CheckPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "chapter_id,scope,volume_id") return null;
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

async function installApp(page: Page): Promise<AppState> {
  await installTransportObserver(page);
  const state: AppState = {
    checks: [], analyses: [], unexpectedRequests: [], unexpectedSocketEvents: [], pageErrors: [],
  };
  appStates.set(page, state);
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  const preferences = {
    language: "en", theme: "light", theme_preset: "default", font_family: "system-ui",
    code_font_family: "ui-monospace", base_font_size: 14, editor_font_size: 16,
  };
  const projectPayloads = PROJECTS.map((project) => ({
    ...project, description: null, word_count: 0, chapter_count: 3, cover_url: null,
    created_at: TIMESTAMP, updated_at: TIMESTAMP,
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
        mode: "off", embedding_model_configured: false, total_projects: 2, total_chapters: 6,
        indexed_count: 0, pending_count: 0, in_progress_count: 0, failed_count: 0, projects: [],
      });
      if (path === "/projects") return json({ items: projectPayloads, total: 2, page: 1, page_size: 100 });
      const project = projectPayloads.find((item) => path === `/projects/${item.id}`);
      if (project) return json(project);
      const tree = PROJECTS.find((item) => path === `/projects/${item.id}/chapters`);
      if (tree) return json(chapterTree(tree.id));
    }
    const checkProject = PROJECTS.find((item) => path === `/projects/${item.id}/consistency/check`);
    if (method === "POST" && checkProject) {
      const payload = readCheckPayload(request.postDataJSON(), checkProject.id);
      if (!payload) {
        state.unexpectedRequests.push(`invalid check payload for ${checkProject.id}`);
        return json({ detail: "Invalid synthetic check payload" }, 422);
      }
      let release: (outcome: Outcome) => void = () => { throw new Error("Check is not held"); };
      const response = new Promise<Outcome>((resolve) => { release = resolve; });
      const check: HeldCheck = {
        kind: "check", projectId: checkProject.id, payload, result: null,
        clientSequence: 0, settled: false, release,
      };
      state.checks.push(check);
      const outcome = await response;
      check.result = outcome.kind === "success" ? resultFor(check, outcome.marker) : null;
      await json(check.result ?? { detail: outcome.marker }, outcome.kind === "success" ? 200 : 500);
      check.settled = true;
      return;
    }
    const analysisProject = PROJECTS.find((item) => path === `/projects/${item.id}/consistency/analyze`);
    if (method === "POST" && analysisProject) {
      const payload: unknown = request.postDataJSON();
      const check = state.checks.filter((entry) => entry.projectId === analysisProject.id && entry.result).at(-1);
      const issue = check?.result?.issues[0];
      if (!check || !issue) {
        state.unexpectedRequests.push(`analysis without a completed check for ${analysisProject.id}`);
        return json({ detail: "No synthetic issue" }, 422);
      }
      const expectedPayload: AnalysisPayload = { ...check.payload, issue };
      // Assert the unprojected raw object, including all issue fields and sources; extra keys fail.
      try {
        expect(payload).toEqual(expectedPayload);
        expect(Object.keys(payload as object).sort()).toEqual(["chapter_id", "issue", "scope", "volume_id"]);
      } catch {
        state.unexpectedRequests.push(`invalid raw analysis payload for ${analysisProject.id}`);
        return json({ detail: "Invalid synthetic analysis payload" }, 422);
      }
      let release: (outcome: Outcome) => void = () => { throw new Error("Analysis is not held"); };
      const response = new Promise<Outcome>((resolve) => { release = resolve; });
      const analysis: HeldAnalysis = {
        kind: "analyze", projectId: analysisProject.id, payload, expectedPayload,
        clientSequence: 0, settled: false, release,
      };
      state.analyses.push(analysis);
      const outcome = await response;
      await json(outcome.kind === "success"
        ? { analysis: outcome.marker, model: `synthetic-${outcome.marker}` }
        : { detail: outcome.marker }, outcome.kind === "success" ? 200 : 500);
      analysis.settled = true;
      return;
    }
    state.unexpectedRequests.push(`${method} ${path}`);
    return json({ detail: "Unexpected synthetic request" }, 501);
  });

  const engineOpen = '0{"sid":"analysis-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
  const packets: string[] = [];
  const receive = (packet: string, send: (reply: string) => void) => {
    if (packet.startsWith("40")) { send('40{"sid":"analysis-namespace"}'); return; }
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
  expect([...state.checks, ...state.analyses].filter((request) => !request.settled)).toEqual([]);
  expect((await readTransport(page)).filter((record) => !record.completed)).toEqual([]);
});

function projectChooser(page: Page) { return page.locator(".consistency-page__header [role=combobox]").first(); }
function checkButton(page: Page) {
  return page.locator(".consistency-page__header").getByRole("button", { name: /^Run check(?: Run check)?$/ });
}
function analysisButton(page: Page) {
  // Radix makes the card aria-hidden while its dialog is open; its disabled state still belongs to this button.
  return page.locator(".consistency-issue").getByRole("button", { name: "AI analysis", exact: true, includeHidden: true });
}
function analysisDialog(page: Page) { return page.getByRole("dialog", { name: "Review this issue", exact: true }); }
function analyzingStatus(page: Page) { return page.getByText("Reviewing this issue...", { exact: true }); }

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
    window.history.pushState({ idx, key: `analysis-${idx}`, usr: null }, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, { url, idx });
  await settleUi(page);
}

async function observePending(page: Page, request: HeldRequest, clientIndex: number) {
  await expect.poll(async () => (await readTransport(page)).length).toBe(clientIndex + 1);
  const observation = (await readTransport(page))[clientIndex];
  expect(observation).toEqual({
    sequence: clientIndex + 1, projectId: request.projectId, kind: request.kind, completed: false,
  });
  request.clientSequence = observation.sequence;
  expect(request.settled).toBe(false);
}

async function expectPendingAnalysis(page: Page, analysis: HeldAnalysis) {
  await expect(analysisDialog(page)).toBeVisible();
  await expect(analyzingStatus(page)).toBeVisible();
  await expect(analysisButton(page)).toBeDisabled();
  expect(analysis.settled).toBe(false);
  expect((await readTransport(page)).find((record) => record.sequence === analysis.clientSequence)?.completed).toBe(false);
}

async function startCheck(page: Page, state: AppState, recheck = false): Promise<HeldCheck> {
  const index = state.checks.length;
  const clientIndex = (await readTransport(page)).length;
  const button = recheck ? page.getByRole("button", { name: "Re-run", exact: true }) : checkButton(page);
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => state.checks.length).toBe(index + 1);
  const check = state.checks[index];
  await observePending(page, check, clientIndex);
  await expect(page.locator(".consistency-issue")).toHaveCount(0);
  await expect(page.getByText("Analyzing, please wait...", { exact: true })).toBeVisible();
  await expect(checkButton(page)).toBeDisabled();
  return check;
}

async function startAnalysis(page: Page, state: AppState): Promise<HeldAnalysis> {
  const index = state.analyses.length;
  const clientIndex = (await readTransport(page)).length;
  await expect(analysisButton(page)).toBeEnabled();
  await analysisButton(page).click();
  await expect.poll(() => state.analyses.length).toBe(index + 1);
  const analysis = state.analyses[index];
  await observePending(page, analysis, clientIndex);
  expect(analysis.payload).toEqual(analysis.expectedPayload);
  expect(Object.keys(analysis.payload as object).sort()).toEqual(["chapter_id", "issue", "scope", "volume_id"]);
  await expectPendingAnalysis(page, analysis);
  return analysis;
}

async function settleRequest(page: Page, request: HeldRequest, outcome: Outcome) {
  const response = page.waitForResponse((reply) =>
    reply.request().method() === "POST" &&
    new URL(reply.url()).pathname.endsWith(`/projects/${request.projectId}/consistency/${request.kind}`),
  );
  request.release(outcome);
  const received = await response;
  expect(received.status()).toBe(outcome.kind === "success" ? 200 : 500);
  expect(await received.finished()).toBeNull();
  await expect.poll(() => request.settled).toBe(true);
  // ABA can repeat both URL and payload. The native send sequence identifies the exact completed request.
  await expect.poll(async () =>
    (await readTransport(page)).find((record) => record.sequence === request.clientSequence)?.completed,
  ).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
  await settleUi(page);
}

async function finishCheck(page: Page, check: HeldCheck, marker: string) {
  await settleRequest(page, check, { kind: "success", marker });
  await expect(page.locator(".consistency-issue__message")).toHaveText(`issue-${marker}`);
  await expect(checkButton(page)).toBeEnabled();
}

async function openCheckedPage(page: Page, state: AppState, scope: "chapter" | "volume" = "chapter") {
  await page.goto(`/consistency?projectId=${ALPHA.id}`);
  await expect(projectChooser(page)).toContainText(ALPHA.title);
  if (scope !== "chapter") await chooseScope(page, scope);
  const check = await startCheck(page, state);
  expect(check.payload).toEqual(scope === "volume"
    ? { scope, chapter_id: null, volume_id: `${ALPHA.id}-volume-1` }
    : { scope, chapter_id: `${ALPHA.id}-chapter-1`, volume_id: null });
  await finishCheck(page, check, `initial-${scope}`);
  return check;
}

async function closeAnalysisDialog(page: Page) {
  await expect(analysisDialog(page)).toBeVisible();
  await analysisDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(analysisDialog(page)).toHaveCount(0);
}

async function expectAnalysisResult(page: Page, marker: string) {
  await expect(analysisDialog(page)).toBeVisible();
  await expect(page.locator(".consistency-issue__analysis").getByText(marker, { exact: true })).toBeVisible();
  await expect(page.getByText(`Analysis model: synthetic-${marker}`, { exact: true })).toBeVisible();
  await expect(analyzingStatus(page)).toHaveCount(0);
  await expect(analysisButton(page)).toBeEnabled();
}

async function expectNoStalePublication(page: Page, marker: string) {
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  await expect(page.getByText(`Analysis model: synthetic-${marker}`, { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
}

async function dismissAndRestore(page: Page) {
  await closeAnalysisDialog(page);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.locator(".consistency-issue--dismissed")).toContainText("Dismissed");
  await expect(analysisDialog(page)).toHaveCount(0);
  await expect(analysisButton(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".consistency-issue--dismissed")).toHaveCount(0);
  await expect(analysisButton(page)).toBeEnabled();
}

test("current success preserves issue details, original sources, model and dismiss/restore", async ({ page }) => {
  const state = await installApp(page);
  const check = await openCheckedPage(page, state);
  const issue = check.result?.issues[0];
  expect(issue).toBeDefined();
  await expect(page.getByText("Possible issue", { exact: true })).toBeVisible();
  await expect(page.getByText("Character age", { exact: true })).toBeVisible();
  await expect(page.locator(".consistency-issue__evidence")).toContainText("evidence-one-initial-chapter");
  await expect(page.locator(".consistency-issue__evidence")).toContainText("evidence-two-initial-chapter");
  await expect(page.locator(".consistency-issue__suggestion")).toHaveText("Suggestion: suggestion-initial-chapter");
  await page.getByRole("button", { name: "View original", exact: true }).click();
  await expect(page.locator(".consistency-issue__sources")).toContainText("source-title-initial-chapter");
  await expect(page.getByText("source-excerpt-initial-chapter", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide original", exact: true }).click();
  await expect(page.locator(".consistency-issue__sources")).toHaveCount(0);
  const analysis = await startAnalysis(page, state);
  expect(analysis.payload).toEqual({ ...check.payload, issue });
  await settleRequest(page, analysis, { kind: "success", marker: "current-analysis" });
  await expectAnalysisResult(page, "current-analysis");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await dismissAndRestore(page);
  const retry = await startAnalysis(page, state);
  await settleRequest(page, retry, { kind: "success", marker: "restored-analysis" });
  await expectAnalysisResult(page, "restored-analysis");
  await expect(page.getByText("current-analysis", { exact: true })).toHaveCount(0);
});

test("a current error emits one detail toast, closes the dialog, clears busy and permits retry", async ({ page }) => {
  const state = await installApp(page);
  await openCheckedPage(page, state);
  const failed = await startAnalysis(page, state);
  await settleRequest(page, failed, { kind: "error", marker: "current-analysis-error" });
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
  await expect(page.locator("[data-sonner-toast]")).toContainText("current-analysis-error");
  await expect(analysisDialog(page)).toHaveCount(0);
  await expect(analysisButton(page)).toBeEnabled();
  const retry = await startAnalysis(page, state);
  await settleRequest(page, retry, { kind: "success", marker: "analysis-after-error" });
  await expectAnalysisResult(page, "analysis-after-error");
  expect(state.analyses).toHaveLength(2);
});

for (const outcome of ["success", "error"] as const) {
  test(`closing the dialog preserves pending analysis and current ${outcome} handling`, async ({ page }) => {
    const state = await installApp(page);
    await openCheckedPage(page, state);
    const analysis = await startAnalysis(page, state);
    await closeAnalysisDialog(page);
    await expect(analysisButton(page)).toBeDisabled();
    expect(analysis.settled).toBe(false);
    expect((await readTransport(page)).find((record) => record.sequence === analysis.clientSequence)?.completed).toBe(false);
    await settleRequest(page, analysis, { kind: outcome, marker: `closed-current-${outcome}` });
    await expect(analysisDialog(page)).toHaveCount(0);
    await expect(analysisButton(page)).toBeEnabled();
    if (outcome === "error") {
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
      await expect(page.locator("[data-sonner-toast]")).toContainText("closed-current-error");
    } else {
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    }
    const retry = await startAnalysis(page, state);
    await settleRequest(page, retry, { kind: "success", marker: `retry-after-close-${outcome}` });
    await expectAnalysisResult(page, `retry-after-close-${outcome}`);
    expect(state.analyses).toHaveLength(2);
  });
}

type Transition = "project" | "scope" | "chapter" | "volume" | "recheck";
const TRANSITIONS: Transition[] = ["project", "scope", "chapter", "volume", "recheck"];

async function changeTarget(page: Page, target: Exclude<Transition, "recheck">) {
  if (target === "project") {
    await chooseProject(page, BETA);
    return { projectId: BETA.id, payload: { scope: "chapter", chapter_id: `${BETA.id}-chapter-1`, volume_id: null } };
  }
  if (target === "scope") {
    await chooseScope(page, "book");
    return { projectId: ALPHA.id, payload: { scope: "book", chapter_id: null, volume_id: null } };
  }
  if (target === "chapter") {
    await chooseChapter(page, 3);
    return { projectId: ALPHA.id, payload: { scope: "chapter", chapter_id: `${ALPHA.id}-chapter-3`, volume_id: null } };
  }
  await chooseVolume(page, 2);
  return { projectId: ALPHA.id, payload: { scope: "volume", chapter_id: null, volume_id: `${ALPHA.id}-volume-2` } };
}

for (const target of TRANSITIONS) {
  for (const outcome of ["success", "error"] as const) {
    test(`${target}: unmounted old ${outcome} and finally cannot publish or clear current analysis busy`, async ({ page }) => {
      const state = await installApp(page);
      const initial = await openCheckedPage(page, state, target === "volume" ? "volume" : "chapter");
      const oldAnalysis = await startAnalysis(page, state);
      await closeAnalysisDialog(page);
      let currentCheck: HeldCheck;
      if (target === "recheck") {
        currentCheck = await startCheck(page, state, true);
        expect({ projectId: currentCheck.projectId, payload: currentCheck.payload }).toEqual({
          projectId: initial.projectId, payload: initial.payload,
        });
      } else {
        const expected = await changeTarget(page, target);
        await expect(page.locator(".consistency-issue")).toHaveCount(0);
        currentCheck = await startCheck(page, state);
        expect({ projectId: currentCheck.projectId, payload: currentCheck.payload }).toEqual(expected);
      }
      await finishCheck(page, currentCheck, `new-check-${target}-${outcome}`);
      const currentAnalysis = await startAnalysis(page, state);
      const marker = `stale-${target}-${outcome}`;
      await settleRequest(page, oldAnalysis, { kind: outcome, marker });
      await expectNoStalePublication(page, marker);
      await expectPendingAnalysis(page, currentAnalysis);
      await settleRequest(page, currentAnalysis, { kind: "success", marker: `current-${target}-${outcome}` });
      await expectAnalysisResult(page, `current-${target}-${outcome}`);
      expect(state.analyses).toHaveLength(2);
    });
  }
}

for (const outcome of ["success", "error"] as const) {
  test(`leaving the route retires old ${outcome} even while the global toaster remains mounted`, async ({ page }) => {
    const state = await installApp(page);
    await openCheckedPage(page, state);
    const oldAnalysis = await startAnalysis(page, state);
    await closeAnalysisDialog(page);
    await navigateInApp(page, "/projects", 1);
    await expect(page.locator(".consistency-page")).toHaveCount(0);
    await expect(analysisDialog(page)).toHaveCount(0);
    const marker = `stale-away-${outcome}`;
    await settleRequest(page, oldAnalysis, { kind: outcome, marker });
    await expectNoStalePublication(page, marker);
    await navigateInApp(page, `/consistency?projectId=${ALPHA.id}`, 2);
    const check = await startCheck(page, state);
    await finishCheck(page, check, `remounted-check-${outcome}`);
    const current = await startAnalysis(page, state);
    await settleRequest(page, current, { kind: "success", marker: `remounted-analysis-${outcome}` });
    await expectAnalysisResult(page, `remounted-analysis-${outcome}`);
    await expectNoStalePublication(page, marker);
  });

  test(`dismissed analysis retires old ${outcome} and restores an immediately usable analysis action`, async ({ page }) => {
    const state = await installApp(page);
    await openCheckedPage(page, state);
    const oldAnalysis = await startAnalysis(page, state);
    await closeAnalysisDialog(page);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.locator(".consistency-issue--dismissed")).toContainText("Dismissed");
    await expect(analysisDialog(page)).toHaveCount(0);
    const marker = `stale-dismissed-${outcome}`;
    await settleRequest(page, oldAnalysis, { kind: outcome, marker });
    await expectNoStalePublication(page, marker);
    await expect(page.locator(".consistency-issue--dismissed")).toContainText("Dismissed");
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(analysisButton(page)).toBeEnabled();
    const current = await startAnalysis(page, state);
    await settleRequest(page, current, { kind: "success", marker: `after-dismissed-${outcome}` });
    await expectAnalysisResult(page, `after-dismissed-${outcome}`);
  });

  for (const order of ["old-first", "current-first"] as const) {
    test(`dismiss/restore ABA: old ${outcome} with ${order} completion preserves current busy/result/dialog`, async ({ page }) => {
      const state = await installApp(page);
      await openCheckedPage(page, state);
      const oldAnalysis = await startAnalysis(page, state);
      await dismissAndRestore(page);
      const currentAnalysis = await startAnalysis(page, state);
      expect(currentAnalysis.payload).toEqual(oldAnalysis.payload);
      expect(currentAnalysis.clientSequence).not.toBe(oldAnalysis.clientSequence);
      const staleMarker = `stale-ABA-${outcome}-${order}`;
      const currentMarker = `current-ABA-${outcome}-${order}`;
      if (order === "old-first") {
        await settleRequest(page, oldAnalysis, { kind: outcome, marker: staleMarker });
        await expectNoStalePublication(page, staleMarker);
        await expectPendingAnalysis(page, currentAnalysis);
        await settleRequest(page, currentAnalysis, { kind: "success", marker: currentMarker });
      } else {
        await settleRequest(page, currentAnalysis, { kind: "success", marker: currentMarker });
        await expectAnalysisResult(page, currentMarker);
        expect(oldAnalysis.settled).toBe(false);
        expect((await readTransport(page)).find((record) => record.sequence === oldAnalysis.clientSequence)?.completed).toBe(false);
        await settleRequest(page, oldAnalysis, { kind: outcome, marker: staleMarker });
      }
      await expectAnalysisResult(page, currentMarker);
      await expectNoStalePublication(page, staleMarker);
      expect(state.analyses).toHaveLength(2);
    });
  }
}
