/** Real writing-page export dialog with synthetic API / Socket.IO only. */
import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";

import type { OverallIndexStatus, ProjectIndexStatus } from "../src/lib/index-status";

test.use({
  serviceWorkers: "block",
  trace: "off",
  video: "off",
  screenshot: "off",
  viewport: { width: 1440, height: 1000 },
});

const PROJECT_ID = "markdown-synthetic-project";
const JOB_ID = "markdown-synthetic-job";
const VOLUME_ONE = "markdown-volume-one";
const VOLUME_TWO = "markdown-volume-two";
const TIMESTAMP = "2026-10-03T08:00:00Z";
type Scope = "full-book" | "current-volume" | "fragments";
type Language = "en" | "zh-CN";

interface CreatePayload {
  selected_volume_ids: string[];
  included_chapter_ids: string[];
  excluded_chapter_ids: string[];
  local_date: string;
  format: string;
}

interface ScopePlan {
  volumes: string[];
  included: string[];
  excluded: string[];
  chapterIds: string[];
  mode: "volumes" | "chapters";
  label: string;
  volumeCount: number;
  words: number;
}

const PLANS: Record<Scope, ScopePlan> = {
  "full-book": {
    volumes: [VOLUME_ONE, VOLUME_TWO], included: [], excluded: [],
    chapterIds: ["md-chapter-one", "md-chapter-two", "md-chapter-three"],
    mode: "volumes", label: "全本", volumeCount: 2, words: 6,
  },
  "current-volume": {
    volumes: [VOLUME_ONE], included: [], excluded: [],
    chapterIds: ["md-chapter-one", "md-chapter-two"],
    mode: "volumes", label: "Volume One", volumeCount: 1, words: 3,
  },
  fragments: {
    volumes: [VOLUME_ONE], included: ["md-chapter-three"], excluded: ["md-chapter-two"],
    chapterIds: ["md-chapter-one", "md-chapter-three"],
    mode: "chapters", label: "2个章节", volumeCount: 2, words: 4,
  },
};

const LABELS = {
  en: {
    open: "Export chapters", format: "Export format", project: "Select the whole project",
    volume: "Select volume: Volume One", exclude: "Select chapter: Chapter Two",
    include: "Select chapter: Chapter Three", export: "Export",
    exporting: "Exporting chapters", complete: "Export complete", again: "Download again",
  },
  "zh-CN": {
    open: "导出章节", format: "导出格式", project: "选择整个项目",
    volume: "选择卷：Volume One", exclude: "选择章节：Chapter Two",
    include: "选择章节：Chapter Three", export: "导出",
    exporting: "正在导出章节", complete: "导出完成", again: "再次下载",
  },
} satisfies Record<Language, Record<string, string>>;

function chapter(id: string, volumeId: string, title: string, order: number, words: number) {
  return {
    id, project_id: PROJECT_ID, volume_id: volumeId, title, order, word_count: words,
    created_at: TIMESTAMP, updated_at: TIMESTAMP,
  };
}

const CHAPTERS = [
  chapter("md-chapter-one", VOLUME_ONE, "Chapter One", 1, 1),
  chapter("md-chapter-two", VOLUME_ONE, "Chapter Two", 2, 2),
  chapter("md-chapter-three", VOLUME_TWO, "Chapter Three", 1, 3),
];
const VOLUMES = [
  { id: VOLUME_ONE, title: "Volume One", order: 1, chapter_count: 2, chapters: CHAPTERS.slice(0, 2) },
  { id: VOLUME_TWO, title: "Volume Two", order: 2, chapter_count: 1, chapters: CHAPTERS.slice(2) },
  { id: "markdown-empty-volume", title: "Empty Volume", order: 3, chapter_count: 0, chapters: [] },
].map((volume) => ({
  ...volume, project_id: PROJECT_ID, description: null, created_at: TIMESTAMP, updated_at: TIMESTAMP,
}));
const PROJECT = {
  id: PROJECT_ID, title: "Synthetic Novel", description: "Synthetic export fixture",
  word_count: 6, chapter_count: 3, cover_url: null, created_at: TIMESTAMP, updated_at: TIMESTAMP,
};
const PROJECT_INDEX_STATUS: ProjectIndexStatus = {
  project_id: PROJECT_ID, enabled: false, status: "disabled", title: PROJECT.title,
  total_chapters: 3, indexed_count: 0, pending_count: 0, in_progress_count: 0,
  failed_count: 0, empty_content_count: 0, last_error: null, progress: 0,
};
const OVERALL_INDEX_STATUS: OverallIndexStatus = {
  mode: "off", embedding_model_configured: false, total_projects: 1, total_chapters: 3,
  indexed_count: 0, pending_count: 0, in_progress_count: 0, failed_count: 0,
  projects: [PROJECT_INDEX_STATUS],
};

interface StubState {
  created: CreatePayload[];
  statusRequests: number;
  downloadRequests: number;
  filename: string;
  socketConnected: boolean;
  unexpectedRequests: string[];
  unexpectedSocketEvents: string[];
  complete: () => void;
}

function readCreate(value: unknown): CreatePayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "selected_volume_ids", "included_chapter_ids", "excluded_chapter_ids", "local_date", "format",
  ]);
  const keys = Object.keys(raw);
  if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) return null;
  const strings = (input: unknown): input is string[] =>
    Array.isArray(input) && input.every((item: unknown) => typeof item === "string");
  if (
    !strings(raw.selected_volume_ids) || !strings(raw.included_chapter_ids) ||
    !strings(raw.excluded_chapter_ids) || typeof raw.local_date !== "string" ||
    typeof raw.format !== "string"
  ) return null;
  return {
    selected_volume_ids: raw.selected_volume_ids, included_chapter_ids: raw.included_chapter_ids,
    excluded_chapter_ids: raw.excluded_chapter_ids, local_date: raw.local_date, format: raw.format,
  };
}

async function installSyntheticApp(page: Page, language: Language, scope: Scope): Promise<StubState> {
  const plan = PLANS[scope];
  let succeeded = false;
  let socket: WebSocketRoute | null = null;
  const pollingPackets: string[] = [];
  const state: StubState = {
    created: [], statusRequests: 0, downloadRequests: 0, filename: "", socketConnected: false,
    unexpectedRequests: [], unexpectedSocketEvents: [],
    complete: () => {
      succeeded = true;
      const packet = `42${JSON.stringify(["background:event", {
        type: "background_job_succeeded", job_type: "chapter_export", job_id: JOB_ID,
        project_id: PROJECT_ID, payload: { format: "markdown" },
      }])}`;
      if (socket) socket.send(packet);
      else pollingPackets.push(packet);
    },
  };
  const preferences = {
    language, theme: "light", theme_preset: "default", font_family: "system-ui",
    code_font_family: "ui-monospace", base_font_size: 14, editor_font_size: 16,
  };
  const engineOpen = '0{"sid":"markdown-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
  const receivePacket = (packet: string, send: (reply: string) => void) => {
    if (packet.startsWith("40")) {
      state.socketConnected = true;
      send('40{"sid":"markdown-namespace"}');
      return;
    }
    if (packet === "2") { send("3"); return; }
    if (packet === "3" || packet === "41") return;
    if (!packet.startsWith("42")) {
      state.unexpectedSocketEvents.push(packet);
      return;
    }
    const values = JSON.parse(packet.slice(2)) as unknown;
    if (!Array.isArray(values)) { state.unexpectedSocketEvents.push(packet); return; }
    const event: unknown = values[0];
    if (event === "background:leave") return;
    if (event === "background:join") {
      send(`42${JSON.stringify(["background:joined", { project_id: PROJECT_ID }])}`);
      send(`42${JSON.stringify(["background:snapshot", {
        project_id: PROJECT_ID, project_revision: 1, summary: { statuses: [], maintenance: {} },
      }])}`);
      return;
    }
    state.unexpectedSocketEvents.push(String(event));
  };
  await page.routeWebSocket(/\/socket\.io\//, (route) => {
    socket = route;
    let answered = false;
    route.onMessage((message) => {
      answered = true;
      receivePacket(typeof message === "string" ? message : message.toString(), (reply) => route.send(reply));
    });
    route.send(engineOpen);
    setTimeout(() => { if (!answered) { try { route.send(engineOpen); } catch { /* Closed page. */ } } }, 300);
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
    await route.fulfill({ status: 200, contentType: "text/plain", body: pollingPackets.splice(0).join("\x1e") || "2" });
  });
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
      if (path === "/retrieval/index/status") return json(OVERALL_INDEX_STATUS);
      if (path === `/projects/${PROJECT_ID}/retrieval/index/status`) return json(PROJECT_INDEX_STATUS);
      if (path === "/models") return json([]);
      if (path === "/model-providers") return json([]);
      if (path === "/agent-definitions") return json({ definitions: [] });
      if (path === "/projects") return json({ items: [PROJECT], total: 1, page: 1, page_size: 20 });
      if (path === `/projects/${PROJECT_ID}`) return json(PROJECT);
      if (path === `/projects/${PROJECT_ID}/chapters`) return json({ volumes: VOLUMES, total_chapters: 3 });
      if (path === `/projects/${PROJECT_ID}/notes`) return json({ categories: [], root_notes: [], total_notes: 0 });
      if (path === `/projects/${PROJECT_ID}/tasks`) return json({ items: [], total: 0 });
      if (path === `/projects/${PROJECT_ID}/chapter-meta`) return json({ items: [], total: 0 });
      if (path === `/projects/${PROJECT_ID}/story-memory/status`) return json({
        project_id: PROJECT_ID, embedding_configured: false, index_status: "not_created",
        last_error: null, last_ready_at: null, rebuild_job_status: null,
        counts: { chapters: 3, characters: 0, world_entries: 0, outlines: 0, notes: 0 },
      });
      const selectedChapter = CHAPTERS.find((item) => path === `/chapters/${item.id}`);
      if (selectedChapter) return json({ ...selectedChapter, content: "Synthetic **Markdown** body" });
    }
    if (method === "POST" && path === `/projects/${PROJECT_ID}/chapter-exports`) {
      const raw: unknown = request.postDataJSON();
      const payload = readCreate(raw);
      if (!payload) {
        state.unexpectedRequests.push("invalid export create payload");
        return json({ detail: "Invalid synthetic payload" }, 422);
      }
      state.created.push(payload);
      state.filename = `Synthetic Novel-${plan.label}-${payload.local_date}.md`;
      return json(exportResponse(), 201);
    }
    if (method === "GET" && path === `/projects/${PROJECT_ID}/chapter-exports/${JOB_ID}`) {
      state.statusRequests += 1;
      return json(exportResponse());
    }
    if (method === "GET" && path === `/projects/${PROJECT_ID}/chapter-exports/${JOB_ID}/download`) {
      state.downloadRequests += 1;
      if (!succeeded) return json({ detail: "Export is pending" }, 409);
      return route.fulfill({
        status: 200, contentType: "text/markdown; charset=utf-8",
        headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(state.filename)}` },
        body: "# Synthetic export\n\n**Markdown body**\n",
      });
    }
    state.unexpectedRequests.push(`${method} ${path}`);
    return json({ detail: "Unexpected synthetic request" }, 501);
  });
  function exportResponse() {
    return {
      id: JOB_ID, status: succeeded ? "succeeded" : "pending", filename: state.filename,
      mode: plan.mode, format: "markdown", volume_count: plan.volumeCount,
      chapter_count: plan.chapterIds.length, word_count: plan.words, chapter_ids: plan.chapterIds,
      current: succeeded ? plan.chapterIds.length : 0, total: plan.chapterIds.length,
      stage: "writing", chapter_title: null, error_message: null,
      expires_at: succeeded ? "2999-01-01T00:00:00Z" : null,
      download_url: succeeded ? `/api/v1/projects/${PROJECT_ID}/chapter-exports/${JOB_ID}/download` : null,
    };
  }
  return state;
}

async function mappedExport(page: Page) {
  return page.evaluate(async ({ modulePath, projectId, jobId }) => {
    const api = await import(modulePath) as {
      fetchChapterExport: (projectId: string, jobId: string) => Promise<{
        format: string; filename: string; downloadUrl: string | null;
      }>;
    };
    return api.fetchChapterExport(projectId, jobId);
  }, { modulePath: "/src/lib/api-client.ts", projectId: PROJECT_ID, jobId: JOB_ID });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const scope of ["full-book", "current-volume", "fragments"] as const) {
    test(`${language}: Markdown ${scope} uses the writing dialog, actual mapper and downloads`, async ({ page }) => {
      const state = await installSyntheticApp(page, language, scope);
      const labels = LABELS[language];
      const plan = PLANS[scope];
      await page.goto(`/projects/${PROJECT_ID}`);
      const exportEntry = page.locator("button").filter({ has: page.locator("svg.lucide-download") }).first();
      await expect(exportEntry).toBeVisible();
      await exportEntry.hover();
      await expect(page.getByRole("tooltip").filter({ hasText: labels.open })).toBeVisible();
      await exportEntry.click();
      const dialog = page.getByRole("dialog", { name: labels.open });
      await expect(dialog).toBeVisible();
      const formats = dialog.getByLabel(labels.format);
      await expect(formats.locator(".rt-SegmentedControlItem").filter({ hasText: "TXT" })).toHaveAttribute("data-state", "on");
      const markdown = formats.locator(".rt-SegmentedControlItem").filter({ hasText: "Markdown" });
      await expect(markdown).toBeVisible();
      await markdown.click();
      await expect(markdown).toHaveAttribute("data-state", "on");
      await expect(dialog.getByRole("checkbox", { name: /Empty Volume/ })).toHaveCount(0);
      if (scope === "full-book") {
        await dialog.getByRole("checkbox", { name: labels.project, exact: true }).click();
      } else {
        await dialog.getByRole("checkbox", { name: labels.volume, exact: true }).click();
        if (scope === "fragments") {
          await dialog.getByRole("checkbox", { name: labels.exclude, exact: true }).click();
          await dialog.getByRole("checkbox", { name: labels.include, exact: true }).click();
        }
      }
      await dialog.getByRole("button", { name: labels.export, exact: true }).click();
      await expect(dialog.getByText(labels.exporting, { exact: true })).toBeVisible();
      await expect.poll(() => state.statusRequests).toBeGreaterThan(0);
      expect(state.created).toHaveLength(1);
      expect(state.created[0]).toEqual({
        selected_volume_ids: plan.volumes, included_chapter_ids: plan.included,
        excluded_chapter_ids: plan.excluded, local_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        format: "markdown",
      });
      const pending = await mappedExport(page);
      expect(pending.format).toBe("markdown");
      expect(pending.downloadUrl).toBeNull();
      await expect.poll(() => state.socketConnected).toBe(true);
      const firstDownload = page.waitForEvent("download");
      state.complete();
      const downloaded = await firstDownload;
      expect(downloaded.suggestedFilename()).toBe(state.filename);
      expect(await downloaded.failure()).toBeNull();
      await expect(dialog.getByText(labels.complete, { exact: true })).toBeVisible();
      await expect(dialog.locator(".chapter-export-file-name")).toHaveText(state.filename);
      expect(state.filename).toMatch(/\.md$/);
      const completed = await mappedExport(page);
      expect(completed.format).toBe("markdown");
      expect(completed.filename).toBe(state.filename);
      expect(completed.downloadUrl).toContain(`/chapter-exports/${JOB_ID}/download`);
      const secondDownload = page.waitForEvent("download");
      await dialog.getByRole("button", { name: labels.again, exact: true }).click();
      expect((await secondDownload).suggestedFilename()).toBe(state.filename);
      expect(state.downloadRequests).toBe(2);
      expect(state.unexpectedRequests).toEqual([]);
      expect(state.unexpectedSocketEvents).toEqual([]);
    });
  }
}
